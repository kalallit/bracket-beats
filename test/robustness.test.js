const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./helpers/vscode');
const { fakeSpotify, json, empty, storedTokens, track } = require('./helpers/spotify');

const { SpotifyAuth } = require('../out/auth');
const { SpotifyClient, SpotifyError } = require('../out/spotify');
const { Store } = require('../out/store');
const { Player } = require('../out/player');

let api, tmp;
beforeEach(() => {
  V.reset();
  V.settings.clientId = '0123456789abcdef0123456789abcdef';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spn-'));
});
afterEach(() => { api?.restore(); api = undefined; fs.rmSync(tmp, { recursive: true, force: true }); });

const expired = () => storedTokens({ expiresAt: Date.now() - 1000 });
const tokenOk = (n = 1) => json({ access_token: `NEW${n}`, refresh_token: `RT${n}`, expires_in: 3600 });

// ---------- tokens ----------

test('duas renovações em simultâneo fazem um só pedido', async () => {
  const shared = new Map([['bracketBeats.tokens', expired()]]);
  const auth = new SpotifyAuth(V.secretStorage(shared));
  api = fakeSpotify([['POST', /accounts\.spotify\.com\/api\/token/, async () => { await new Promise((r) => setTimeout(r, 20)); return tokenOk(); }]]);
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, 'NEW1'); assert.equal(b, 'NEW1');
  assert.equal(api.calls.length, 1);
});

test('erro temporário do Spotify ao renovar NÃO termina a sessão', async () => {
  const shared = new Map([['bracketBeats.tokens', expired()]]);
  const auth = new SpotifyAuth(V.secretStorage(shared));
  api = fakeSpotify([['POST', /api\/token/, () => json({ error: 'server_error' }, 503)]]);
  await assert.rejects(auth.getAccessToken());
  assert.ok(shared.has('bracketBeats.tokens'), 'tokens continuam guardados');
  assert.equal(await auth.isLoggedIn(), true);
});

test('token quase a expirar mas ainda válido continua a ser usado se a renovação falhar', async () => {
  const shared = new Map([['bracketBeats.tokens', storedTokens({ expiresAt: Date.now() + 30_000 })]]);
  const auth = new SpotifyAuth(V.secretStorage(shared));
  api = fakeSpotify([['POST', /api\/token/, () => { throw new TypeError('fetch failed'); }]]);
  assert.equal(await auth.getAccessToken(), 'AT');
});

test('refresh token recusado (invalid_grant) termina a sessão', async () => {
  const shared = new Map([['bracketBeats.tokens', expired()]]);
  const auth = new SpotifyAuth(V.secretStorage(shared));
  api = fakeSpotify([['POST', /api\/token/, () => json({ error: 'invalid_grant' }, 400)]]);
  assert.equal(await auth.getAccessToken(), undefined);
  assert.equal(shared.has('bracketBeats.tokens'), false);
});

test('se outra janela já renovou, usa os tokens dela em vez de gastar o refresh token', async () => {
  const shared = new Map([['bracketBeats.tokens', expired()]]);
  const store = V.secretStorage(shared);
  const auth = new SpotifyAuth(store);
  await auth.isLoggedIn(); // carrega os tokens expirados
  // A outra janela renova e guarda (sem passar por esta instância).
  shared.set('bracketBeats.tokens', storedTokens({ accessToken: 'FROM_OTHER', refreshToken: 'RT_OTHER' }));
  api = fakeSpotify([]); // qualquer pedido rebenta
  assert.equal(await auth.getAccessToken(), 'FROM_OTHER');
  assert.equal(api.calls.length, 0);
});

test('a sessão terminada noutra janela avisa esta', async () => {
  const shared = new Map([['bracketBeats.tokens', storedTokens()]]);
  const a = new SpotifyAuth(V.secretStorage(shared));
  const b = new SpotifyAuth(V.secretStorage(shared));
  await a.isLoggedIn(); await b.isLoggedIn();
  let fired = 0;
  b.onDidChangeSession(() => fired++);
  await a.logout();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fired, 1);
  assert.equal(await b.isLoggedIn(), false);
});

test('tokens de uma versão antiga (sem as permissões novas) pedem nova autorização', async () => {
  const shared = new Map([['bracketBeats.tokens', storedTokens({ scope: 'user-read-playback-state user-top-read' })]]);
  const auth = new SpotifyAuth(V.secretStorage(shared));
  assert.equal(await auth.isLoggedIn(), false);
  assert.equal(auth.needsReauth, true);
});

// ---------- rate limit ----------

test('depois de um 429 não volta a pedir até passar o Retry-After', async () => {
  const auth = new SpotifyAuth(V.secretStorage(new Map([['bracketBeats.tokens', storedTokens()]])));
  const client = new SpotifyClient(auth);
  api = fakeSpotify([['GET', /^\/me\/player/, () => json({ error: { message: 'slow down' } }, 429, { 'retry-after': '7' })]]);
  await assert.rejects(client.getPlayerState(), (e) => e instanceof SpotifyError && e.status === 429);
  await assert.rejects(client.getPlayerState(), (e) => e.status === 429);
  assert.equal(api.calls.length, 1, 'o segundo pedido nem chega a sair');
  assert.ok(client.rateLimitedMs > 6000 && client.rateLimitedMs <= 7000);
});

test('sem dispositivo ativo, toca no primeiro disponível', async () => {
  const auth = new SpotifyAuth(V.secretStorage(new Map([['bracketBeats.tokens', storedTokens()]])));
  const client = new SpotifyClient(auth);
  api = fakeSpotify([
    ['PUT', /^\/me\/player\/play\?device_id=D1$/, () => empty()],
    ['PUT', /^\/me\/player\/play$/, () => json({ error: { message: 'No active device' } }, 404)],
    ['GET', /^\/me\/player\/devices/, () => ({ devices: [{ id: 'D1', name: 'Portátil', type: 'Computer', is_active: false }] })],
  ]);
  await client.play({ contextUri: 'spotify:album:x', offsetUri: 'spotify:track:t' });
  assert.deepEqual(api.calls, ['PUT /me/player/play', 'GET /me/player/devices', 'PUT /me/player/play?device_id=D1']);
});

// ---------- várias janelas ----------

test('cadeado entre janelas: só a primeira ganha', async () => {
  const a = new Store(tmp), b = new Store(tmp);
  const results = await Promise.all([a.tryLock('x.lock', 60_000), b.tryLock('x.lock', 60_000), a.tryLock('x.lock', 60_000)]);
  assert.deepEqual(results.filter(Boolean).length, 1);
});

test('cadeado antigo expira', async () => {
  const s = new Store(tmp);
  assert.equal(await s.tryLock('y.lock', 60_000), true);
  const f = path.join(tmp, 'y.lock');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(f, old, old);
  assert.equal(await s.tryLock('y.lock', 60_000), true);
});

function playerFixture(state) {
  const auth = new SpotifyAuth(V.secretStorage(new Map([['bracketBeats.tokens', storedTokens()]])));
  const client = new SpotifyClient(auth);
  const store = new Store(tmp);
  return { auth, client, store, player: new Player(auth, client, store) };
}

const playing = (id = 't1', extra = {}) => ({
  is_playing: true, progress_ms: 10_000, shuffle_state: false, repeat_state: 'off',
  device: { id: 'D1', name: 'Portátil', type: 'Computer', is_active: true, volume_percent: 40, supports_volume: true },
  context: { uri: 'spotify:playlist:P1' },
  item: track(id, 'Teardrop', [['ma', 'Massive Attack']]),
  ...extra,
});

test('a janela em foco partilha o estado; as outras leem-no sem pedir nada ao Spotify', async () => {
  const A = playerFixture(); const B = playerFixture();
  api = fakeSpotify([
    ['GET', /^\/me\/player\?/, () => playing()],
    ['GET', /^\/me\/library\/contains/, () => [true]],
  ]);
  A.player.start(); await A.player.refresh();
  assert.equal(A.player.state.title, 'Teardrop');
  assert.equal(A.player.liked, true);
  A.player.stop();
  const before = api.calls.length;

  V.vscode.window.state.focused = false; // a janela B não está em foco
  let changed = 0; B.player.onDidChange(() => changed++);
  B.player.start(); await B.player.refresh();
  assert.equal(B.player.state.title, 'Teardrop');
  assert.equal(B.player.liked, true);
  assert.equal(changed, 1);
  B.player.stop();
  assert.equal(api.calls.length, before, 'B não fez pedidos');
});

test('polling adaptativo: em pausa e sem nada espera mais; no fim da música pergunta logo', async () => {
  const { player } = playerFixture();
  V.settings.pollIntervalSeconds = 5;
  player.state = undefined;
  assert.equal(player.nextDelay(), 30_000);
  player.state = { isPlaying: false, progressMs: 0, durationMs: 200_000, fetchedAt: Date.now() };
  assert.equal(player.nextDelay(), 15_000);
  player.state = { isPlaying: true, progressMs: 100_000, durationMs: 200_000, fetchedAt: Date.now() };
  assert.equal(player.nextDelay(), 5000);
  player.state = { isPlaying: true, progressMs: 198_000, durationMs: 200_000, fetchedAt: Date.now() };
  const d = player.nextDelay();
  assert.ok(d >= 2500 && d <= 2900, `devia acordar logo após o fim da música, deu ${d}`);
  V.vscode.window.state.focused = false;
  assert.equal(player.nextDelay(), 5000);
});

test('o progresso é interpolado sem novos pedidos', () => {
  const { player } = playerFixture();
  player.state = { isPlaying: true, progressMs: 10_000, durationMs: 200_000, fetchedAt: Date.now() - 3000 };
  const p = player.progressNow();
  assert.ok(p >= 12_900 && p <= 13_200);
});

test('a música nova é anunciada uma só vez (para o histórico)', async () => {
  const { player } = playerFixture();
  let id = 't1';
  api = fakeSpotify([
    ['GET', /^\/me\/player\?/, () => playing(id)],
    ['GET', /^\/me\/library\/contains/, () => [false]],
  ]);
  const started = [];
  player.onDidStartTrack((s) => started.push(s.id));
  player.start();
  await player.refresh(); await player.refresh();
  id = 't2'; await player.refresh(); await player.refresh();
  player.stop();
  assert.deepEqual(started, ['t1', 't2']);
});

test('play/pause muda logo na interface e volta atrás se o Spotify falhar', async () => {
  const { player } = playerFixture();
  player.state = { isPlaying: true, progressMs: 0, durationMs: 1, fetchedAt: Date.now() };
  const seen = [];
  player.onDidChange(() => seen.push(player.state.isPlaying));
  api = fakeSpotify([['PUT', /^\/me\/player\/pause/, () => json({ error: { message: 'boom' } }, 500)]]);
  await assert.rejects(player.togglePlay());
  assert.deepEqual(seen, [false, true]);
});

test('401 a meio do polling avisa que a sessão se perdeu', async () => {
  const { player } = playerFixture();
  api = fakeSpotify([
    ['GET', /^\/me\/player\?/, () => json({ error: { message: 'expired' } }, 401)],
    ['POST', /api\/token/, () => json({ error: 'invalid_grant' }, 400)],
  ]);
  let lost = 0; player.onDidLoseSession(() => lost++);
  player.start(); await player.refresh(); player.stop();
  assert.equal(lost, 1);
});

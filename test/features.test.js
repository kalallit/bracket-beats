const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./helpers/vscode');
const { fakeSpotify, json, empty, storedTokens, track } = require('./helpers/spotify');

const { SpotifyAuth } = require('../out/auth');
const { SpotifyClient } = require('../out/spotify');
const { Store } = require('../out/store');
const { Player } = require('../out/player');
const { History, ContextCache } = require('../out/history');
const { Feedback } = require('../out/feedback');
const { Project } = require('../out/project');
const { Recommender, getMoods } = require('../out/recommender');
const { buildSuggestion } = require('../out/suggest');
const { FocusSession } = require('../out/focus');
const actions = require('../out/actions');

let api, tmp, store;
beforeEach(() => {
  V.reset();
  V.settings.language = 'pt';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spn-'));
  store = new Store(tmp);
});
afterEach(() => { api?.restore(); api = undefined; fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  return new SpotifyClient(new SpotifyAuth(V.secretStorage(new Map([['bracketBeats.tokens', storedTokens()]]))));
}
function openProject(name = 'loja-online') {
  V.vscode.workspace.workspaceFolders = [{ uri: { toString: () => `file:///code/${name}` } }];
  V.vscode.workspace.name = name;
}
const stateFor = (id, ctx, artists = [['a1', 'Artista']]) => ({
  id, uri: `spotify:track:${id}`, type: 'track', title: `Música ${id}`, artists: 'x',
  artistList: artists.map(([i, n]) => ({ id: i, name: n })), durationMs: 180_000, contextUri: ctx,
  isPlaying: true, progressMs: 0, fetchedAt: Date.now(), shuffle: false, repeat: 'off',
});

// ---------- histórico ----------

test('histórico: regista uma vez por música, com projeto e linguagem', async () => {
  const h = new History(store);
  assert.equal(await h.record(stateFor('t1', 'spotify:playlist:P'), 'ws1', 'typescript'), true);
  assert.equal(await h.record(stateFor('t1', 'spotify:playlist:P'), 'ws1', 'typescript'), false, 'duplicado');
  assert.equal(await h.record({ ...stateFor('e1'), type: 'episode' }, 'ws1'), false, 'podcasts não contam');
  const all = await new History(store).all();
  assert.equal(all.length, 1);
  assert.equal(all[0].ws, 'ws1'); assert.equal(all[0].lang, 'typescript');
});

test('histórico desligado nas definições não regista nada', async () => {
  const h = new History(store, () => false);
  assert.equal(await h.record(stateFor('t1'), 'ws'), false);
  assert.equal((await h.all(true)).length, 0);
});

test('histórico: contextos mais ouvidos filtrados por projeto e hora', async () => {
  const h = new History(store);
  const at = (hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const lines = [];
  for (let i = 0; i < 5; i++) { lines.push({ ts: at(10), id: `a${i}`, uri: 'u', name: 'n', artists: [], ctx: 'spotify:playlist:FOCO', ws: 'loja', ms: 1 }); }
  for (let i = 0; i < 3; i++) { lines.push({ ts: at(22), id: `b${i}`, uri: 'u', name: 'n', artists: [], ctx: 'spotify:playlist:NOITE', ws: 'blog', ms: 1 }); }
  lines.push({ ts: at(10), id: 'c', uri: 'u', name: 'n', artists: [], ctx: 'spotify:show:podcast', ws: 'loja', ms: 1 });
  await store.writeLines('history.jsonl', lines.map((l) => JSON.stringify(l)));
  assert.deepEqual((await h.topContexts({ ws: 'loja' })).map((c) => c.ctx), ['spotify:playlist:FOCO'], 'podcasts ignorados');
  assert.deepEqual((await h.topContexts({ hour: 23 })).map((c) => c.ctx), ['spotify:playlist:NOITE']);
  assert.deepEqual((await h.topContexts({ min: 4 })).map((c) => c.ctx), ['spotify:playlist:FOCO']);
});

test('histórico corta as entradas mais antigas quando fica grande', async () => {
  const lines = Array.from({ length: 6100 }, (_, i) => JSON.stringify({ ts: i, id: String(i), uri: 'u', name: 'n', artists: [], ms: 1 }));
  await store.writeLines('history.jsonl', lines);
  const all = await new History(store).all();
  assert.equal(all.length, 5000);
  assert.equal(all[0].id, '1100');
  assert.equal((await store.readLines('history.jsonl')).length, 5000);
});

// ---------- feedback ----------

test('feedback: escolher sobe, ignorar muitas vezes desce, esconder elimina', async () => {
  const f = new Feedback(store);
  await f.played('A'); await f.played('A'); await f.played('A');
  for (let i = 0; i < 12; i++) { await f.shown(['B']); }
  await f.hide('C');
  const g = new Feedback(store); await g.load(); // outra janela vê o mesmo
  assert.ok(g.multiplier('A') > 1.6);
  assert.equal(g.multiplier('B'), 0.4);
  assert.equal(g.multiplier('C'), 0);
  assert.equal(g.multiplier('novo'), 1);
  assert.equal(await g.unhideAll(), 1);
  assert.equal(g.multiplier('C'), 1);
});

// ---------- moods personalizados ----------

test('moods: esconder os de origem e acrescentar os teus', () => {
  V.settings.hiddenMoods = ['melancolia', 'noite'];
  V.settings.customMoods = [
    { label: 'Metal', emoji: '🤘', query: 'metal classics', keywords: ['metal'] },
    { label: 'Fado à noite' },
    { emoji: 'sem nome' },
    { label: 'Metal', color: 'vermelho' },
  ];
  const moods = getMoods();
  const ids = moods.map((m) => m.id);
  assert.ok(!ids.includes('melancolia') && !ids.includes('noite'));
  const metal = moods.find((m) => m.label === 'Metal');
  assert.equal(metal.query, 'metal classics');
  const fado = moods.find((m) => m.label === 'Fado à noite');
  assert.equal(fado.id, 'custom-fado-a-noite');
  assert.equal(fado.query, 'Fado à noite', 'sem pesquisa, usa o nome');
  assert.equal(fado.emoji, '🎵');
  assert.equal(moods.filter((m) => m.custom).length, 3, 'o sem nome é ignorado');
  assert.equal(new Set(ids).size, ids.length, 'ids únicos mesmo com nomes repetidos');
  assert.match(moods.filter((m) => m.label === 'Metal')[1].color, /^#[0-9a-f]{6}$/i, 'cor inválida troca por uma válida');
});

// ---------- recomendador com contexto ----------

function recFixture(deps) {
  const pl = (id, name, owner = 'me', extra = {}) => ({ id, uri: `spotify:playlist:${id}`, name, description: '', owner: { id: owner, display_name: owner }, images: [{ url: `https://i/${id}` }], items: { total: 20 }, snapshot_id: 's1', ...extra });
  const playlists = [pl('P1', 'Trip hop'), pl('P2', 'Rock'), pl('P3', 'Electrónica'), pl('P4', 'Jazz')];
  const items = { P1: ['ma', 'bon'], P2: ['rad'], P3: ['bon', 'daf'], P4: ['nn'] };
  api = fakeSpotify([
    ['GET', /^\/me$/, () => ({ id: 'me', display_name: 'Leandro' })],
    ['GET', /^\/me\/top\/artists/, () => ({ items: [
      { id: 'ma', name: 'Massive Attack', genres: ['trip hop'] }, { id: 'bon', name: 'Bonobo', genres: ['downtempo'] },
      { id: 'rad', name: 'Radiohead', genres: ['art rock'] }, { id: 'daf', name: 'Daft Punk', genres: ['house'] }] })],
    ['GET', /^\/me\/player\/recently-played/, () => ({ items: [] })],
    ['GET', /^\/me\/playlists/, () => ({ items: playlists })],
    ['GET', /^\/playlists\/(P\d)\/items/, (r) => ({ items: (items[/P\d/.exec(r.path)[0]] ?? []).map((a) => ({ item: { artists: [{ id: a }] } })) })],
    ['GET', /^\/playlists\/HAB/, () => ({ name: 'Hábito de projeto', images: [{ url: 'https://i/HAB' }], owner: { display_name: 'me' } })],
    ['GET', /^\/search/, () => ({ playlists: { items: [] } })],
  ]);
  return new Recommender(deps.client, deps);
}

test('Para ti: playlist do projeto primeiro, depois o hábito, e o feedback mexe na ordem', async () => {
  openProject();
  const c = client();
  const project = new Project(V.memento());
  await project.setPlaylist({ uri: 'spotify:playlist:PROJ', name: 'Loja · foco' });
  const history = new History(store);
  const lines = Array.from({ length: 4 }, (_, i) => JSON.stringify({ ts: Date.now() - i * 1000, id: `h${i}`, uri: 'u', name: 'n', artists: [], ctx: 'spotify:playlist:HAB', ws: project.key, ms: 1 }));
  await store.writeLines('history.jsonl', lines);
  const feedback = new Feedback(store);
  await feedback.hide('spotify:playlist:P1'); // a melhor por artistas, mas escondida
  for (let i = 0; i < 3; i++) { await feedback.played('spotify:playlist:P4'); }

  const rec = recFixture({ client: c, store, feedback, history, contexts: new ContextCache(store, c), project });
  const cards = await rec.forYou();
  assert.equal(cards[0].uri, 'spotify:playlist:PROJ'); assert.equal(cards[0].pinned, true);
  assert.equal(cards[1].name, 'Hábito de projeto'); assert.equal(cards[1].reason, 'Costumas ouvir neste projeto');
  assert.ok(!cards.some((x) => x.uri === 'spotify:playlist:P1'), 'escondida não aparece');
  assert.ok(!cards.some((x) => x.uri === 'spotify:playlist:P4'), 'Jazz não tem artistas teus, o feedback não inventa afinidade');
});

test('a cache de artistas por playlist fica em disco e só se refaz quando a playlist muda', async () => {
  const c = client();
  const rec = recFixture({ client: c, store });
  await rec.forYou();
  const first = api.calls.filter((x) => /\/playlists\/P\d\/items/.test(x)).length;
  assert.equal(first, 4);
  api.restore();
  const rec2 = recFixture({ client: c, store }); // nova janela/arranque
  await rec2.forYou();
  assert.equal(api.calls.filter((x) => /\/playlists\/P\d\/items/.test(x)).length, 0, 'tudo veio da cache');
});

// ---------- sugestão ao arrancar ----------

test('sugestão ao arrancar: playlist do projeto > hábito > último contexto > última música', async () => {
  const c = client();
  const project = new Project(V.memento());
  const history = new History(store);
  const contexts = new ContextCache(store, c);
  let recent = { items: [{ track: track('t9', 'Solta', [['x', 'X']]), context: null, played_at: new Date().toISOString() }] };
  api = fakeSpotify([
    ['GET', /^\/me\/player\/recently-played/, () => recent],
    ['GET', /^\/playlists\/HAB$/, () => ({ name: 'Hábito', owner: { display_name: 'me' } })],
    ['GET', /^\/playlists\/LAST$/, () => ({ name: 'Última', owner: { display_name: 'me' } })],
  ]);
  const deps = { client: c, project, history, contexts };

  let s = await buildSuggestion(deps);
  assert.equal(s.kind, 'Música');
  assert.equal(s.contextUri, 'spotify:album:alt9', 'toca dentro do álbum...');
  assert.equal(s.offsetUri, 'spotify:track:t9', '...a começar na música');

  recent = { items: [{ track: track('t1', 'a', [['x', 'X']]), context: { uri: 'spotify:playlist:LAST' }, played_at: '' }] };
  assert.equal((await buildSuggestion(deps)).name, 'Última');

  openProject();
  await store.writeLines('history.jsonl', Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({ ts: Date.now() - i, id: `h${i}`, uri: 'u', name: 'n', artists: [], ctx: 'spotify:playlist:HAB', ws: project.key, ms: 1 })));
  s = await buildSuggestion(deps);
  assert.equal(s.name, 'Hábito'); assert.equal(s.kind, 'Costumas ouvir neste projeto');

  await project.setPlaylist({ uri: 'spotify:playlist:PROJ', name: 'Do projeto' });
  s = await buildSuggestion(deps);
  assert.equal(s.contextUri, 'spotify:playlist:PROJ'); assert.equal(s.kind, 'Playlist deste projeto');
});

// ---------- player completo ----------

function player(c) { return new Player(c.auth ?? new SpotifyAuth(V.secretStorage(new Map([['bracketBeats.tokens', storedTokens()]]))), c, store); }

test('gostar, aleatório, repetir e volume', async () => {
  const c = client(); const p = player(c);
  p.state = { ...stateFor('t1'), device: { id: 'D', name: 'PC', type: 'Computer', isActive: true, volume: 95, supportsVolume: true } };
  api = fakeSpotify([
    ['PUT', /^\/me\/library\?uris=spotify%3Atrack%3At1$/, () => empty(200)],
    ['DELETE', /^\/me\/library\?uris=/, () => empty(200)],
    ['PUT', /^\/me\/player\/shuffle\?state=true$/, () => empty()],
    ['PUT', /^\/me\/player\/repeat\?state=(context|track|off)$/, () => empty()],
    ['PUT', /^\/me\/player\/volume\?volume_percent=100$/, () => empty()],
  ]);
  assert.equal(await p.toggleLike(), true);
  assert.equal(await p.toggleLike(), false);
  assert.equal(await p.toggleShuffle(), true);
  assert.deepEqual([await p.cycleRepeat(), await p.cycleRepeat(), await p.cycleRepeat()], ['context', 'track', 'off']);
  assert.equal(await p.changeVolume(+10), 100, 'não passa de 100');
  p.state.device.supportsVolume = false;
  assert.equal(await p.setVolume(50), undefined);
});

test('pesquisa: agrupa por tipo e tocar uma música toca-a dentro do álbum', async () => {
  const c = client(); const p = player(c);
  api = fakeSpotify([
    ['GET', /^\/search\?type=track,album,playlist,artist/, () => ({
      tracks: { items: [track('t1', 'Teardrop', [['ma', 'Massive Attack']])] },
      albums: { items: [{ uri: 'spotify:album:A', name: 'Mezzanine', artists: [{ name: 'Massive Attack' }], images: [] }] },
      playlists: { items: [null, { uri: 'spotify:playlist:L', name: 'Trip hop', owner: { display_name: 'x' }, images: [] }] },
      artists: { items: [] },
    })],
  ]);
  const res = await c.search('teardrop');
  assert.deepEqual(res.map((r) => r.type), ['track', 'album', 'playlist']);
  assert.equal(res[0].albumUri, 'spotify:album:alt1');
});

test('guardar a sessão cria a playlist só com as músicas (sem repetições) do período escolhido', async () => {
  const c = client(); const p = player(c);
  openProject();
  const project = new Project(V.memento());
  const history = new History(store);
  const now = Date.now();
  await store.writeLines('history.jsonl', [
    { ts: now - 5 * 3_600_000, id: 'velha', uri: 'spotify:track:velha' },
    { ts: now - 60_000, id: 'a', uri: 'spotify:track:a' },
    { ts: now - 50_000, id: 'b', uri: 'spotify:track:b' },
    { ts: now - 40_000, id: 'a', uri: 'spotify:track:a' },
  ].map((x) => JSON.stringify({ name: 'n', artists: [], ms: 1, ws: project.key, ...x })));
  let added;
  api = fakeSpotify([
    ['POST', /^\/me\/playlists$/, (r) => { assert.equal(r.json().public, false); return { id: 'NEW', uri: 'spotify:playlist:NEW', external_urls: { spotify: 'https://x' } }; }],
    ['POST', /^\/playlists\/NEW\/items$/, (r) => { added = r.json().uris; return { snapshot_id: 'x' }; }],
  ]);
  const focus = new FocusSession(p, { startMusic: async () => {} });
  const deps = { client: c, player: p, rec: () => ({ reset() {} }), history, contexts: null, feedback: null, project, focus, activatedAt: now - 120_000, guard: (f) => f() };
  V.answers.push((items) => items.find((i) => i.label === 'Desde que abri esta janela'), '__default__', undefined);
  await actions.saveSession(deps);
  assert.deepEqual(added, ['spotify:track:a', 'spotify:track:b']);
  const input = V.messages.find((m) => m[0] === 'input');
  assert.match(input[2], /^loja-online · /, 'nome sugerido com o projeto');
  focus.dispose();
});

test('associar ao projeto a playlist que está a tocar', async () => {
  openProject();
  const c = client(); const p = player(c);
  p.state = stateFor('t1', 'spotify:playlist:NOW');
  const project = new Project(V.memento());
  api = fakeSpotify([
    ['GET', /^\/playlists\/NOW$/, () => ({ name: 'A tocar agora', images: [{ url: 'https://i/now' }], owner: { display_name: 'me' } })],
    ['GET', /^\/me\/playlists/, () => ({ items: [] })],
  ]);
  const deps = { client: c, player: p, rec: () => ({ myPlaylists: async () => [] }), history: null, contexts: new ContextCache(store, c), feedback: null, project, focus: null, activatedAt: 0, guard: (f) => f() };
  V.answers.push((items) => items[0]);
  await actions.bindProject(deps);
  assert.deepEqual(project.playlist, { uri: 'spotify:playlist:NOW', name: 'A tocar agora', image: 'https://i/now' });
});

// ---------- foco ----------

test('foco: pausa a música no intervalo e retoma no foco seguinte', async () => {
  const calls = [];
  const fakePlayer = {
    state: { isPlaying: true },
    pause: async () => { calls.push('pause'); fakePlayer.state.isPlaying = false; },
    play: async () => { calls.push('play'); fakePlayer.state.isPlaying = true; },
  };
  let started = 0;
  const f = new FocusSession(fakePlayer, { startMusic: async () => { started++; } });
  await f.start(25, 5);
  assert.equal(f.phase, 'work'); assert.equal(started, 1);
  f.skip();
  assert.equal(f.phase, 'break'); assert.equal(f.rounds, 1);
  f.skip();
  assert.equal(f.phase, 'work');
  assert.deepEqual(calls, ['pause', 'play']);

  // Se a pessoa já tinha pausado, a pausa do foco não volta a pôr a tocar.
  fakePlayer.state.isPlaying = false; calls.length = 0;
  f.skip(); f.skip();
  assert.deepEqual(calls, []);

  f.stop();
  assert.equal(f.active, false);
  assert.ok(f.lastSession.to >= f.lastSession.from);
  f.dispose();
});

test('foco: com a opção desligada não mexe na música', async () => {
  V.settings['focus.pauseOnBreak'] = false;
  const calls = [];
  const fakePlayer = { state: { isPlaying: true }, pause: async () => calls.push('pause'), play: async () => calls.push('play') };
  const f = new FocusSession(fakePlayer, { startMusic: async () => {} });
  await f.start(25, 5); f.skip(); f.skip(); f.stop(); f.dispose();
  assert.deepEqual(calls, []);
});

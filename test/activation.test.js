const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./helpers/vscode');
const { fakeSpotify, empty, storedTokens, track } = require('./helpers/spotify');

// Peças da API que só a ativação usa.
const commands = new Map();
let sidebar;
const panels = [];
V.vscode.commands.registerCommand = (id, fn) => { commands.set(id, fn); return { dispose() {} }; };
V.vscode.commands.executeCommand = (id, ...a) => commands.get(id)?.(...a);
V.vscode.window.registerWebviewViewProvider = (id, provider) => { sidebar = { id, provider }; return { dispose() {} }; };
V.vscode.window.createWebviewPanel = () => {
  let onMsg, onDisp;
  const panel = {
    webview: { set html(h) { panel.html = h; }, onDidReceiveMessage(f) { onMsg = f; }, postMessage() {} },
    onDidDispose(f) { onDisp = f; }, dispose() { onDisp?.(); }, reveal() {},
    send: (m) => onMsg(m),
  };
  panels.push(panel);
  return panel;
};

let api, tmp, ext, ctx;
// Como o VS Code ao fechar: liberta tudo o que a extensão registou.
afterEach(() => { ctx?.subscriptions.forEach((d) => d.dispose?.()); ext?.deactivate(); api?.restore(); fs.rmSync(tmp, { recursive: true, force: true }); });

function context(tokens) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spn-'));
  return ctx = {
    subscriptions: [],
    secrets: V.secretStorage(new Map(tokens ? [['bracketBeats.tokens', tokens]] : [])),
    globalStorageUri: { fsPath: tmp },
    workspaceState: V.memento(),
    globalState: V.memento(),
  };
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('arranque com sessão: barra de estado, barra lateral e sugestão quando está parado', async () => {
  V.reset(); V.settings.language = 'pt'; V.settings.clientId = '0123456789abcdef0123456789abcdef';
  let playing = false;
  api = fakeSpotify([
    ['GET', /^\/me\/player\?/, () => playing
      ? { is_playing: true, progress_ms: 1000, shuffle_state: false, repeat_state: 'off', item: track('t1', 'Teardrop', [['ma', 'Massive Attack']]), context: { uri: 'spotify:playlist:P' }, device: { id: 'D', name: 'PC', type: 'Computer', is_active: true, volume_percent: 50 } }
      : empty()],
    ['GET', /^\/me\/library\/contains/, () => [false]],
    ['GET', /^\/me\/player\/recently-played/, () => ({ items: [{ track: track('t1', 'Teardrop', [['ma', 'Massive Attack']]), context: { uri: 'spotify:playlist:P' }, played_at: '' }] })],
    ['GET', /^\/playlists\/P$/, () => ({ name: 'Foco Total', images: [{ url: 'https://i/P' }], owner: { display_name: 'Leandro' } })],
    ['PUT', /^\/me\/player\/play$/, (r) => { assert.deepEqual(r.json(), { context_uri: 'spotify:playlist:P' }); playing = true; return empty(); }],
    ['PUT', /^\/me\/library\?uris=/, () => empty(200)],
  ]);

  ext = require('../out/extension');
  await ext.activate(context(storedTokens()));
  await wait(100);

  assert.equal(sidebar.id, 'bracketBeats.player');
  for (const id of ['bracketBeats.search', 'bracketBeats.focus', 'bracketBeats.bindProject', 'bracketBeats.saveSession', 'bracketBeats.toggleLike', 'bracketBeats.pickDevice']) {
    assert.ok(commands.has(id), `comando ${id} registado`);
  }

  // Sugestão: cartão com a última playlist; clicar "Tocar" põe-na a tocar.
  const card = panels.at(-1);
  assert.ok(card.html.includes('Foco Total'));
  card.send({ type: 'play' });
  await wait(1200); // o player atualiza ~800 ms depois de mandar tocar

  const main = V.statusItems.find((i) => /Teardrop/.test(i.text));
  assert.ok(main, 'a barra de estado mostra a música');
  assert.ok(main.text.startsWith('$(debug-pause)'));

  await commands.get('bracketBeats.toggleLike')();
  assert.ok(V.statusItems.some((i) => i.text === '$(heart-filled)'), 'coração preenchido depois de gostar');
});

test('arranque sem sessão mostra "Ligar Spotify"', async () => {
  V.reset(); V.settings.language = 'pt';
  api = fakeSpotify([]);
  delete require.cache[require.resolve('../out/extension')];
  ext = require('../out/extension');
  await ext.activate(context(undefined));
  assert.ok(V.statusItems.some((i) => i.text === '$(account) Ligar Spotify' && i.visible));
  assert.equal(api.calls.length, 0);
});

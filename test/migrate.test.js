const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./helpers/vscode');

// Definições por secção, com inspect(), como no VS Code.
let config;
V.vscode.workspace.getConfiguration = (section) => ({
  get: (k, d) => config[`${section}.${k}`]?.global ?? d,
  inspect: (k) => {
    const v = config[`${section}.${k}`];
    return v ? { globalValue: v.global, workspaceValue: v.workspace } : { globalValue: undefined, workspaceValue: undefined };
  },
  update: async (k, value, target) => {
    const e = (config[`${section}.${k}`] ??= {});
    if (target === V.vscode.ConfigurationTarget.Global) { e.global = value; } else { e.workspace = value; }
  },
});
V.vscode.ConfigurationTarget.Workspace = 2;

const { migrate } = require('../out/migrate');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'spn-mig-')); config = {}; V.vscode.workspace.workspaceFolders = undefined; });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ctx(publisher = 'local') {
  const state = new Map();
  return {
    globalStorageUri: { fsPath: path.join(root, `${publisher}.bracket-beats`) },
    globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } },
  };
}
function oldFolder(name, files) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) { fs.writeFileSync(path.join(dir, f), content); }
  return dir;
}

test('traz as definições spotifyNow.* sem estragar as que já existem', async () => {
  config = {
    'spotifyNow.clientId': { global: 'abc' },
    'spotifyNow.language': { global: 'pt' },
    'spotifyNow.customMoods': { global: [{ label: 'Metal' }] },
    'bracketBeats.language': { global: 'en' }, // já mudado na versão nova: fica
  };
  const r = await migrate(ctx());
  assert.deepEqual(r.settings.sort(), ['clientId', 'customMoods']);
  assert.equal(config['bracketBeats.clientId'].global, 'abc');
  assert.equal(config['bracketBeats.language'].global, 'en');
  assert.equal(config['spotifyNow.clientId'].global, 'abc', 'não apaga as antigas');
});

test('copia histórico e feedback da pasta antiga, sem substituir dados novos', async () => {
  oldFolder('local.spotify-now', { 'history.jsonl': 'H\n', 'feedback.json': '{"a":1}', 'now.json': '{}' });
  const c = ctx();
  fs.mkdirSync(c.globalStorageUri.fsPath, { recursive: true });
  fs.writeFileSync(path.join(c.globalStorageUri.fsPath, 'feedback.json'), '{"novo":true}');
  const r = await migrate(c);
  assert.deepEqual(r.files, ['history.jsonl']);
  assert.equal(fs.readFileSync(path.join(c.globalStorageUri.fsPath, 'history.jsonl'), 'utf8'), 'H\n');
  assert.equal(fs.readFileSync(path.join(c.globalStorageUri.fsPath, 'feedback.json'), 'utf8'), '{"novo":true}');
  assert.ok(!fs.existsSync(path.join(c.globalStorageUri.fsPath, 'now.json')), 'estado temporário não vem');
});

test('ao mudar de publisher, encontra os dados do publisher anterior', async () => {
  oldFolder('local.bracket-beats', { 'history.jsonl': 'H2\n' });
  const r = await migrate(ctx('leandro'));
  assert.deepEqual(r.files, ['history.jsonl']);
});

test('só corre uma vez', async () => {
  config = { 'spotifyNow.clientId': { global: 'abc' } };
  const c = ctx();
  await migrate(c);
  config['spotifyNow.redirectPort'] = { global: 9999 };
  const r = await migrate(c);
  assert.deepEqual(r, { settings: [], files: [] });
  assert.equal(config['bracketBeats.redirectPort'], undefined);
});

test('sem versão anterior não faz nada', async () => {
  const r = await migrate(ctx());
  assert.deepEqual(r, { settings: [], files: [] });
});

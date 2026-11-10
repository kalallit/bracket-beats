// Testa o assistente de ligação com QuickPick/InputBox simulados.
const { test } = require('node:test');
const assert = require('assert');
const Module = require('module'); const _l = Module._load;

let clipboard = '';
const opened = [];
const shown = [];     // inputs mostrados, por ordem
const settings = { language: 'pt', clientId: '', redirectPort: 8888 };

function makeInput(kind) {
  const h = {};
  const inp = {
    kind, items: [], selectedItems: [], value: '', buttons: [],
    onDidAccept(f) { h.accept = f; }, onDidTriggerButton(f) { h.button = f; },
    onDidHide(f) { h.hide = f; }, onDidChangeValue(f) { h.change = f; },
    show() { shown.push(inp); script.shift()?.(inp); },
    hide() { h.hide?.(); }, dispose() {},
    // ações do "utilizador"
    choose(id) { inp.selectedItems = [inp.items.find((i) => i.id === id)]; h.accept(); },
    type(v) { inp.value = v; h.change?.(v); },
    enter() { h.accept(); }, back() { h.button(); }, esc() { h.hide(); },
  };
  return inp;
}
const vscodeStub = {
  QuickInputButtons: { Back: { id: 'back' } },
  ConfigurationTarget: { Global: 1 },
  Uri: { parse: (s) => ({ toString: () => s }) },
  env: {
    language: 'pt',
    openExternal: async (u) => { opened.push(u.toString()); },
    clipboard: { writeText: async (s) => { clipboard = s; }, readText: async () => clipboard },
  },
  EventEmitter: class { constructor() { this.l = []; } get event() { return (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach((f) => f(v)); } },
  window: { createQuickPick: () => makeInput('pick'), createInputBox: () => makeInput('input') },
  workspace: { getConfiguration: () => ({
    get: (k, d) => settings[k] ?? d,
    update: async (k, v) => { settings[k] = v; },
  }) },
};
Module._load = function (r, ...a) { return r === 'vscode' ? vscodeStub : _l.call(this, r, ...a); };
const { runSetupWizard } = require('../out/setup.js');
const { SpotifyAuth } = require('../out/auth.js');

let script = [];
const URI = 'http://127.0.0.1:8888/callback';
const ID = '0123456789abcdef0123456789ABCDEF';
const later = (f) => (inp) => setImmediate(() => f(inp));

test('assistente de ligação', async () => {
  // 1) Caminho feliz
  script = [
    later((s1) => { assert.equal(s1.step, 1); assert.equal(s1.ignoreFocusOut, true); assert.equal(s1.buttons.length, 0); s1.choose('open'); }),
    later((s2) => { assert.equal(clipboard, URI); assert.ok(s2.placeholder.includes(URI)); clipboard = 'outra coisa'; s2.choose('copy'); }),
    later((s2) => { assert.equal(clipboard, URI, 'copiar outra vez repõe o URI'); s2.choose('next'); }),
    later((s3) => {
      assert.equal(s3.kind, 'input'); assert.equal(s3.step, 3); assert.equal(s3.value, '');
      s3.type('abc'); assert.ok(s3.validationMessage, 'ID curto deve dar erro');
      s3.enter(); assert.equal(shown.at(-1), s3, 'Enter com ID inválido não avança');
      s3.type(`  ${ID}  `); assert.equal(s3.validationMessage, undefined); s3.enter();
    }),
  ];
  let id = await runSetupWizard(URI);
  assert.equal(id, ID.toLowerCase());
  assert.deepEqual(opened, ['https://developer.spotify.com/dashboard']);
  console.log('✔ caminho feliz: abre dashboard, copia URI, valida e devolve o Client ID');

  // 2) Client ID já na área de transferência entra preenchido; botão voltar funciona
  script = [
    later((s1) => s1.choose('have')),
    later((s2) => { clipboard = ID; s2.choose('next'); }),
    later((s3) => { assert.equal(s3.value, ID, 'pré-preenchido da área de transferência'); s3.back(); }),
    later((s2) => { assert.equal(s2.step, 2); s2.back(); }),
    later((s1) => { assert.equal(s1.step, 1); s1.choose('have'); }),
    later((s2) => { clipboard = ID; s2.choose('next'); }),
    later((s3) => s3.enter()),
  ];
  opened.length = 0;
  id = await runSetupWizard(URI);
  assert.equal(id, ID.toLowerCase()); assert.equal(opened.length, 0);
  console.log('✔ pré-preenche da área de transferência e o botão voltar anda para trás');

  // 3) Esc em qualquer passo cancela
  for (const n of [1, 2, 3]) {
    script = [later((s) => n === 1 ? s.esc() : s.choose('have')), later((s) => n === 2 ? s.esc() : s.choose('next')), later((s) => s.esc())].slice(0, n);
    assert.equal(await runSetupWizard(URI), undefined);
  }
  console.log('✔ Esc cancela em qualquer passo');

  // 4) Integração: auth.setup() guarda nas definições; cancelar não guarda
  const auth = new SpotifyAuth({ get: async () => undefined, store: async () => {}, delete: async () => {} });
  script = [later((s) => s.esc())];
  assert.equal(await auth.login(), false); assert.equal(settings.clientId, '');
  script = [later((s) => s.choose('have')), later((s) => { clipboard = ID; s.choose('next'); }), later((s) => s.enter())];
  assert.equal(await auth.setup(), true); assert.equal(settings.clientId, ID.toLowerCase());
  console.log('✔ guarda o Client ID nas definições; cancelar não altera nada');
  console.log('\nAssistente OK.');
});

// Simulador mínimo da API do VS Code, para correr os testes com `node --test` sem abrir o editor.
// Tem de ser carregado antes de qualquer módulo de out/.
const Module = require('module');

class EventEmitter {
  constructor() { this.listeners = []; }
  get event() {
    return (fn) => { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== fn); } }; };
  }
  fire(v) { this.listeners.slice().forEach((l) => l(v)); }
  dispose() { this.listeners = []; }
}

const settings = {};
const messages = [];   // [tipo, texto, ...botões]
const answers = [];    // respostas a dar às próximas mensagens/escolhas (FIFO)
const statusItems = [];

function nextAnswer() { return answers.length ? answers.shift() : undefined; }

const vscode = {
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  QuickInputButtons: { Back: { id: 'back' } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } },
  Uri: { parse: (s) => ({ toString: () => s }), file: (p) => ({ fsPath: p, toString: () => 'file://' + p }) },
  env: {
    language: 'en',
    opened: [],
    openExternal: async (u) => { vscode.env.opened.push(String(u)); return true; },
    clipboard: { text: '', writeText: async (s) => { vscode.env.clipboard.text = s; }, readText: async () => vscode.env.clipboard.text },
  },
  window: {
    state: { focused: true },
    activeTextEditor: undefined,
    createStatusBarItem() {
      const it = { text: '', tooltip: '', visible: false, show() { it.visible = true; }, hide() { it.visible = false; }, dispose() {} };
      statusItems.push(it);
      return it;
    },
    showInformationMessage: async (m, ...rest) => { messages.push(['info', m, ...rest]); return nextAnswer(); },
    showWarningMessage: async (m, ...rest) => { messages.push(['warn', m, ...rest]); return nextAnswer(); },
    showErrorMessage: async (m, ...rest) => { messages.push(['error', m, ...rest]); return nextAnswer(); },
    showQuickPick: async (items, opts) => { messages.push(['pick', opts?.title, items]); const a = nextAnswer(); return typeof a === 'function' ? a(await items) : a; },
    showInputBox: async (opts) => { messages.push(['input', opts?.title, opts?.value]); const a = nextAnswer(); return a === '__default__' ? opts?.value : a; },
    setStatusBarMessage: (m) => { messages.push(['flash', m]); return { dispose() {} }; },
    onDidChangeWindowState: () => ({ dispose() {} }),
    createOutputChannel: () => ({ lines: [], clear() { this.lines = []; }, appendLine(l) { this.lines.push(l); }, show() {} }),
  },
  workspace: {
    name: undefined,
    workspaceFolders: undefined,
    workspaceFile: undefined,
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      inspect: (k) => ({ globalValue: settings[k], workspaceValue: undefined }),
      update: async (k, v) => { settings[k] = v; },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};

/** Repõe o estado do simulador entre testes. */
function reset() {
  for (const k of Object.keys(settings)) { delete settings[k]; }
  messages.length = 0;
  answers.length = 0;
  statusItems.length = 0;
  vscode.window.state.focused = true;
  vscode.workspace.workspaceFolders = undefined;
  vscode.workspace.name = undefined;
  vscode.env.opened.length = 0;
  vscode.env.clipboard.text = '';
}

/** SecretStorage em memória, partilhável entre "janelas" (instâncias de SpotifyAuth). */
function secretStorage(shared = new Map()) {
  const ev = new EventEmitter();
  const peers = shared.__peers ?? (shared.__peers = []);
  const me = {
    onDidChange: ev.event,
    get: async (k) => shared.get(k),
    store: async (k, v) => { shared.set(k, v); peers.forEach((p) => p.fire({ key: k })); },
    delete: async (k) => { shared.delete(k); peers.forEach((p) => p.fire({ key: k })); },
  };
  peers.push(ev);
  return me;
}

/** Memento em memória (workspaceState). */
function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] };
}

module.exports = { vscode, settings, messages, answers, statusItems, reset, secretStorage, memento, EventEmitter };

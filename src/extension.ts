import * as vscode from 'vscode';
import { SpotifyAuth } from './auth';
import { SpotifyClient, SpotifyError } from './spotify';
import { Store } from './store';
import { Player } from './player';
import { StatusBar } from './statusbar';
import { SidebarProvider } from './sidebar';
import { History, ContextCache } from './history';
import { Feedback } from './feedback';
import { Project } from './project';
import { FocusSession } from './focus';
import { Recommender } from './recommender';
import { buildSuggestion } from './suggest';
import { showSuggestionCard } from './card';
import { openPicker } from './picker';
import * as actions from './actions';
import { migrate } from './migrate';
import { initBrand } from './brand';
import { t } from './i18n';

let auth: SpotifyAuth;
let client: SpotifyClient;
let store: Store;
let player: Player;
let bar: StatusBar;
let side: SidebarProvider;
let history: History;
let contexts: ContextCache;
let feedback: Feedback;
let project: Project;
let focus: FocusSession;
let rec: Recommender;

const cfg = () => vscode.workspace.getConfiguration('bracketBeats');
const flash = (msg: string) => vscode.window.setStatusBarMessage(msg, 3000);

function newRecommender(): Recommender {
  return new Recommender(client, { store, feedback, history, contexts, project });
}

export async function activate(context: vscode.ExtensionContext) {
  const activatedAt = Date.now();

  // Definições e histórico da versão anterior ("Spotify Now"). Só corre uma vez.
  const migrated = await migrate(context);
  initBrand(context.extensionUri);

  store = new Store(context.globalStorageUri.fsPath);
  auth = new SpotifyAuth(context.secrets);
  client = new SpotifyClient(auth);
  player = new Player(auth, client, store);
  project = new Project(context.workspaceState);
  history = new History(store, () => cfg().get<boolean>('history.enabled', true));
  contexts = new ContextCache(store, client);
  feedback = new Feedback(store);
  rec = newRecommender();
  focus = new FocusSession(player, { startMusic });
  bar = new StatusBar(player, auth);
  side = new SidebarProvider(auth, player, focus, project);

  const deps: actions.ActionDeps = {
    client, player, rec: () => rec, history, contexts, feedback, project, focus, activatedAt, guard: run,
  };

  /** Regista um comando com o tratamento de erros habitual. */
  const cmd = (id: string, fn: (...args: any[]) => Promise<unknown> | unknown) =>
    vscode.commands.registerCommand(id, (...args: any[]) => run(async () => { await fn(...args); }));

  context.subscriptions.push(
    player, bar, focus,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, side),

    player.onDidChange(() => { bar.render(); void side.update(); }),
    // Histórico local: só a janela em foco vê a música começar, por isso o projeto e a linguagem são os certos.
    player.onDidStartTrack((s) => { history.record(s, project.key, project.language).catch(() => undefined); }),
    player.onDidLoseSession(() => showLoggedOut()),
    focus.onDidChange(() => { void side.update(); }),
    auth.onDidChangeSession(() => { void onSessionChanged(); }),

    vscode.commands.registerCommand('bracketBeats.login', login),
    vscode.commands.registerCommand('bracketBeats.setup', setup),
    vscode.commands.registerCommand('bracketBeats.logout', logout),

    cmd('bracketBeats.togglePlay', async () => { if (!(await player.togglePlay())) { await suggest(true); } }),
    cmd('bracketBeats.next', () => player.next()),
    cmd('bracketBeats.previous', () => player.previous()),
    cmd('bracketBeats.toggleLike', () => player.toggleLike()),
    cmd('bracketBeats.toggleShuffle', async () => {
      const on = await player.toggleShuffle();
      if (on !== undefined) { flash(on ? t('flash.shuffleOn') : t('flash.shuffleOff')); }
    }),
    cmd('bracketBeats.cycleRepeat', async () => {
      const mode = await player.cycleRepeat();
      if (mode) { flash(t(`flash.repeat.${mode}` as Parameters<typeof t>[0])); }
    }),
    cmd('bracketBeats.volumeUp', () => volume(+10)),
    cmd('bracketBeats.volumeDown', () => volume(-10)),
    // Usados pela barra lateral; não aparecem na paleta de comandos.
    cmd('bracketBeats.setVolume', (pct: number) => player.setVolume(Number(pct))),
    cmd('bracketBeats.seek', (ms: number) => player.seek(Number(ms))),

    cmd('bracketBeats.search', () => ensureLoggedIn(() => actions.search(deps))),
    cmd('bracketBeats.pickDevice', () => ensureLoggedIn(() => actions.pickDevice(deps))),
    cmd('bracketBeats.showQueue', () => ensureLoggedIn(() => actions.showQueue(deps))),
    cmd('bracketBeats.bindProject', () => ensureLoggedIn(() => actions.bindProject(deps))),
    cmd('bracketBeats.saveSession', () => ensureLoggedIn(() => actions.saveSession(deps))),
    cmd('bracketBeats.focus', () => ensureLoggedIn(() => actions.focusCommand(deps))),
    cmd('bracketBeats.clearHistory', () => actions.clearHistory(deps)),
    cmd('bracketBeats.unhidePlaylists', () => actions.unhidePlaylists(deps)),

    cmd('bracketBeats.suggest', () => suggest(true)),
    cmd('bracketBeats.openPicker', (tab?: string) => openPickerNow(typeof tab === 'string' ? tab : undefined)),
    cmd('bracketBeats.showProfile', showProfile),

    // Ao voltar a esta janela, atualiza já em vez de esperar pelo próximo ciclo.
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) { void player.refresh(); } }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bracketBeats.language')) { relabel(); }
      if (e.affectsConfiguration('bracketBeats.statusBarButtons')) { void renderBar(); }
    }),
  );

  if (!(await auth.isLoggedIn())) {
    showLoggedOut();
    // Vem do Spotify Now: as definições e o histórico vieram, mas a sessão tem de ser refeita.
    if (migrated.settings.includes('clientId')) {
      vscode.window.showInformationMessage(t('migrate.reconnect'), t('reauth.btn'))
        .then((pick) => { if (pick) { void login(); } });
      return;
    }
    // Versão nova com mais permissões: pede para voltar a ligar (só numa das janelas abertas).
    if (auth.needsReauth && await store.tryLock('reauth.lock', 60_000).catch(() => true)) {
      vscode.window.showInformationMessage(t('reauth.msg'), t('reauth.btn'))
        .then((pick) => { if (pick) { void login(); } });
    }
    return;
  }

  player.start();
  if (cfg().get('suggestOnStartup', true)) {
    void run(() => suggest(false));
  }
}

export function deactivate() {
  // Tudo o que precisa de ser libertado está em context.subscriptions.
}

// ---------- sessão ----------

async function login() {
  if (await auth.login()) {
    rec = newRecommender(); // perfil novo para a conta acabada de ligar
    vscode.window.showInformationMessage(t('connected'));
    player.start();
    void side.update();
    void run(() => suggest(false, true));
  }
}

/** Volta a correr o assistente (por exemplo, para trocar de app Spotify) e liga de novo. */
async function setup() {
  if (!(await auth.setup())) { return; }
  await logout(); // os tokens antigos pertencem ao Client ID anterior
  await login();
}

async function logout() {
  await auth.logout();
  player.stop();
  showLoggedOut();
}

/** Outra janela iniciou ou terminou a sessão. */
async function onSessionChanged() {
  if (await auth.isLoggedIn()) {
    rec = newRecommender();
    player.start();
  } else {
    player.stop();
    showLoggedOut();
  }
}

function showLoggedOut() {
  bar.showLoggedOut();
  void side.update();
}

async function renderBar() {
  if (await auth.isLoggedIn()) { bar.render(); } else { bar.showLoggedOut(); }
}

function relabel() {
  bar.relabel();
  void renderBar();
  side.reload();
}

/** Se não houver sessão, começa o login em vez de correr a ação. */
async function ensureLoggedIn(fn: () => Promise<unknown> | unknown) {
  if (!(await auth.isLoggedIn())) { await login(); return; }
  await fn();
}

// ---------- ações ----------

async function volume(delta: number) {
  const v = await player.changeVolume(delta);
  flash(v === undefined ? t('side.noVolume') : t('flash.volume', v));
}

/** Música para o início de uma sessão de foco: retoma o que estava, ou escolhe pela sugestão. */
async function startMusic() {
  if (player.state?.isPlaying) { return; }
  if (player.state) { await player.play(); return; }
  await player.play(await buildSuggestion({ client, project, history, contexts }));
}

/**
 * Se nada estiver a tocar, sugere música (playlist do projeto, hábito, ou a última ouvida).
 * @param manual true quando o utilizador pediu explicitamente (mostra mesmo se já estiver a tocar)
 * @param skipLock ignora o cadeado que evita a mesma sugestão em várias janelas ao arrancar
 */
async function suggest(manual: boolean, skipLock = false) {
  if (!manual && !skipLock) {
    // Com várias janelas a abrir ao mesmo tempo, só uma faz a sugestão.
    if (!(await store.tryLock('startup.lock', 60_000).catch(() => true))) { return; }
  }
  const now = await client.getPlayerState();
  if (now?.isPlaying && !manual) { return; }

  const s = await buildSuggestion({ client, project, history, contexts });
  const title = s ? t('suggest.ask', s.label) : t('suggest.resume');
  const style = cfg().get<string>('suggestionStyle', 'card');

  let play = false;
  if (style === 'card') {
    // Cartão com a capa, num separador do editor. Sem som de alerta.
    const choice = await showSuggestionCard(s);
    if (choice === 'more') { await openPickerNow(); return; }
    play = choice === 'play';
  } else if (style === 'modal') {
    // Janela no centro do ecrã. O VS Code acrescenta sozinho o botão "Cancelar".
    const pick = await vscode.window.showInformationMessage(
      `🎧 ${title}`,
      { modal: true, detail: t('suggest.detail') },
      t('btn.play')
    );
    play = pick === t('btn.play');
  } else if (style === 'quickpick') {
    // Lista no topo-centro, como a paleta de comandos. Esc para fechar.
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(play) ${t('qp.play')}`, description: s?.label ?? t('qp.resume'), id: 'play' },
        { label: `$(close) ${t('btn.later')}`, id: 'no' },
      ],
      { title: `🎧 ${title}`, placeHolder: t('qp.placeholder') }
    );
    play = pick?.id === 'play';
  } else {
    const pick = await vscode.window.showInformationMessage(`🎧 ${t('suggest.notif', title)}`, t('btn.play'), t('btn.later'));
    play = pick === t('btn.play');
  }

  if (play) { await player.play(s); }
}

async function openPickerNow(tab?: string) {
  await ensureLoggedIn(() => openPicker({ player, rec, feedback, project, onProjectChanged: () => { void side.update(); } }, tab));
}

let profileOut: vscode.OutputChannel | undefined;

/** Mostra num painel de output os géneros e artistas que o recomendador está a usar. */
async function showProfile() {
  if (!(await auth.isLoggedIn())) { await login(); return; }
  const sum = await rec.summary();
  profileOut ??= vscode.window.createOutputChannel('Bracket Beats');
  const barOf = (pct: number) => '█'.repeat(Math.max(1, Math.round(pct / 2))).padEnd(30);
  const lines = [`🎧 ${t('profile.title')}`, t('profile.note'), '', `${t('profile.genres')}:`];
  if (sum.genres.length) {
    sum.genres.forEach((g) => lines.push(`  ${barOf(g.pct)} ${String(g.pct).padStart(3)}%  ${g.genre}`));
  } else {
    lines.push(`  ${t('profile.none')}`);
  }
  lines.push('', `${t('profile.artists')}:`);
  sum.artists.forEach((a) => lines.push(`  ${barOf(a.pct)} ${String(a.pct).padStart(3)}%  ${a.name}`));

  // O que o histórico local sabe.
  const plays = await history.all(true);
  lines.push('', t('profile.history', plays.length));
  const ws = project.key;
  if (ws) {
    const top = (await history.topContexts({ ws })).slice(0, 5);
    if (top.length) {
      lines.push('', `${t('profile.projectTop', project.name ?? '')}:`);
      for (const c of top) {
        const meta = await contexts.get(c.ctx);
        lines.push(`  ${String(c.n).padStart(4)} × ${meta?.name ?? c.ctx}`);
      }
    }
  }
  if (project.playlist) { lines.push('', `📌 ${t('sug.project')}: ${project.playlist.name}`); }

  profileOut.clear();
  profileOut.appendLine(lines.join('\n'));
  profileOut.show(true);
}

// ---------- utilitários ----------

/** Corre uma ação e transforma os erros em avisos legíveis. */
async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    void side.update();
  } catch (e) {
    if (e instanceof SpotifyError) {
      if (e.status === 401) { player.stop(); showLoggedOut(); return; }
      if (e.status === 403 && e.reason === 'PREMIUM_REQUIRED') {
        vscode.window.showWarningMessage(t('err.premium'));
        return;
      }
    }
    vscode.window.showWarningMessage(`Spotify: ${(e as Error).message}`);
  }
}

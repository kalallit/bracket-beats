import * as vscode from 'vscode';
import { SpotifyClient, SearchItem } from './spotify';
import { Player } from './player';
import { Recommender } from './recommender';
import { History, ContextCache, Play } from './history';
import { Feedback } from './feedback';
import { Project } from './project';
import { FocusSession } from './focus';
import { t } from './i18n';

export interface ActionDeps {
  client: SpotifyClient;
  player: Player;
  rec: () => Recommender;
  history: History;
  contexts: ContextCache;
  feedback: Feedback;
  project: Project;
  focus: FocusSession;
  /** Momento em que esta janela arrancou, para "desde que abri o VS Code". */
  activatedAt: number;
  /** Corre uma ação com o tratamento de erros habitual (avisos, sessão perdida...). */
  guard: (fn: () => Promise<unknown>) => Promise<void>;
}

const flash = (msg: string) => vscode.window.setStatusBarMessage(msg, 3000);

// ---------- pesquisa ----------

interface SearchPick extends vscode.QuickPickItem { item?: SearchItem }

/** Pesquisa no Spotify a partir do VS Code. Enter toca; o botão "+" acrescenta à fila. */
export function search(d: ActionDeps): void {
  const qp = vscode.window.createQuickPick<SearchPick>();
  qp.title = t('search.title');
  qp.placeholder = t('search.placeholder');
  const queueButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: t('search.addQueue') };
  const groups: [SearchItem['type'], string, string][] = [
    ['track', t('search.tracks'), '$(play)'],
    ['album', t('search.albums'), '$(library)'],
    ['playlist', t('search.playlists'), '$(list-unordered)'],
    ['artist', t('search.artists'), '$(person)'],
  ];

  let seq = 0;
  let timer: NodeJS.Timeout | undefined;

  qp.onDidChangeValue((value) => {
    if (timer) { clearTimeout(timer); }
    const q = value.trim();
    const mine = ++seq;
    if (q.length < 2) { qp.items = []; qp.busy = false; return; }
    qp.busy = true;
    // Espera que a pessoa pare de escrever, para não fazer um pedido por tecla.
    timer = setTimeout(async () => {
      let items: SearchPick[];
      try {
        const res = await d.client.search(q);
        items = [];
        for (const [type, title, icon] of groups) {
          const of = res.filter((r) => r.type === type);
          if (!of.length) { continue; }
          items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
          of.forEach((r) => items.push({
            label: `${icon} ${r.name}`,
            description: r.subtitle,
            alwaysShow: true, // os resultados vêm do Spotify; o VS Code não os deve filtrar outra vez
            item: r,
            buttons: r.type === 'track' ? [queueButton] : undefined,
          }));
        }
        if (!items.length) { items = [{ label: t('search.none'), alwaysShow: true }]; }
      } catch (e) {
        items = [{ label: `$(warning) ${(e as Error).message}`, alwaysShow: true }];
      }
      if (mine === seq) { qp.items = items; qp.busy = false; }
    }, 350);
  });

  qp.onDidAccept(() => {
    const it = qp.selectedItems[0]?.item;
    if (!it) { return; }
    qp.hide();
    void d.guard(() => d.player.play(
      it.type !== 'track' ? { contextUri: it.uri }
        // Dentro do álbum, para a música seguinte fazer sentido.
        : it.albumUri ? { contextUri: it.albumUri, offsetUri: it.uri }
        : { trackUri: it.uri }));
  });

  qp.onDidTriggerItemButton((e) => {
    const it = e.item.item;
    if (!it) { return; }
    void d.guard(async () => {
      await d.player.addToQueue(it.uri);
      flash(t('search.queued', it.name));
    });
  });

  qp.onDidHide(() => { if (timer) { clearTimeout(timer); } qp.dispose(); });
  qp.show();
}

// ---------- dispositivos e fila ----------

export async function pickDevice(d: ActionDeps): Promise<void> {
  const devices = await d.client.getDevices();
  if (!devices.length) {
    vscode.window.showWarningMessage(t('err.noDevice'));
    return;
  }
  const icon = (type: string) => /phone/i.test(type) ? '$(device-mobile)' : /speaker|avr|stb|tv|cast/i.test(type) ? '$(broadcast)' : '$(device-desktop)';
  const pick = await vscode.window.showQuickPick(
    devices.map((dev) => ({
      label: `${icon(dev.type)} ${dev.name}`,
      description: dev.isActive ? t('device.active') : undefined,
      id: dev.id,
    })),
    { title: t('device.title'), placeHolder: t('device.placeholder') },
  );
  if (pick) { await d.player.transfer(pick.id); }
}

export async function showQueue(d: ActionDeps): Promise<void> {
  const items = await d.player.queue();
  if (!items.length) {
    vscode.window.showInformationMessage(t('queue.empty'));
    return;
  }
  // Só para consulta: a API do Spotify não deixa saltar para um ponto da fila.
  await vscode.window.showQuickPick(
    items.map((tr, i) => ({ label: `${i + 1}. ${tr.name}`, description: tr.artists })),
    { title: t('side.upNext'), placeHolder: t('queue.placeholder') },
  );
}

// ---------- playlist do projeto ----------

interface BindPick extends vscode.QuickPickItem { action?: 'clear'; uri?: string; name?: string; image?: string }

export async function bindProject(d: ActionDeps): Promise<void> {
  if (!d.project.key) {
    vscode.window.showInformationMessage(t('project.noWorkspace'));
    return;
  }
  const current = d.project.playlist;
  const items: BindPick[] = [];

  const ctx = d.player.state?.contextUri;
  if (ctx && ctx !== current?.uri) {
    const meta = await d.contexts.get(ctx);
    if (meta) {
      items.push({ label: `$(play) ${meta.name}`, description: t('project.nowPlaying'), uri: meta.uri, name: meta.name, image: meta.image });
    }
  }
  if (current) {
    items.push({ label: `$(close) ${t('project.clear')}`, description: current.name, action: 'clear' });
  }

  const mine = await d.rec().myPlaylists().catch(() => []);
  if (mine.length) {
    items.push({ label: t('project.yours'), kind: vscode.QuickPickItemKind.Separator });
    mine.forEach((pl) => items.push({
      label: `${pl.uri === current?.uri ? '$(pinned)' : '$(list-unordered)'} ${pl.name}`,
      description: pl.total ? t('rec.tracks', pl.total) : undefined,
      uri: pl.uri, name: pl.name, image: pl.image,
    }));
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: t('project.title', d.project.name ?? ''),
    placeHolder: t('project.placeholder'),
    matchOnDescription: true,
  });
  if (!pick) { return; }
  if (pick.action === 'clear') {
    await d.project.setPlaylist(undefined);
    flash(t('project.cleared'));
  } else if (pick.uri && pick.name) {
    await d.project.setPlaylist({ uri: pick.uri, name: pick.name, image: pick.image });
    flash(t('project.bound', pick.name));
  }
}

// ---------- guardar a sessão como playlist ----------

function uniqueTracks(plays: Play[]): string[] {
  return [...new Set(plays.map((p) => p.uri).filter((u) => u.startsWith('spotify:track:')))];
}

export async function saveSession(d: ActionDeps): Promise<void> {
  const ws = d.project.key;
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const focusFrom = d.focus.active ? d.focus.startedAt : d.focus.lastSession?.from;
  const focusTo = d.focus.active ? now : d.focus.lastSession?.to ?? now;

  const candidates: { label: string; plays: Play[] }[] = [];
  if (focusFrom) {
    candidates.push({ label: t('save.rangeFocus'), plays: (await d.history.since(focusFrom)).filter((p) => p.ts <= focusTo) });
  }
  candidates.push({ label: t('save.rangeWindow'), plays: await d.history.since(d.activatedAt) });
  if (ws) { candidates.push({ label: t('save.rangeTodayProject'), plays: await d.history.since(midnight.getTime(), ws) }); }
  candidates.push({ label: t('save.rangeToday'), plays: await d.history.since(midnight.getTime()) });
  candidates.push({ label: t('save.range2h'), plays: await d.history.since(now - 2 * 3_600_000) });

  const options = candidates
    .map((c) => ({ label: c.label, uris: uniqueTracks(c.plays) }))
    .filter((c) => c.uris.length > 0);
  if (!options.length) {
    vscode.window.showInformationMessage(t('save.none'));
    return;
  }

  const pick = await vscode.window.showQuickPick(
    options.map((o) => ({ label: o.label, description: t('rec.tracks', o.uris.length), uris: o.uris })),
    { title: t('save.title'), placeHolder: t('save.placeholder') },
  );
  if (!pick) { return; }

  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const name = await vscode.window.showInputBox({
    title: t('save.title'),
    prompt: t('save.namePrompt'),
    value: d.project.name ? `${d.project.name} · ${date}` : `VS Code · ${date}`,
    validateInput: (v) => v.trim() ? undefined : t('save.nameEmpty'),
  });
  if (!name) { return; }

  const pl = await d.client.createPlaylist(name.trim(), t('save.description'));
  await d.client.addToPlaylist(pl.id, pick.uris);
  d.rec().reset(); // a playlist nova deve aparecer nas sugestões

  const buttons = [t('save.open'), ...(ws ? [t('save.bind')] : [])];
  const choice = await vscode.window.showInformationMessage(t('save.done', name.trim(), pick.uris.length), ...buttons);
  if (choice === t('save.open') && pl.url) {
    await vscode.env.openExternal(vscode.Uri.parse(pl.url));
  } else if (choice === t('save.bind')) {
    await d.project.setPlaylist({ uri: pl.uri, name: name.trim() });
    flash(t('project.bound', name.trim()));
  }
}

// ---------- histórico e feedback ----------

export async function clearHistory(d: ActionDeps): Promise<void> {
  const n = (await d.history.all(true)).length;
  if (!n) {
    vscode.window.showInformationMessage(t('history.empty'));
    return;
  }
  const ok = await vscode.window.showWarningMessage(t('history.confirm', n), { modal: true }, t('history.clearBtn'));
  if (ok !== t('history.clearBtn')) { return; }
  await d.history.clear();
  d.rec().reset();
  flash(t('history.cleared'));
}

export async function unhidePlaylists(d: ActionDeps): Promise<void> {
  const n = await d.feedback.unhideAll();
  vscode.window.showInformationMessage(n ? t('feedback.unhidden', n) : t('feedback.noneHidden'));
}

// ---------- sessões de foco ----------

interface FocusPick extends vscode.QuickPickItem { work?: number; rest?: number; action?: 'stop' | 'skip' | 'save' }

export async function focusCommand(d: ActionDeps): Promise<void> {
  const f = d.focus;
  if (f.active) {
    const pick = await vscode.window.showQuickPick<FocusPick>([
      { label: `$(debug-step-over) ${f.phase === 'work' ? t('focus.skipToBreak') : t('focus.skipToWork')}`, action: 'skip' },
      { label: `$(debug-stop) ${t('focus.stop')}`, description: t('focus.rounds', f.rounds), action: 'stop' },
    ], { title: t('focus.title') });
    if (pick?.action === 'skip') { f.skip(); }
    if (pick?.action === 'stop') {
      f.stop();
      const choice = await vscode.window.showInformationMessage(t('focus.ended', f.rounds), t('focus.saveBtn'));
      if (choice) { await saveSession(d); }
    }
    return;
  }

  const cfg = vscode.workspace.getConfiguration('bracketBeats');
  const mine: [number, number] = [cfg.get<number>('focus.workMinutes', 25), cfg.get<number>('focus.breakMinutes', 5)];
  const presets: [number, number][] = [mine, [25, 5], [50, 10], [90, 15]];
  const seen = new Set<string>();
  const items: FocusPick[] = [];
  presets.forEach(([work, rest], i) => {
    const key = `${work}/${rest}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    items.push({
      label: `$(target) ${t('focus.preset', work, rest)}`,
      description: i === 0 ? t('focus.yourDefault') : undefined,
      work, rest,
    });
  });
  const pick = await vscode.window.showQuickPick(items, { title: t('focus.title'), placeHolder: t('focus.placeholder') });
  if (pick?.work && pick.rest) { await f.start(pick.work, pick.rest); }
}

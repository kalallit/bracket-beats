import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Player } from './player';
import { Recommender, getMoods, moodForHour, moodLabel, Card } from './recommender';
import { Feedback } from './feedback';
import { Project } from './project';
import { t, lang } from './i18n';
import { brandCss, brandHtml, brandCsp, brandRoots } from './brand';

export interface PickerDeps {
  player: Player;
  rec: Recommender;
  feedback: Feedback;
  project: Project;
  /** Chamado quando se associa uma playlist ao projeto a partir do painel. */
  onProjectChanged?: () => void;
}

let panel: vscode.WebviewPanel | undefined;

/**
 * Painel "O que te apetece ouvir?": separador "Para ti" + um separador por mood.
 * Abre-se a qualquer momento, esteja ou não a tocar música.
 */
export async function openPicker(d: PickerDeps, startTab?: string) {
  const { player, rec, feedback, project } = d;
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    if (startTab) { panel.webview.postMessage({ type: 'select', tab: startTab }); }
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'bracketBeats.picker',
    t('picker.tab'),
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: brandRoots() }
  );
  panel.iconPath = new vscode.ThemeIcon('sparkle');
  panel.onDidDispose(() => { panel = undefined; });

  const p = panel;
  const cache = new Map<string, Card[]>();
  let nowUri: string | undefined;

  const send = (msg: unknown) => { p.webview.postMessage(msg); };

  const load = async (tab: string, shuffle = false) => {
    if (shuffle) { cache.delete(tab); }
    if (cache.has(tab)) { send({ type: 'results', tab, cards: cache.get(tab) }); return; }
    send({ type: 'loading', tab });
    try {
      const cards = tab === 'foryou' ? await rec.forYou(nowUri, shuffle) : await rec.forMood(tab, nowUri, shuffle);
      cache.set(tab, cards);
      send({ type: 'results', tab, cards });
      // Conta como "vistas" as do topo; as que aparecem muito e nunca escolhes vão descendo.
      void feedback.shown(cards.filter((c) => !c.pinned).slice(0, 8).map((c) => c.uri));
    } catch (e) {
      send({ type: 'error', tab, message: (e as Error).message });
    }
  };

  p.webview.onDidReceiveMessage(async (msg) => {
    switch (msg?.type) {
      case 'ready': {
        await feedback.load();
        const now = player.state;
        const name = await rec.userName().catch(() => '');
        nowUri = now?.contextUri;
        send({
          type: 'init',
          name,
          hour: new Date().getHours(),
          moods: getMoods().map(({ id, emoji, color }) => ({ id, emoji, label: moodLabel(id), color })),
          canPin: !!project.key,
          strings: {
            morning: t('picker.morning'), afternoon: t('picker.afternoon'), evening: t('picker.evening'),
            forYou: t('picker.forYou'), nowPlaying: t('picker.nowPlaying'),
            nowTag: t('picker.nowTag'), nowTagTip: t('picker.nowTagTip'),
            emptyTitle: t('picker.emptyTitle'), emptyForYou: t('picker.emptyForYou'), emptyMood: t('picker.emptyMood'),
            shuffle: t('picker.shuffle'), shuffleTip: t('picker.shuffleTip'),
            hide: t('picker.hide'), hidden: t('picker.hidden'), pin: t('picker.pin'),
            playTip: t('picker.playTip', '{0}'), playing: t('picker.playing'), error: t('picker.error', '{0}'),
          },
          suggestedMood: moodForHour(new Date().getHours()),
          nowPlaying: now?.isPlaying ? { title: now.title, artists: now.artists } : undefined,
          startTab: startTab ?? 'foryou',
        });
        break;
      }
      case 'tab':
        await load(String(msg.tab));
        break;
      case 'shuffle':
        await load(String(msg.tab), true);
        break;
      case 'play':
        try {
          await player.play({ contextUri: String(msg.uri) });
          send({ type: 'played', uri: msg.uri });
          void feedback.played(String(msg.uri));
          setTimeout(() => p.dispose(), 900);
        } catch (e) {
          send({ type: 'toast', message: (e as Error).message });
        }
        break;
      case 'hide':
        await feedback.hide(String(msg.uri));
        cache.forEach((cards, tab) => cache.set(tab, cards.filter((c) => c.uri !== msg.uri)));
        break;
      case 'pin':
        await project.setPlaylist({ uri: String(msg.uri), name: String(msg.name), image: msg.image ? String(msg.image) : undefined });
        cache.delete('foryou'); // a playlist do projeto passa a aparecer primeiro
        d.onProjectChanged?.();
        send({ type: 'toast', message: t('project.bound', String(msg.name)) });
        break;
      case 'close':
        p.dispose();
        break;
    }
  });

  p.webview.html = html(p.webview);
}

function html(webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return /* html */ `<!doctype html>
<html lang="${lang()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src https: ${brandCsp(webview)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --green: #3ee6b4; /* cor da marca (ícone) */
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
    --line: color-mix(in srgb, var(--fg) 10%, transparent);
    --tile: color-mix(in srgb, var(--fg) 4%, transparent);
    --accent: var(--green);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family);
    padding: 40px clamp(16px, 5vw, 56px) 56px;
  }
  /* brilho da cor do mood no topo */
  .glow {
    position: fixed; left: 0; right: 0; top: 0; height: 320px;
    background: radial-gradient(ellipse 70% 100% at 30% 0%, color-mix(in srgb, var(--accent) 28%, transparent), transparent 70%);
    pointer-events: none;
    transition: background .5s ease;
    z-index: 0;
  }
  main { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; }

  header { margin-bottom: 24px; position: relative; }
  header .attr { position: absolute; top: 0; right: 0; }
  ${brandCss(24)}
  .eyebrow { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
  h1 { margin: 0; font-size: clamp(24px, 3.2vw, 34px); font-weight: 800; letter-spacing: -.01em; }
  .now {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 14px; padding: 6px 12px 6px 10px;
    border-radius: 999px; font-size: 12px;
    background: var(--tile); border: 1px solid var(--line);
    max-width: 100%;
  }
  .now span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: none; animation: pulse 1.6s ease-in-out infinite; }

  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 28px; align-items: center; }
  .shuffle { margin-left: auto; background: transparent; color: var(--muted); }
  .shuffle:hover { color: var(--fg); border-color: var(--line); }
  .shuffle .ic { display: inline-block; transition: transform .4s ease; }
  .shuffle:hover .ic { transform: rotate(180deg); }
  .chip {
    font: inherit; font-size: 13px; cursor: pointer;
    padding: 8px 14px; border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--tile); color: var(--fg);
    transition: background .15s, border-color .15s, transform .12s;
    position: relative;
  }
  .chip:hover { border-color: color-mix(in srgb, var(--c) 60%, transparent); }
  .chip:active { transform: scale(.96); }
  .chip[aria-pressed="true"] {
    background: var(--c); border-color: var(--c); color: #0b0b0b; font-weight: 600;
  }
  .chip .tag {
    position: absolute; top: -7px; right: -4px;
    font-size: 9px; padding: 1px 5px; border-radius: 999px;
    background: var(--fg); color: var(--bg); font-weight: 700; letter-spacing: .03em;
  }
  .chip:focus-visible, .tile:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: 20px 18px;
  }
  .tile {
    cursor: pointer;
    display: flex; flex-direction: column; gap: 4px;
    padding: 12px; margin: -12px; border-radius: 12px;
    transition: background .15s;
    animation: fade .35s ease both;
  }
  .tile:hover { background: var(--tile); }
  .cover { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; margin-bottom: 8px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 70%, #000), #111);
    box-shadow: 0 8px 24px rgba(0,0,0,.3); }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cover .ph { position: absolute; inset: 0; display: grid; place-items: center; font-size: 42px; color: #fff9; }
  .fab {
    position: absolute; right: 8px; bottom: 8px;
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--green); color: #062a20;
    display: grid; place-items: center;
    box-shadow: 0 8px 18px rgba(0,0,0,.4);
    opacity: 0; transform: translateY(8px);
    transition: opacity .2s, transform .2s;
  }
  .fab svg { width: 18px; height: 18px; margin-left: 2px; }
  .tile:hover .fab, .tile:focus-visible .fab, .tile.playing .fab { opacity: 1; transform: none; }
  .acts { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
  .tile:hover .acts, .tile:focus-within .acts { opacity: 1; }
  .act {
    all: unset; cursor: pointer; width: 26px; height: 26px; border-radius: 50%;
    display: grid; place-items: center; font-size: 12px;
    background: rgba(0,0,0,.62); color: #fff;
  }
  .act:hover { background: rgba(0,0,0,.85); }
  .act:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
  .tile.gone { opacity: 0; transform: scale(.94); transition: opacity .2s, transform .2s; }
  .tile.playing .fab { animation: pop .35s ease; }
  .name { font-weight: 600; font-size: 14px; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .reason { font-size: 11px; color: var(--accent); display: flex; align-items: center; gap: 5px; margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; filter: brightness(1.15); }
  .reason::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }

  .sk .cover { background: var(--tile); box-shadow: none; }
  .sk .bar { height: 10px; border-radius: 4px; background: var(--tile); margin-top: 6px; }
  .sk .cover, .sk .bar { animation: shimmer 1.2s ease-in-out infinite; }

  .empty { grid-column: 1 / -1; text-align: center; padding: 60px 0; color: var(--muted); }
  .empty b { display: block; font-size: 16px; color: var(--fg); margin-bottom: 6px; }

  .toast {
    position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px);
    background: var(--fg); color: var(--bg); padding: 10px 16px; border-radius: 8px; font-size: 13px;
    opacity: 0; transition: opacity .2s, transform .2s; z-index: 5; max-width: calc(100% - 32px);
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }

  @keyframes pulse { 50% { opacity: .35; } }
  @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes pop { 50% { transform: scale(1.15); } }
  @keyframes shimmer { 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
  <div class="glow"></div>
  <main>
    <header>
      <div class="attr">${brandHtml(webview)}</div>
      <p class="eyebrow" id="hello">&nbsp;</p>
      <h1>${escHtml(t('picker.h1'))}</h1>
      <div id="now"></div>
    </header>
    <nav class="chips" id="chips" aria-label="${escHtml(t('picker.moods'))}"></nav>
    <section class="grid" id="grid" aria-live="polite"></section>
  </main>
  <div class="toast" id="toast" role="status"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l12.5-7.5a1 1 0 0 0 0-1.74L8.5 3.63A1 1 0 0 0 7 4.5z"/></svg>';
  const FOR_YOU = { id: 'foryou', emoji: '✨', label: '', color: '#3ee6b4' };
  let S = {};
  const fill = (s, v) => s.replace('{0}', v);

  let tabs = [FOR_YOU];
  let current = 'foryou';
  let canPin = false;

  function greet(h, name) {
    const g = h < 6 ? S.evening : h < 12 ? S.morning : h < 20 ? S.afternoon : S.evening;
    return name ? g + ', ' + name : g;
  }

  function renderChips(suggested) {
    const nav = $('chips'); nav.innerHTML = '';
    tabs.forEach((t) => {
      const b = el('button', 'chip', t.emoji + '  ' + t.label);
      b.style.setProperty('--c', t.color);
      b.setAttribute('aria-pressed', String(t.id === current));
      if (t.id === suggested) { const tag = el('span', 'tag', S.nowTag); tag.title = S.nowTagTip; b.appendChild(tag); }
      b.onclick = () => select(t.id);
      nav.appendChild(b);
    });
    // Botão para baralhar: volta a pedir sugestões com um pouco de aleatoriedade.
    const sh = el('button', 'chip shuffle');
    const ic = el('span', 'ic', '🔀'); sh.append(ic, document.createTextNode('  ' + S.shuffle));
    sh.title = S.shuffleTip;
    sh.onclick = () => vscode.postMessage({ type: 'shuffle', tab: current });
    nav.appendChild(sh);
  }

  function select(id) {
    current = id;
    const t = tabs.find((x) => x.id === id) || FOR_YOU;
    document.documentElement.style.setProperty('--accent', t.color);
    document.querySelectorAll('.chip:not(.shuffle)').forEach((c, i) => c.setAttribute('aria-pressed', String(tabs[i].id === id)));
    vscode.postMessage({ type: 'tab', tab: id });
  }

  function skeleton() {
    const g = $('grid'); g.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const s = el('div', 'tile sk'); s.style.cursor = 'default';
      s.appendChild(el('div', 'cover'));
      const b1 = el('div', 'bar'); b1.style.width = '80%';
      const b2 = el('div', 'bar'); b2.style.width = '50%';
      s.append(b1, b2); g.appendChild(s);
    }
  }

  function renderCards(cards) {
    const g = $('grid'); g.innerHTML = '';
    if (!cards.length) {
      const e = el('div', 'empty');
      e.appendChild(el('b', null, S.emptyTitle));
      e.appendChild(document.createTextNode(current === 'foryou' ? S.emptyForYou : S.emptyMood));
      g.appendChild(e);
      return;
    }
    cards.forEach((c, i) => {
      const t = el('div', 'tile');
      t.setAttribute('role', 'button'); t.tabIndex = 0;
      t.style.animationDelay = Math.min(i * 30, 300) + 'ms';
      t.title = fill(S.playTip, c.name);
      const cov = el('div', 'cover');
      if (c.image) { const img = el('img'); img.src = c.image; img.alt = ''; img.loading = 'lazy'; cov.appendChild(img); }
      else { cov.appendChild(el('div', 'ph', '♪')); }
      const fab = el('div', 'fab'); fab.innerHTML = PLAY; cov.appendChild(fab);
      // Ações por cima da capa: associar ao projeto e esconder das sugestões.
      const acts = el('div', 'acts');
      if (canPin && !c.pinned) {
        const pin = el('button', 'act', '📌'); pin.title = S.pin;
        pin.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'pin', uri: c.uri, name: c.name, image: c.image }); };
        acts.appendChild(pin);
      }
      if (!c.pinned) {
        const hide = el('button', 'act', '✕'); hide.title = S.hide;
        hide.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'hide', uri: c.uri });
          t.classList.add('gone'); setTimeout(() => t.remove(), 200);
          toast(S.hidden);
        };
        acts.appendChild(hide);
      }
      cov.appendChild(acts);
      t.appendChild(cov);
      t.appendChild(el('div', 'name', c.name));
      t.appendChild(el('div', 'sub', c.subtitle));
      if (c.reason) { t.appendChild(el('div', 'reason', c.reason)); }
      const play = () => { t.classList.add('playing'); vscode.postMessage({ type: 'play', uri: c.uri }); };
      t.onclick = play;
      t.onkeydown = (e) => { if (e.target === t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); play(); } };
      g.appendChild(t);
    });
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      S = m.strings; FOR_YOU.label = S.forYou; canPin = !!m.canPin;
      $('hello').textContent = greet(m.hour, m.name);
      if (m.nowPlaying) {
        const n = el('div', 'now'); n.appendChild(el('i', 'dot'));
        n.appendChild(el('span', null, S.nowPlaying + ' · ' + m.nowPlaying.title + ' — ' + m.nowPlaying.artists));
        $('now').appendChild(n);
      }
      tabs = [FOR_YOU, ...m.moods];
      current = m.startTab;
      renderChips(m.suggestedMood);
      select(m.startTab);
    }
    if (m.type === 'select') { select(m.tab); }
    if (m.tab && m.tab !== current) { return; } // resposta de um separador antigo
    if (m.type === 'loading') { skeleton(); }
    if (m.type === 'results') { renderCards(m.cards); }
    if (m.type === 'error') { renderCards([]); toast(fill(S.error, m.message)); }
    if (m.type === 'played') { toast(S.playing); }
    if (m.type === 'toast') { document.querySelectorAll('.tile.playing').forEach((t) => t.classList.remove('playing')); toast(m.message); }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') vscode.postMessage({ type: 'close' }); });
  skeleton();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

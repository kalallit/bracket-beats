import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { SpotifyAuth } from './auth';
import { Player } from './player';
import { FocusSession } from './focus';
import { Project } from './project';
import { TrackLite } from './spotify';
import { t, lang } from './i18n';
import { brandCss, brandHtml, brandCsp, brandRoots } from './brand';

/** Mensagens do painel que correspondem diretamente a um comando. */
const COMMANDS: Record<string, string> = {
  toggle: 'bracketBeats.togglePlay',
  next: 'bracketBeats.next',
  prev: 'bracketBeats.previous',
  like: 'bracketBeats.toggleLike',
  shuffle: 'bracketBeats.toggleShuffle',
  repeat: 'bracketBeats.cycleRepeat',
  device: 'bracketBeats.pickDevice',
  picker: 'bracketBeats.openPicker',
  search: 'bracketBeats.search',
  focus: 'bracketBeats.focus',
  project: 'bracketBeats.bindProject',
  login: 'bracketBeats.login',
};

/** Player na barra lateral: capa, controlos, volume, dispositivo e as próximas músicas. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'bracketBeats.player';

  private view: vscode.WebviewView | undefined;
  private queue: TrackLite[] = [];
  private queueKey = '';

  constructor(
    private readonly auth: SpotifyAuth,
    private readonly player: Player,
    private readonly focus: FocusSession,
    private readonly project: Project,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: brandRoots() };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => { void this.update(); });
    view.onDidDispose(() => { this.view = undefined; });
  }

  /** Recarrega o HTML (por exemplo quando muda o idioma). */
  reload(): void {
    if (this.view) { this.view.webview.html = this.html(); }
  }

  private onMessage(m: any): void {
    if (m?.type === 'ready') { void this.update(); return; }
    if (m?.type === 'seek' && typeof m.ms === 'number') { void vscode.commands.executeCommand('bracketBeats.seek', m.ms); return; }
    if (m?.type === 'volume' && typeof m.pct === 'number') { void vscode.commands.executeCommand('bracketBeats.setVolume', m.pct); return; }
    const cmd = COMMANDS[m?.type];
    if (cmd) { void vscode.commands.executeCommand(cmd); }
  }

  /** Envia o estado atual para o painel, se estiver visível. */
  async update(): Promise<void> {
    if (!this.view?.visible) { return; }
    const loggedIn = await this.auth.isLoggedIn();
    const key = this.player.queueKey;
    this.post(loggedIn, key === this.queueKey ? this.queue : []);

    // A fila só se pede quando muda a música (ou quando se acrescenta algo).
    if (loggedIn && this.player.state && key !== this.queueKey) {
      this.queueKey = key;
      try { this.queue = await this.player.queue(); } catch { this.queue = []; }
      if (this.player.queueKey === key) { this.post(loggedIn, this.queue); }
    }
  }

  private post(loggedIn: boolean, queue: TrackLite[]): void {
    const s = this.player.state;
    void this.view?.webview.postMessage({
      type: 'state',
      loggedIn,
      needsReauth: this.auth.needsReauth,
      state: s ? { ...s, progressMs: this.player.progressNow() } : undefined,
      liked: this.player.liked,
      queue: queue.slice(0, 8),
      focus: this.focus.active ? { phase: this.focus.phase, endsAt: this.focus.endsAt } : undefined,
      hasWorkspace: !!this.project.key,
      projectPlaylist: this.project.playlist?.name,
    });
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const S = {
      connect: t('side.connect'), connectHint: t('side.connectHint'), reauthHint: t('sb.reauthTip'),
      idle: t('card.nothing'), idleHint: t('side.idleHint'),
      suggestions: t('side.suggestions'), search: t('side.search'), focus: t('side.focus'), project: t('side.project'),
      upNext: t('side.upNext'), like: t('sb.like'), unlike: t('sb.unlike'),
      shuffle: t('side.shuffle'), repeat: t('side.repeat'), prev: t('sb.prev'), next: t('sb.next'),
      play: t('qp.play'), pause: t('side.pause'), volume: t('side.volume'), device: t('side.device'),
      noVolume: t('side.noVolume'),
    };
    const strings = JSON.stringify(S).replace(/</g, '\\u003c');

    return /* html */ `<!doctype html>
<html lang="${lang()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src https: data: ${brandCsp(this.view?.webview)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --green: #3ee6b4; /* cor da marca (ícone) */
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --line: color-mix(in srgb, var(--fg) 12%, transparent);
    --tile: color-mix(in srgb, var(--fg) 6%, transparent);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 14px 14px 20px;
    color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px;
    background: transparent;
  }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
  button:focus-visible, .bar:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  svg { width: 18px; height: 18px; display: block; }
  .stroke { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  /* estados vazios */
  .empty { text-align: center; padding: 28px 8px; color: var(--muted); }
  .empty .big { font-size: 34px; margin-bottom: 10px; }
  .empty b { display: block; color: var(--fg); font-size: 14px; margin-bottom: 6px; }
  .cta {
    margin-top: 16px; padding: 9px 18px; border-radius: 999px;
    background: var(--green); color: #062a20; font-weight: 700;
  }
  .cta:hover { filter: brightness(1.08); }

  /* a tocar */
  .art {
    width: 100%; max-width: 320px; aspect-ratio: 1; margin: 0 auto 14px;
    border-radius: 10px; overflow: hidden;
    background: linear-gradient(135deg, #1a2130, #0d1017);
    box-shadow: 0 10px 28px rgba(0,0,0,.35);
    display: grid; place-items: center; font-size: 56px; color: var(--green);
  }
  .art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .head { display: flex; align-items: center; gap: 10px; max-width: 320px; margin: 0 auto; }
  .meta { min-width: 0; flex: 1; }
  .title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .artist { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .icon { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); flex: none; position: relative; }
  .icon:hover { color: var(--fg); background: var(--tile); }
  .icon.on { color: var(--green); }
  .icon.on::after { content: ''; position: absolute; bottom: 2px; width: 4px; height: 4px; border-radius: 50%; background: var(--green); }
  #like.on::after { display: none; }
  #like.on svg { fill: currentColor; }
  .icon .one { position: absolute; top: 3px; right: 3px; font-size: 9px; font-weight: 700; }

  .progress { max-width: 320px; margin: 14px auto 0; }
  .bar { height: 14px; display: flex; align-items: center; cursor: pointer; }
  .track { flex: 1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
  .fill { height: 100%; width: 0; background: var(--fg); border-radius: 2px; }
  .bar:hover .fill { background: var(--green); }
  .times { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .controls { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 8px; }
  .controls .skip { color: var(--fg); }
  .controls .skip svg { width: 20px; height: 20px; }
  #play {
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--fg); color: var(--vscode-sideBar-background, #1f1f1f);
    display: grid; place-items: center; margin: 0 4px;
    transition: transform .12s;
  }
  #play:hover { transform: scale(1.06); }
  #play:active { transform: scale(.96); }
  #play svg { width: 20px; height: 20px; }

  .volrow { display: flex; align-items: center; gap: 8px; max-width: 320px; margin: 12px auto 0; color: var(--muted); }
  /* Volume desenhado à medida: fino como a barra de progresso, sem a caixa de foco do VS Code. */
  .volrow input[type=range] {
    -webkit-appearance: none; appearance: none;
    flex: 1; min-width: 0; height: 14px; margin: 0; padding: 0;
    background: transparent; cursor: pointer;
    outline: none !important; border: 0 !important;
    --p: 50%;
  }
  .volrow input[type=range]::-webkit-slider-runnable-track {
    height: 4px; border-radius: 2px;
    background: linear-gradient(to right, var(--fg) var(--p), var(--line) var(--p));
  }
  .volrow input[type=range]:hover::-webkit-slider-runnable-track {
    background: linear-gradient(to right, var(--green) var(--p), var(--line) var(--p));
  }
  .volrow input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 12px; height: 12px; margin-top: -4px; border-radius: 50%;
    background: var(--fg); border: 0;
    opacity: 0; transition: opacity .12s, transform .12s;
  }
  .volrow input[type=range]:hover::-webkit-slider-thumb,
  .volrow input[type=range]:active::-webkit-slider-thumb { opacity: 1; }
  .volrow input[type=range]:active::-webkit-slider-thumb { transform: scale(1.15); }
  .volrow input[type=range]:focus-visible::-webkit-slider-thumb {
    opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
  }
  .volrow input[type=range]:disabled { opacity: .35; cursor: default; }
  .volrow input[type=range]:disabled::-webkit-slider-thumb { opacity: 0; }
  .dev {
    display: inline-flex; align-items: center; gap: 6px; max-width: 46%;
    padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; color: var(--muted);
  }
  .dev:hover { color: var(--fg); border-color: var(--fg); }
  .dev span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dev svg { width: 13px; height: 13px; flex: none; }

  /* fila */
  h3 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; font-weight: 600; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
  li img, li .ph { width: 34px; height: 34px; border-radius: 4px; flex: none; object-fit: cover; background: var(--tile); }
  li .qt { min-width: 0; }
  li .qn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li .qa { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* atalhos */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 22px; }
  .chip {
    padding: 6px 11px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--tile); font-size: 12px; max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .chip:hover { border-color: var(--green); }
  .chip.on { border-color: var(--green); color: var(--green); font-variant-numeric: tabular-nums; }
  .attr { max-width: 320px; margin: -4px auto 12px; }
  ${brandCss(22)}
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <section id="out" class="empty" hidden>
    <div class="big">🎧</div>
    <b id="outTitle"></b>
    <span id="outHint"></span><br>
    <button class="cta" data-msg="login" id="outBtn"></button>
  </section>

  <section id="idle" class="empty" hidden>
    <div class="big">🌙</div>
    <b id="idleTitle"></b>
    <span id="idleHint"></span><br>
    <button class="cta" data-msg="picker" id="idleBtn"></button>
  </section>

  <section id="np" hidden>
    <div class="art" id="art">♪</div>
    <div class="attr">${brandHtml(this.view?.webview)}</div>
    <div class="head">
      <div class="meta">
        <div class="title" id="title"></div>
        <div class="artist" id="artist"></div>
      </div>
      <button class="icon" id="like" data-msg="like">
        <svg viewBox="0 0 24 24" class="stroke"><path d="M12 20.5s-7.5-4.4-9.4-9.2C1.2 7.8 3.2 4.5 6.6 4.5c2.2 0 3.7 1.2 5.4 3.2 1.7-2 3.2-3.2 5.4-3.2 3.4 0 5.4 3.3 4 6.8-1.9 4.8-9.4 9.2-9.4 9.2z"/></svg>
      </button>
    </div>

    <div class="progress">
      <div class="bar" id="bar" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100">
        <div class="track"><div class="fill" id="fill"></div></div>
      </div>
      <div class="times"><span id="cur">0:00</span><span id="dur">0:00</span></div>
    </div>

    <div class="controls">
      <button class="icon" id="shuffle" data-msg="shuffle">
        <svg viewBox="0 0 24 24" class="stroke"><path d="M3 7h3c2 0 3.300 1 4.400 2.700l3.200 4.600C14.700 16 16 17 18 17h3"/><path d="M18 14l3 3-3 3"/><path d="M3 17h3c1.300 0 2.300-.4 3.100-1.200"/><path d="M14.900 8.200C15.700 7.400 16.700 7 18 7h3"/><path d="M18 4l3 3-3 3"/></svg>
      </button>
      <button class="icon skip" id="prev" data-msg="prev">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 5.500v13a.8.8 0 0 1-1.300.600L9 12.600a.8.8 0 0 1 0-1.200l8.700-6.500a.8.8 0 0 1 1.300.600z"/><rect x="5" y="5" width="2.400" height="14" rx="1"/></svg>
      </button>
      <button id="play" data-msg="toggle"></button>
      <button class="icon skip" id="next" data-msg="next">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5.500v13a.8.8 0 0 0 1.300.600L15 12.600a.8.8 0 0 0 0-1.200L6.300 4.900A.8.8 0 0 0 5 5.500z"/><rect x="16.600" y="5" width="2.400" height="14" rx="1"/></svg>
      </button>
      <button class="icon" id="repeat" data-msg="repeat">
        <svg viewBox="0 0 24 24" class="stroke"><path d="M17 2.500l3.500 3.500L17 9.500"/><path d="M3.500 11.500V9a3 3 0 0 1 3-3h14"/><path d="M7 21.500L3.500 18 7 14.500"/><path d="M20.500 12.500V15a3 3 0 0 1-3 3h-14"/></svg>
        <span class="one" id="one" hidden>1</span>
      </button>
    </div>

    <div class="volrow">
      <svg viewBox="0 0 24 24" class="stroke" style="flex:none"><path d="M4 9.500v5h3.500l4.500 4v-13l-4.500 4z"/><path d="M16 9a4.500 4.500 0 0 1 0 6"/></svg>
      <input type="range" id="vol" min="0" max="100" step="1">
      <button class="dev" id="dev" data-msg="device">
        <svg viewBox="0 0 24 24" class="stroke"><rect x="3" y="4.500" width="18" height="12" rx="1.500"/><path d="M8.500 20h7M12 16.500V20"/></svg>
        <span id="devName"></span>
      </button>
    </div>

    <div id="queueBox" hidden>
      <h3 id="upNext"></h3>
      <ol id="queue"></ol>
    </div>
  </section>

  <nav class="chips" id="chips" hidden>
    <button class="chip" data-msg="picker" id="cSug"></button>
    <button class="chip" data-msg="search" id="cSearch"></button>
    <button class="chip" data-msg="focus" id="cFocus"></button>
    <button class="chip" data-msg="project" id="cProj"></button>
  </nav>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const S = ${strings};
  const $ = (id) => document.getElementById(id);
  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.200v13.600a.8.8 0 0 0 1.200.700l11-6.800a.8.8 0 0 0 0-1.400l-11-6.800A.8.8 0 0 0 8 5.200z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.200" height="14" rx="1"/><rect x="13.800" y="5" width="4.200" height="14" rx="1"/></svg>';
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  // textos fixos
  $('outBtn').textContent = S.connect;
  $('idleTitle').textContent = S.idle; $('idleHint').textContent = S.idleHint; $('idleBtn').textContent = S.suggestions;
  $('upNext').textContent = S.upNext;
  $('cSug').textContent = '✨ ' + S.suggestions; $('cSearch').textContent = '🔎 ' + S.search;
  $('prev').title = S.prev; $('next').title = S.next; $('shuffle').title = S.shuffle; $('repeat').title = S.repeat;
  $('vol').setAttribute('aria-label', S.volume); $('dev').title = S.device;

  document.querySelectorAll('[data-msg]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: b.dataset.msg })));

  let st = null;       // último estado recebido
  let t0 = 0;          // quando chegou, no relógio da página
  let focus = null;
  let dragging = false;
  let lastCover = null;

  function progress() {
    if (!st) return 0;
    const p = st.isPlaying ? st.progressMs + (performance.now() - t0) : st.progressMs;
    return Math.min(st.durationMs, p);
  }

  function paintProgress() {
    if (st) {
      const p = progress();
      $('fill').style.width = (st.durationMs ? (p / st.durationMs) * 100 : 0) + '%';
      $('cur').textContent = fmt(p);
      $('bar').setAttribute('aria-valuenow', String(Math.round(st.durationMs ? (p / st.durationMs) * 100 : 0)));
    }
    if (focus) {
      const left = Math.max(0, Math.ceil((focus.endsAt - Date.now()) / 1000));
      $('cFocus').textContent = (focus.phase === 'work' ? '🎯 ' : '☕ ') + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }
  }
  setInterval(paintProgress, 500);

  $('bar').addEventListener('click', (e) => {
    if (!st || !st.durationMs) return;
    const r = $('bar').getBoundingClientRect();
    const ms = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * st.durationMs);
    st.progressMs = ms; t0 = performance.now(); paintProgress();
    vscode.postMessage({ type: 'seek', ms });
  });
  $('bar').addEventListener('keydown', (e) => {
    if (!st || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const ms = Math.min(st.durationMs, Math.max(0, progress() + (e.key === 'ArrowRight' ? 5000 : -5000)));
    st.progressMs = ms; t0 = performance.now(); paintProgress();
    vscode.postMessage({ type: 'seek', ms });
  });

  const vol = $('vol');
  const paintVol = () => vol.style.setProperty('--p', vol.value + '%');
  vol.addEventListener('input', () => { dragging = true; paintVol(); });
  vol.addEventListener('change', () => { dragging = false; vscode.postMessage({ type: 'volume', pct: Number(vol.value) }); });

  function render(m) {
    st = m.state || null; t0 = performance.now(); focus = m.focus || null;

    $('out').hidden = m.loggedIn;
    $('idle').hidden = !m.loggedIn || !!st;
    $('np').hidden = !m.loggedIn || !st;
    $('chips').hidden = !m.loggedIn;
    if (!m.loggedIn) {
      $('outTitle').textContent = S.connect;
      $('outHint').textContent = m.needsReauth ? S.reauthHint : S.connectHint;
      return;
    }

    $('cFocus').classList.toggle('on', !!focus);
    if (!focus) $('cFocus').textContent = '🎯 ' + S.focus;
    $('cProj').hidden = !m.hasWorkspace;
    $('cProj').textContent = '📌 ' + (m.projectPlaylist || S.project);
    $('cProj').classList.toggle('on', !!m.projectPlaylist);
    paintProgress();
    if (!st) return;

    if (st.image !== lastCover) {
      lastCover = st.image;
      const art = $('art'); art.textContent = '';
      if (st.image) { const img = document.createElement('img'); img.src = st.image; img.alt = ''; art.appendChild(img); }
      else { art.textContent = '♪'; }
    }
    $('title').textContent = st.title; $('title').title = st.title;
    $('artist').textContent = st.artists; $('artist').title = st.album ? st.artists + ' · ' + st.album : st.artists;
    $('dur').textContent = fmt(st.durationMs);

    $('play').innerHTML = st.isPlaying ? ICON_PAUSE : ICON_PLAY;
    $('play').title = st.isPlaying ? S.pause : S.play;
    $('like').hidden = st.type !== 'track';
    $('like').classList.toggle('on', !!m.liked);
    $('like').title = m.liked ? S.unlike : S.like;
    $('shuffle').classList.toggle('on', !!st.shuffle);
    $('repeat').classList.toggle('on', st.repeat !== 'off');
    $('one').hidden = st.repeat !== 'track';

    const d = st.device;
    $('devName').textContent = d ? d.name : S.device;
    const canVol = !!d && d.supportsVolume && typeof d.volume === 'number';
    vol.disabled = !canVol;
    vol.title = canVol ? S.volume : S.noVolume;
    if (canVol && !dragging) vol.value = String(d.volume);
    paintVol();

    const q = m.queue || [];
    $('queueBox').hidden = q.length === 0;
    const ol = $('queue'); ol.textContent = '';
    q.forEach((tr) => {
      const li = document.createElement('li');
      if (tr.image) { const img = document.createElement('img'); img.src = tr.image; img.alt = ''; img.loading = 'lazy'; li.appendChild(img); }
      else { const ph = document.createElement('div'); ph.className = 'ph'; li.appendChild(ph); }
      const box = document.createElement('div'); box.className = 'qt';
      const n = document.createElement('div'); n.className = 'qn'; n.textContent = tr.name;
      const a = document.createElement('div'); a.className = 'qa'; a.textContent = tr.artists;
      box.append(n, a); li.appendChild(box); ol.appendChild(li);
    });
  }

  window.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'state') render(ev.data); });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

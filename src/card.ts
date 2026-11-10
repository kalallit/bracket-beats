import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Suggestion } from './spotify';
import { t, lang } from './i18n';
import { brandCss, brandHtml, brandCsp, brandRoots } from './brand';

/**
 * Mostra a sugestão num separador do editor, como um cartão com a capa.
 * Resolve 'play', 'more' (abrir o painel de moods) ou 'later' (fechou/recusou).
 */
export type CardChoice = 'play' | 'more' | 'later';

export function showSuggestionCard(s: Suggestion | undefined): Promise<CardChoice> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'bracketBeats.suggestion',
      'Bracket Beats',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: brandRoots() }
    );
    panel.iconPath = new vscode.ThemeIcon('play-circle');

    let done = false;
    const finish = (choice: CardChoice) => {
      if (done) { return; }
      done = true;
      resolve(choice);
      panel.dispose();
    };

    panel.webview.onDidReceiveMessage((msg) =>
      finish(msg?.type === 'play' ? 'play' : msg?.type === 'more' ? 'more' : 'later'));
    panel.onDidDispose(() => { if (!done) { done = true; resolve('later'); } });

    panel.webview.html = renderCardHtml(s, panel.webview);
  });
}

export function renderCardHtml(s: Suggestion | undefined, webview?: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const name = esc(s?.name ?? t('card.resume'));
  const kind = esc(s?.kind ?? '');
  const subtitle = esc(s?.subtitle ?? '');
  const img = s?.imageUrl ? esc(s.imageUrl) : '';

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
    --green-hover: #6cf0c9;
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --bg: var(--vscode-editor-background);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family);
    display: grid;
    place-items: center;
    overflow: hidden;
    position: relative;
  }

  /* Capa desfocada a encher o fundo, bem suave */
  .backdrop {
    position: fixed; inset: -80px;
    background: ${img ? `url("${img}") center / cover` : 'radial-gradient(circle at 30% 30%, #3ee6b433, transparent 60%)'};
    filter: blur(70px) saturate(1.3);
    opacity: .28;
    pointer-events: none;
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 40px 48px 32px;
    max-width: 420px;
    width: calc(100% - 32px);
    border-radius: 20px;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(20px);
    border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent);
    box-shadow: 0 24px 60px rgba(0,0,0,.35);
    animation: rise .45s cubic-bezier(.2,.8,.2,1) both;
  }

  .cover {
    width: 200px; height: 200px;
    border-radius: 12px;
    object-fit: cover;
    box-shadow: 0 16px 40px rgba(0,0,0,.45);
    margin-bottom: 28px;
    animation: pop .55s .08s cubic-bezier(.2,.8,.2,1) both;
  }
  .cover.placeholder {
    display: grid; place-items: center;
    background: linear-gradient(135deg, #1a2130, #0d1017);
    font-size: 72px; color: var(--green);
  }

  .eyebrow {
    font-size: 11px;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 8px;
  }
  h1 {
    font-size: 26px;
    line-height: 1.2;
    font-weight: 700;
    margin: 0 0 6px;
    word-break: break-word;
  }
  .subtitle {
    color: var(--muted);
    font-size: 14px;
    margin: 0 0 28px;
    min-height: 1em;
  }

  .actions { display: flex; gap: 12px; align-items: center; }
  button {
    font: inherit;
    border: none;
    cursor: pointer;
    border-radius: 999px;
    transition: transform .12s ease, background .15s ease, color .15s ease;
  }
  button:active { transform: scale(.96); }
  button:focus-visible { outline: 2px solid color-mix(in srgb, var(--green) 55%, transparent); outline-offset: 3px; }

  .play {
    display: inline-flex; align-items: center; gap: 10px;
    background: var(--green);
    color: #062a20;
    font-weight: 700;
    font-size: 15px;
    padding: 12px 28px 12px 22px;
  }
  .play:hover { background: var(--green-hover); transform: scale(1.04); }
  .play svg { width: 18px; height: 18px; }

  .later {
    background: transparent;
    color: var(--muted);
    font-size: 14px;
    padding: 12px 16px;
  }
  .later:hover { color: var(--fg); }

  .more {
    margin-top: 18px;
    background: transparent;
    color: var(--muted);
    font-size: 13px;
    padding: 6px 12px;
  }
  .more:hover { color: var(--green); }
  .hint {
    margin-top: 14px;
    font-size: 11px;
    color: var(--muted);
    opacity: .7;
  }
  kbd {
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--fg) 20%, transparent);
  }

  .attr { margin: -18px 0 24px; }
  ${brandCss(22)}
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  @keyframes pop  { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .card, .cover { animation: none; } }
</style>
</head>
<body>
  <div class="backdrop"></div>
  <main class="card" role="dialog" aria-labelledby="t">
    ${img
      ? `<img class="cover" src="${img}" alt="">`
      : `<div class="cover placeholder" aria-hidden="true">♪</div>`}
    <p class="eyebrow">${esc(t('card.nothing'))}${kind ? ` · ${kind}` : ''}</p>
    <h1 id="t">${name}</h1>
    <p class="subtitle">${subtitle}</p>
    <div class="attr">${brandHtml(webview)}</div>
    <div class="actions">
      <button class="play" id="play" autofocus>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l12.5-7.5a1 1 0 0 0 0-1.74L8.5 3.63A1 1 0 0 0 7 4.5z"/></svg>
        ${esc(t('card.play'))}
      </button>
      <button class="later" id="later">${esc(t('card.later'))}</button>
    </div>
    <button class="more" id="more">${esc(t('card.more'))}</button>
    <p class="hint"><kbd>Enter</kbd> ${esc(t('card.hintPlay'))} · <kbd>Esc</kbd> ${esc(t('card.hintClose'))}</p>
  </main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const send = (type) => vscode.postMessage({ type });
  document.getElementById('play').addEventListener('click', () => send('play'));
  document.getElementById('later').addEventListener('click', () => send('later'));
  document.getElementById('more').addEventListener('click', () => send('more'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { send('later'); }
    const id = document.activeElement?.id;
    if (e.key === 'Enter' && id !== 'later' && id !== 'more') { e.preventDefault(); send('play'); }
  });
  document.getElementById('play').focus();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

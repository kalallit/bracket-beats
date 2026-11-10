import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Atribuição ao Spotify. As regras de marca do Spotify exigem o logótipo oficial
 * junto a capas, nomes de músicas e playlists, por isso as três vistas mostram-no.
 *
 * O logótipo NÃO vem com o código: descarrega-se em developer.spotify.com/design e
 * põe-se em media/spotify/ com estes nomes (SVG ou PNG):
 *   logo-white.svg|png  (para temas escuros)
 *   logo-black.svg|png  (para temas claros)
 * Sem os ficheiros, aparece o nome "Spotify" em texto, para não deixar o espaço vazio.
 */
const DIR = ['media', 'spotify'];
let root: vscode.Uri | undefined;

/** Chamado na ativação, para as vistas saberem onde está a pasta da extensão. */
export function initBrand(extensionUri: vscode.Uri): void {
  root = extensionUri;
}

function find(variant: 'white' | 'black'): string | undefined {
  if (!root) { return undefined; }
  for (const ext of ['svg', 'png']) {
    const file = `logo-${variant}.${ext}`;
    if (fs.existsSync(path.join(root.fsPath, ...DIR, file))) { return file; }
  }
  return undefined;
}

/** Pastas que as vistas podem carregar (juntar a localResourceRoots). */
export function brandRoots(): vscode.Uri[] {
  return root ? [vscode.Uri.joinPath(root, ...DIR)] : [];
}

/** Fonte de imagens a acrescentar ao Content-Security-Policy da vista. */
export function brandCsp(webview?: vscode.Webview): string {
  return webview?.cspSource ?? '';
}

/** CSS do bloco de atribuição. `height` é a altura do logótipo em px. */
export function brandCss(height = 20): string {
  return `
  .sp-attr { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); text-decoration: none; }
  .sp-attr img { height: ${height}px; min-width: 70px; width: auto; object-fit: contain; display: block; } /* 70 px: mínimo do Spotify para o logótipo completo */
  .sp-attr .sp-text { font-weight: 700; letter-spacing: .01em; }
  body.vscode-light .sp-white, body:not(.vscode-light) .sp-black { display: none; }`;
}

/** HTML do logótipo (ou do texto de reserva). */
export function brandHtml(webview?: vscode.Webview): string {
  const white = find('white');
  const black = find('black');
  if (!webview || !root || (!white && !black)) {
    return '<span class="sp-attr" title="Spotify"><span class="sp-text">Spotify</span></span>';
  }
  const src = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(root!, ...DIR, f)).toString();
  // Se só houver uma variante, usa-a nos dois temas.
  const w = white ?? black!;
  const b = black ?? white!;
  return `<span class="sp-attr" title="Spotify"><img class="sp-white" src="${src(w)}" alt="Spotify"><img class="sp-black" src="${src(b)}" alt="Spotify"></span>`;
}

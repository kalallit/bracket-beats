import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { t } from './i18n';
import { runSetupWizard } from './setup';

const REQUIRED_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',               // artistas mais ouvidos (para o "Para ti")
  'playlist-read-private',       // as tuas playlists privadas
  'playlist-read-collaborative', // e as colaborativas
  'user-library-read',           // saber se já gostaste da música
  'user-library-modify',         // gostar / deixar de gostar
  'playlist-modify-private',     // guardar a sessão como playlist
  'playlist-modify-public',
];
const SCOPES = REQUIRED_SCOPES.join(' ');

const SECRET_KEY = 'bracketBeats.tokens';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope?: string;    // scopes concedidos, para detetar quando uma versão nova precisa de mais
}

/** Falha temporária (rede, 5xx, rate limit) ao renovar o token. A sessão continua válida. */
export class AuthTransientError extends Error {}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hasAllScopes(tk: Tokens): boolean {
  const granted = new Set((tk.scope ?? '').split(' '));
  return REQUIRED_SCOPES.every((s) => granted.has(s));
}

export class SpotifyAuth {
  private tokens: Tokens | undefined;
  private refreshing?: Promise<void>;
  private loggingIn?: Promise<boolean>;
  private readonly emitter = new vscode.EventEmitter<void>();

  /** true quando há tokens guardados mas de uma versão antiga, sem todas as permissões. */
  needsReauth = false;

  /** Dispara quando a sessão é iniciada ou terminada NOUTRA janela do VS Code. */
  readonly onDidChangeSession = this.emitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    // O armazenamento seguro é partilhado entre janelas e avisa quando muda.
    secrets.onDidChange?.((e) => { if (e.key === SECRET_KEY) { void this.syncFromStorage(); } });
  }

  private get config() {
    return vscode.workspace.getConfiguration('bracketBeats');
  }

  private get clientId(): string {
    return this.config.get<string>('clientId', '').trim();
  }

  private get redirectUri(): string {
    return `http://127.0.0.1:${this.config.get<number>('redirectPort', 8888)}/callback`;
  }

  async isLoggedIn(): Promise<boolean> {
    await this.load();
    return !!this.tokens;
  }

  private async readStored(): Promise<Tokens | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) { return undefined; }
    try { return JSON.parse(raw) as Tokens; } catch { return undefined; }
  }

  private async load(): Promise<void> {
    if (this.tokens) { return; }
    const stored = await this.readStored();
    const valid = stored && hasAllScopes(stored) ? stored : undefined;
    this.needsReauth = !!stored && !valid;
    this.tokens = valid;
  }

  /** Outra janela (ou esta) alterou os tokens guardados: fica com a versão guardada. */
  private async syncFromStorage(): Promise<void> {
    const wasLoggedIn = !!this.tokens;
    const stored = await this.readStored();
    const valid = stored && hasAllScopes(stored) ? stored : undefined;
    this.needsReauth = !!stored && !valid;
    this.tokens = valid;
    if (wasLoggedIn !== !!valid) { this.emitter.fire(); }
  }

  private async save(tk: Tokens): Promise<void> {
    this.tokens = tk;
    this.needsReauth = false;
    await this.secrets.store(SECRET_KEY, JSON.stringify(tk));
  }

  async logout(): Promise<void> {
    this.tokens = undefined;
    await this.secrets.delete(SECRET_KEY);
  }

  /** Devolve um access token válido, renovando-o se estiver quase a expirar. */
  async getAccessToken(): Promise<string | undefined> {
    await this.load();
    if (!this.tokens) { return undefined; }
    if (Date.now() > this.tokens.expiresAt - 60_000) {
      try {
        await this.refresh();
      } catch (e) {
        // Falha temporária: se o token atual ainda não expirou de facto, usa-o.
        if (!this.tokens || Date.now() >= this.tokens.expiresAt) { throw e; }
      }
    }
    return this.tokens?.accessToken;
  }

  /** Renova o token. Chamadas em simultâneo partilham o mesmo pedido. */
  refresh(): Promise<void> {
    return (this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = undefined; }));
  }

  private async doRefresh(): Promise<void> {
    const mine = this.tokens;
    if (!mine) { return; }

    // Outra janela pode já ter renovado. O refresh token é de uso único, por isso usar
    // o que ela guardou evita invalidar a sessão de todas.
    const stored = await this.readStored();
    if (!stored) { this.tokens = undefined; return; } // sessão terminada noutra janela
    if (stored.accessToken !== mine.accessToken && stored.expiresAt > Date.now() + 60_000) {
      this.tokens = stored;
      return;
    }

    const used = stored.refreshToken;
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: used, client_id: this.clientId }),
      });
    } catch (e) {
      throw new AuthTransientError((e as Error).message);
    }

    if (res.ok) {
      const data: any = await res.json();
      await this.save({
        accessToken: data.access_token,
        // Com PKCE o Spotify pode devolver um refresh token novo; se não, mantém o antigo.
        refreshToken: data.refresh_token ?? used,
        expiresAt: Date.now() + data.expires_in * 1000,
        scope: data.scope ?? stored.scope,
      });
      return;
    }

    let code = '';
    try { code = JSON.parse(await res.text())?.error ?? ''; } catch { /* corpo sem JSON */ }
    if (res.status === 400 && (code === 'invalid_grant' || code === 'invalid_client')) {
      // Recusado de vez. Antes de desistir, confirma que não foi outra janela a usar este refresh token.
      const again = await this.readStored();
      if (again && again.refreshToken !== used) { this.tokens = again; return; }
      await this.logout();
      return;
    }
    // 5xx, 429, etc.: problema temporário do Spotify. A sessão mantém-se.
    throw new AuthTransientError(`${res.status} ${code}`.trim());
  }

  /** Corre o assistente e guarda o Client ID nas definições do utilizador. */
  async setup(): Promise<boolean> {
    const id = await runSetupWizard(this.redirectUri, this.clientId);
    if (!id) { return false; }
    await this.config.update('clientId', id, vscode.ConfigurationTarget.Global);
    return true;
  }

  /** Login com Authorization Code + PKCE. Um segundo clique enquanto decorre reutiliza o mesmo login. */
  login(): Promise<boolean> {
    return (this.loggingIn ??= this.doLogin().finally(() => { this.loggingIn = undefined; }));
  }

  private async doLogin(): Promise<boolean> {
    // Sem Client ID: o assistente guia a criação da app e pede o ID, sem passar pelas definições.
    if (!this.clientId && !(await this.setup())) { return false; }

    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));
    const port = this.config.get<number>('redirectPort', 8888);

    const code = await new Promise<string | undefined>((resolve) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', this.redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ok
          ? `<h2>${t('auth.okTitle')}</h2><p>${t('auth.okBody')}</p>`
          : `<h2>${t('auth.failTitle')}</h2><p>${t('auth.failBody')}</p>`);
        clearTimeout(timer);
        server.close();
        resolve(ok ? url.searchParams.get('code')! : undefined);
      });
      const timer = setTimeout(() => { server.close(); resolve(undefined); }, 5 * 60_000);
      server.on('error', (err) => {
        clearTimeout(timer);
        vscode.window.showErrorMessage(t('auth.portErr', port, err.message));
        resolve(undefined);
      });
      server.listen(port, '127.0.0.1', () => {
        const authUrl = new URL('https://accounts.spotify.com/authorize');
        authUrl.search = new URLSearchParams({
          client_id: this.clientId,
          response_type: 'code',
          redirect_uri: this.redirectUri,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          scope: SCOPES,
          state,
        }).toString();
        vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
      });
    });

    if (!code) { return false; }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      vscode.window.showErrorMessage(t('auth.tokenErr', `${res.status} ${await res.text()}`));
      return false;
    }
    const data: any = await res.json();
    await this.save({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope ?? SCOPES,
    });
    return true;
  }
}

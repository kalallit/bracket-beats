import * as vscode from 'vscode';
import { SpotifyAuth } from './auth';
import { SpotifyClient, SpotifyError, PlayerState, RepeatMode, TrackLite, PlayTarget } from './spotify';
import { Store } from './store';

/** O que as janelas partilham entre si sobre o que está a tocar. */
interface Shared {
  at: number;
  state?: PlayerState;
  liked?: boolean;
}

const SHARED_FILE = 'now.json';

/**
 * Estado do player e polling.
 *
 * Só a janela em foco fala com o Spotify; as outras leem um ficheiro partilhado, por isso
 * abrir dez janelas custa o mesmo que abrir uma. O intervalo adapta-se: normal a tocar,
 * mais espaçado em pausa ou sem nada, e respeita o tempo que o Spotify pedir num 429.
 */
export class Player implements vscode.Disposable {
  state: PlayerState | undefined;
  liked = false;

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private disposed = false;
  private sharedAt = 0;
  private announcedId: string | undefined;
  private queueCache: { id?: string; items: TrackLite[] } | undefined;
  private queueRev = 0;

  private readonly changed = new vscode.EventEmitter<void>();
  private readonly trackStarted = new vscode.EventEmitter<PlayerState>();
  private readonly sessionLost = new vscode.EventEmitter<void>();

  /** O estado mudou (nesta janela ou noutra). */
  readonly onDidChange = this.changed.event;
  /** Começou a tocar uma música nova, vista por esta janela em foco. Serve para o histórico. */
  readonly onDidStartTrack = this.trackStarted.event;
  /** O Spotify recusou o token: é preciso voltar a ligar. */
  readonly onDidLoseSession = this.sessionLost.event;

  constructor(
    private readonly auth: SpotifyAuth,
    private readonly client: SpotifyClient,
    private readonly store: Store,
  ) {}

  start(): void {
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.state = undefined;
    this.liked = false;
    this.announcedId = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.changed.dispose();
    this.trackStarted.dispose();
    this.sessionLost.dispose();
  }

  /** Atualiza já (por exemplo quando a janela ganha foco) e recomeça a contagem. */
  async refresh(): Promise<void> {
    if (!this.running) { return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tick();
  }

  /** Atualiza daqui a pouco: o Spotify demora uns instantes a refletir um comando. */
  refreshSoon(ms = 600): void {
    if (this.running) { this.schedule(ms); }
  }

  /** Progresso estimado agora, sem novo pedido. */
  progressNow(): number {
    const s = this.state;
    if (!s) { return 0; }
    if (!s.isPlaying) { return s.progressMs; }
    return Math.min(s.durationMs, s.progressMs + (Date.now() - s.fetchedAt));
  }

  // ---------- polling ----------

  private schedule(ms: number): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { void this.tick(); }, ms);
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.running) { return; }
    try {
      if (!(await this.auth.isLoggedIn())) {
        this.running = false;
        this.sessionLost.fire();
        return;
      }
      if (vscode.window.state.focused) {
        await this.pollApi();
      } else {
        await this.readShared();
      }
    } catch {
      // nunca deixar o ciclo morrer por um erro inesperado
    }
    if (!this.disposed && this.running) { this.schedule(this.nextDelay()); }
  }

  /** Quanto esperar até ao próximo pedido. */
  nextDelay(): number {
    const base = Math.max(2, vscode.workspace.getConfiguration('bracketBeats').get<number>('pollIntervalSeconds', 5)) * 1000;
    if (!vscode.window.state.focused) { return Math.max(base, 5000); } // só lê um ficheiro local
    if (this.client.rateLimitedMs > 0) { return this.client.rateLimitedMs + 500; }
    const s = this.state;
    if (!s) { return Math.min(base * 6, 60_000); }       // nada ativo
    if (!s.isPlaying) { return Math.min(base * 3, 30_000); } // em pausa
    // A tocar: se a música acaba antes do próximo ciclo, pergunta logo a seguir ao fim.
    const remaining = s.durationMs - this.progressNow();
    return Math.max(1000, Math.min(base, remaining + 800));
  }

  private async pollApi(): Promise<void> {
    let s: PlayerState | undefined;
    try {
      s = await this.client.getPlayerState();
    } catch (e) {
      if (e instanceof SpotifyError && e.status === 401) {
        this.running = false;
        this.sessionLost.fire();
      }
      return; // rede, 429, 5xx: mantém o que tinha e tenta no próximo ciclo
    }

    const trackChanged = s?.id !== this.state?.id;
    this.state = s;
    if (trackChanged) {
      this.queueCache = undefined;
      this.liked = false;
      if (s?.uri && s.type === 'track') {
        try { this.liked = await this.client.isSaved(s.uri); } catch { /* fica como não gostada */ }
      }
    }
    if (s?.isPlaying && s.id && s.id !== this.announcedId) {
      this.announcedId = s.id;
      this.trackStarted.fire(s);
    }
    await this.share();
    this.changed.fire();
  }

  private async share(): Promise<void> {
    this.sharedAt = Date.now();
    const data: Shared = { at: this.sharedAt, state: this.state, liked: this.liked };
    try { await this.store.write(SHARED_FILE, data); } catch { /* sem disco: as outras janelas ficam desatualizadas */ }
  }

  private async readShared(): Promise<void> {
    const sh = await this.store.read<Shared | null>(SHARED_FILE, null);
    if (!sh || sh.at <= this.sharedAt) { return; }
    this.sharedAt = sh.at;
    if (sh.state?.id !== this.state?.id) { this.queueCache = undefined; }
    this.state = sh.state;
    this.liked = !!sh.liked;
    this.changed.fire();
  }

  /** Altera o estado local de imediato, para a interface responder antes de o Spotify confirmar. */
  private patch(p: Partial<PlayerState>): void {
    if (!this.state) { return; }
    this.state = { ...this.state, progressMs: this.progressNow(), fetchedAt: Date.now(), ...p };
    this.changed.fire();
  }

  // ---------- comandos ----------

  /** Play/pause. Devolve false se não houver nada para retomar. */
  async togglePlay(): Promise<boolean> {
    const s = this.state;
    if (!s) { return false; }
    const wasPlaying = s.isPlaying;
    this.patch({ isPlaying: !wasPlaying });
    try {
      if (wasPlaying) { await this.client.pause(); } else { await this.client.play(); }
    } catch (e) {
      this.patch({ isPlaying: wasPlaying });
      throw e;
    }
    this.refreshSoon();
    return true;
  }

  async play(target?: PlayTarget): Promise<void> {
    await this.client.play(target);
    this.refreshSoon(800);
  }

  async pause(): Promise<void> {
    if (this.state?.isPlaying) { this.patch({ isPlaying: false }); }
    await this.client.pause();
    this.refreshSoon();
  }

  async next(): Promise<void> { await this.client.next(); this.refreshSoon(); }
  async previous(): Promise<void> { await this.client.previous(); this.refreshSoon(); }

  async seek(ms: number): Promise<void> {
    this.patch({ progressMs: ms });
    await this.client.seek(ms);
    this.refreshSoon();
  }

  /** Gostar / deixar de gostar da música atual. Devolve o novo estado, ou undefined se não houver música. */
  async toggleLike(): Promise<boolean | undefined> {
    const s = this.state;
    if (!s?.uri || s.type !== 'track') { return undefined; }
    const want = !this.liked;
    this.liked = want;
    this.changed.fire();
    try {
      if (want) { await this.client.save(s.uri); } else { await this.client.unsave(s.uri); }
    } catch (e) {
      this.liked = !want;
      this.changed.fire();
      throw e;
    }
    void this.share();
    return want;
  }

  async toggleShuffle(): Promise<boolean | undefined> {
    const s = this.state;
    if (!s) { return undefined; }
    const want = !s.shuffle;
    this.patch({ shuffle: want });
    try { await this.client.setShuffle(want); } catch (e) { this.patch({ shuffle: !want }); throw e; }
    this.refreshSoon();
    return want;
  }

  async cycleRepeat(): Promise<RepeatMode | undefined> {
    const s = this.state;
    if (!s) { return undefined; }
    const order: RepeatMode[] = ['off', 'context', 'track'];
    const before = s.repeat;
    const want = order[(order.indexOf(before) + 1) % order.length];
    this.patch({ repeat: want });
    try { await this.client.setRepeat(want); } catch (e) { this.patch({ repeat: before }); throw e; }
    this.refreshSoon();
    return want;
  }

  /** Define o volume (0 a 100). Devolve o valor aplicado, ou undefined se o dispositivo não deixar. */
  async setVolume(pct: number): Promise<number | undefined> {
    const d = this.state?.device;
    if (!d || !d.supportsVolume) { return undefined; }
    const v = Math.min(100, Math.max(0, Math.round(pct)));
    const before = d.volume;
    this.patch({ device: { ...d, volume: v } });
    try {
      await this.client.setVolume(v);
    } catch (e) {
      this.patch({ device: { ...d, volume: before } });
      throw e;
    }
    return v;
  }

  changeVolume(delta: number): Promise<number | undefined> {
    return this.setVolume((this.state?.device?.volume ?? 50) + delta);
  }

  async transfer(deviceId: string): Promise<void> {
    await this.client.transfer(deviceId, true);
    this.refreshSoon(1000);
  }

  /** Muda sempre que a fila pode ter mudado (música nova ou algo acrescentado). */
  get queueKey(): string {
    return `${this.state?.id ?? ''}:${this.queueRev}`;
  }

  /** Próximas músicas. Guardado por música, para não repetir o pedido a cada atualização. */
  async queue(): Promise<TrackLite[]> {
    const id = this.state?.id;
    if (this.queueCache && this.queueCache.id === id) { return this.queueCache.items; }
    const items = await this.client.getQueue(10);
    this.queueCache = { id, items };
    return items;
  }

  async addToQueue(uri: string): Promise<void> {
    await this.client.addToQueue(uri);
    this.queueCache = undefined;
    this.queueRev++;
    this.changed.fire();
  }
}

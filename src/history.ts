import { PlayerState, SpotifyClient, ContextMeta } from './spotify';
import { Store } from './store';

/** Uma música ouvida, com o contexto em que estavas a trabalhar. Fica só no teu computador. */
export interface Play {
  ts: number;
  id: string;
  uri: string;
  name: string;
  artists: { id: string; name: string }[];
  ctx?: string;   // playlist/álbum de onde veio
  ws?: string;    // projeto aberto na janela
  lang?: string;  // linguagem do ficheiro ativo
  ms: number;     // duração
}

const FILE = 'history.jsonl';
const KEEP = 5000;
const TRIM_AT = 6000;
const PLAYABLE = /^spotify:(playlist|album|artist):/;

export class History {
  private cache: Play[] | undefined;

  constructor(private readonly store: Store, private readonly enabled: () => boolean = () => true) {}

  /** Todas as músicas registadas, da mais antiga para a mais recente. */
  async all(reload = false): Promise<Play[]> {
    if (this.cache && !reload) { return this.cache; }
    const lines = await this.store.readLines(FILE);
    let plays: Play[] = [];
    for (const l of lines) {
      try { plays.push(JSON.parse(l)); } catch { /* linha estragada: ignora */ }
    }
    if (plays.length > TRIM_AT) {
      plays = plays.slice(-KEEP);
      await this.store.writeLines(FILE, plays.map((p) => JSON.stringify(p)));
    }
    this.cache = plays;
    return plays;
  }

  /** Regista a música. Devolve false se o histórico estiver desligado ou se já estava registada. */
  async record(s: PlayerState, ws?: string, lang?: string): Promise<boolean> {
    if (!this.enabled() || !s.id || !s.uri || s.type !== 'track') { return false; }
    const all = await this.all(true); // relê: outra janela pode ter registado esta mesma música
    const last = all[all.length - 1];
    if (last && last.id === s.id && Date.now() - last.ts < Math.max(s.durationMs, 30_000)) { return false; }
    const play: Play = {
      ts: Date.now(), id: s.id, uri: s.uri, name: s.title, artists: s.artistList,
      ctx: s.contextUri, ws, lang, ms: s.durationMs,
    };
    await this.store.append(FILE, JSON.stringify(play));
    all.push(play);
    return true;
  }

  async clear(): Promise<void> {
    this.cache = [];
    await this.store.remove(FILE);
  }

  /** Músicas ouvidas desde `ts`, opcionalmente só num projeto. */
  async since(ts: number, ws?: string): Promise<Play[]> {
    return (await this.all()).filter((p) => p.ts >= ts && (ws === undefined || p.ws === ws));
  }

  /**
   * Playlists/álbuns mais ouvidos, com filtros opcionais por projeto e por hora do dia
   * (a hora conta com duas horas de margem para cada lado).
   */
  async topContexts(opts: { ws?: string; hour?: number; days?: number; min?: number } = {}): Promise<{ ctx: string; n: number }[]> {
    const from = Date.now() - (opts.days ?? 60) * 86_400_000;
    const count = new Map<string, number>();
    for (const p of await this.all()) {
      if (p.ts < from || !p.ctx || !PLAYABLE.test(p.ctx)) { continue; }
      if (opts.ws !== undefined && p.ws !== opts.ws) { continue; }
      if (opts.hour !== undefined) {
        const d = Math.abs(new Date(p.ts).getHours() - opts.hour);
        if (Math.min(d, 24 - d) > 2) { continue; }
      }
      count.set(p.ctx, (count.get(p.ctx) ?? 0) + 1);
    }
    return [...count.entries()]
      .map(([ctx, n]) => ({ ctx, n }))
      .filter((c) => c.n >= (opts.min ?? 1))
      .sort((a, b) => b.n - a.n);
  }

  /** Quantas vezes ouviste cada artista nos últimos `days` dias. */
  async artistCounts(days = 90): Promise<Map<string, { name: string; n: number }>> {
    const from = Date.now() - days * 86_400_000;
    const out = new Map<string, { name: string; n: number }>();
    for (const p of await this.all()) {
      if (p.ts < from) { continue; }
      for (const a of p.artists) {
        out.set(a.id, { name: a.name, n: (out.get(a.id)?.n ?? 0) + 1 });
      }
    }
    return out;
  }
}

/** Nome e capa das playlists/álbuns, guardados em disco para não repetir pedidos ao Spotify. */
export class ContextCache {
  private map: Record<string, ContextMeta & { at: number }> | undefined;
  private static readonly FILE = 'contexts.json';
  private static readonly TTL = 30 * 86_400_000;

  constructor(private readonly store: Store, private readonly client: SpotifyClient) {}

  async get(uri: string): Promise<ContextMeta | undefined> {
    this.map ??= await this.store.read(ContextCache.FILE, {});
    const hit = this.map[uri];
    if (hit && Date.now() - hit.at < ContextCache.TTL) { return hit; }
    let meta: ContextMeta | undefined;
    try { meta = await this.client.getContextMeta(uri); } catch { return hit; }
    if (!meta) { return undefined; }
    this.map[uri] = { ...meta, at: Date.now() };
    try { await this.store.write(ContextCache.FILE, this.map); } catch { /* fica só em memória */ }
    return meta;
  }
}

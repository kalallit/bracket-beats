import * as vscode from 'vscode';
import { SpotifyClient, PlaylistInfo, ContextMeta } from './spotify';
import { Store } from './store';
import { Feedback } from './feedback';
import { History, ContextCache } from './history';
import { Project } from './project';
import { t } from './i18n';

export interface Card {
  uri: string;
  name: string;
  subtitle: string;
  image?: string;
  reason?: string;
  mine: boolean;
  pinned?: boolean; // playlist do projeto: aparece sempre primeiro
}

export interface Mood {
  id: string;
  emoji: string;
  label: string;       // moods de origem: nome em português (o painel mostra moodLabel(id)); personalizados: o nome dado
  query: string;       // pesquisa no Spotify
  keywords: string[];  // para encontrar playlists tuas com nomes parecidos
  color: string;       // cor do chip
  custom?: boolean;
}

export const MOODS: Mood[] = [
  { id: 'foco', emoji: '🎯', label: 'Foco', query: 'deep focus', color: '#4f7cff',
    keywords: ['focus', 'foco', 'concentr', 'study', 'estud', 'work', 'trabalh', 'instrumental', 'lofi', 'lo-fi'] },
  { id: 'code', emoji: '💻', label: 'A programar', query: 'programming music', color: '#22c3a6',
    keywords: ['code', 'coding', 'program', 'dev', 'synthwave', 'electronic', 'eletr', 'hacker'] },
  { id: 'energia', emoji: '⚡', label: 'Energia', query: 'energy boost', color: '#ff7a1a',
    keywords: ['energy', 'energia', 'hype', 'pump', 'workout', 'treino', 'gym', 'power', 'rock'] },
  { id: 'chill', emoji: '🌊', label: 'Chill', query: 'chill vibes', color: '#3cb4e6',
    keywords: ['chill', 'relax', 'calm', 'calma', 'acoustic', 'acust', 'sunday', 'domingo', 'lazy'] },
  { id: 'feliz', emoji: '☀️', label: 'Bom humor', query: 'feel good hits', color: '#f2c12e',
    keywords: ['happy', 'feliz', 'feel good', 'good vibes', 'summer', 'verao', 'party', 'festa', 'dance'] },
  { id: 'melancolia', emoji: '🌧️', label: 'Melancolia', query: 'sad songs', color: '#8a7dd8',
    keywords: ['sad', 'triste', 'melanc', 'rain', 'chuva', 'heartbreak', 'saudade'] },
  { id: 'noite', emoji: '🌙', label: 'Noite', query: 'late night vibes', color: '#6c5ce7',
    keywords: ['night', 'noite', 'late', 'midnight', 'madrugada', 'dark', 'jazz', 'ambient'] },
];

const CUSTOM_COLORS = ['#e667af', '#59c36a', '#d9a441', '#5fb7d4', '#b08cf0', '#ef7d57'];

/**
 * Moods a mostrar: os de origem (menos os escondidos em "bracketBeats.hiddenMoods")
 * seguidos dos definidos pelo utilizador em "bracketBeats.customMoods".
 */
export function getMoods(): Mood[] {
  const cfg = vscode.workspace.getConfiguration('bracketBeats');
  const hidden = new Set(cfg.get<string[]>('hiddenMoods', []) ?? []);
  const custom = cfg.get<unknown[]>('customMoods', []) ?? [];
  const out = MOODS.filter((m) => !hidden.has(m.id));
  const used = new Set(out.map((m) => m.id));
  custom.forEach((raw, i) => {
    const c = raw as { label?: unknown; emoji?: unknown; query?: unknown; keywords?: unknown; color?: unknown };
    const label = typeof c?.label === 'string' ? c.label.trim() : '';
    if (!label) { return; }
    let id = `custom-${norm(label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || i}`;
    while (used.has(id)) { id += '-2'; }
    used.add(id);
    out.push({
      id,
      label,
      emoji: typeof c.emoji === 'string' && c.emoji.trim() ? c.emoji.trim() : '🎵',
      // Sem pesquisa definida, procura pelo próprio nome do mood.
      query: typeof c.query === 'string' && c.query.trim() ? c.query.trim() : label,
      keywords: Array.isArray(c.keywords) ? c.keywords.filter((k): k is string => typeof k === 'string' && !!k.trim()) : [label],
      color: typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : CUSTOM_COLORS[i % CUSTOM_COLORS.length],
      custom: true,
    });
  });
  return out;
}

/** Nome do mood no idioma atual. */
export function moodLabel(id: string): string {
  const m = MOODS.find((x) => x.id === id);
  if (m) { return t(`mood.${id}` as Parameters<typeof t>[0]); }
  return getMoods().find((x) => x.id === id)?.label ?? id;
}

/** Mood sugerido pela hora do dia. */
export function moodForHour(h: number): string {
  if (h >= 6 && h < 12) { return 'foco'; }
  if (h >= 12 && h < 18) { return 'code'; }
  if (h >= 18 && h < 22) { return 'chill'; }
  return 'noite';
}

interface ArtistW { id: string; name: string; w: number; genre?: string }

interface Profile {
  meId: string;
  meName: string;
  /** Peso de cada artista no teu gosto (limitado, para uma fase recente não apagar o resto). */
  weights: Map<string, ArtistW>;
  /** Artistas por peso. */
  topArtists: ArtistW[];
  /** Géneros com peso, do mais ouvido para o menos. */
  topGenres: { genre: string; w: number }[];
  playlists: PlaylistInfo[];
  at: number;
}

export interface TasteSummary {
  genres: { genre: string; pct: number }[];
  artists: { name: string; pct: number }[];
}

/** Peças opcionais: sem elas o recomendador funciona só com os dados do Spotify. */
export interface RecDeps {
  store?: Store;
  feedback?: Feedback;
  history?: History;
  contexts?: ContextCache;
  project?: Project;
}

const PROFILE_TTL = 30 * 60_000;
const RECENT_CAP = 4;       // no máximo 4 "ouvidas recentes" contam por artista
const RECENT_W = 0.5;       // cada ouvida recente vale pouco...
const TOP_W = 3;            // ...o top (4 semanas e 6 meses) vale mais
const HISTORY_CAP = 20;     // histórico local: 20 ou mais ouvidas em 90 dias...
const HISTORY_W = 1.5;      // ...valem no máximo isto
const SAME_ARTIST = 0.45;   // penalização por repetir o artista principal
const SAME_GENRE = 0.65;    // penalização por repetir o género principal
const MAX_CARDS = 12;
const HABIT_MIN_PROJECT = 3; // músicas ouvidas de uma playlist neste projeto para contar como hábito
const HABIT_MIN_HOUR = 4;    // idem, a esta hora do dia
const ARTISTS_FILE = 'playlist-artists.json';

export class Recommender {
  private profile?: Profile;
  /** playlistId -> artistas, com o snapshot da playlist para saber quando refazer. */
  private artistCache: Map<string, { snap?: string; ids: string[] }> | undefined;

  constructor(private readonly client: SpotifyClient, private readonly deps: RecDeps = {}) {}

  async userName(): Promise<string> {
    return (await this.getProfile()).meName;
  }

  /** Esquece o perfil (por exemplo depois de limpar o histórico). */
  reset(): void {
    this.profile = undefined;
  }

  /** As tuas playlists, para o comando de associar uma ao projeto. */
  async myPlaylists(): Promise<PlaylistInfo[]> {
    return (await this.getProfile()).playlists;
  }

  /** Resumo legível do perfil (para o comando "Ver o meu perfil de gostos"). */
  async summary(): Promise<TasteSummary> {
    const p = await this.getProfile();
    const gTotal = p.topGenres.reduce((s, g) => s + g.w, 0) || 1;
    const aTotal = p.topArtists.reduce((s, a) => s + a.w, 0) || 1;
    return {
      genres: p.topGenres.slice(0, 10).map((g) => ({ genre: g.genre, pct: Math.round((g.w / gTotal) * 100) })),
      artists: p.topArtists.slice(0, 15).map((a) => ({ name: a.name, pct: Math.round((a.w / aTotal) * 100) })),
    };
  }

  private async getProfile(): Promise<Profile> {
    if (this.profile && Date.now() - this.profile.at < PROFILE_TTL) { return this.profile; }

    const [me, short, medium, recent, playlists, local] = await Promise.all([
      this.client.getMe(),
      this.client.getTopArtists(20, 'short_term').catch(() => []),
      this.client.getTopArtists(20, 'medium_term').catch(() => []),
      this.client.getRecentArtists().catch(() => []),
      this.client.getMyPlaylists(50).catch(() => []),
      this.deps.history?.artistCounts(90).catch(() => undefined),
    ]);

    const weights = new Map<string, ArtistW>();
    const add = (id: string, name: string, w: number, genre?: string) => {
      const cur = weights.get(id);
      weights.set(id, { id, name, w: (cur?.w ?? 0) + w, genre: cur?.genre ?? genre });
    };

    // Top de 4 semanas e de 6 meses: o 1º vale TOP_W, o 20º quase nada.
    for (const list of [short, medium]) {
      list.forEach((a, i) => add(a.id, a.name, TOP_W * (list.length - i) / list.length, a.genres[0]));
    }

    // Ouvidas recentes: contam, mas com teto por artista.
    const recentCount = new Map<string, { name: string; n: number }>();
    recent.forEach((a) => {
      const c = recentCount.get(a.id);
      recentCount.set(a.id, { name: a.name, n: (c?.n ?? 0) + 1 });
    });
    recentCount.forEach((c, id) => add(id, c.name, Math.min(c.n, RECENT_CAP) * RECENT_W));

    // Histórico local (o Spotify só dá as últimas 50 músicas; este cobre 90 dias).
    local?.forEach((c, id) => add(id, c.name, (Math.min(c.n, HISTORY_CAP) / HISTORY_CAP) * HISTORY_W));

    // Géneros, pesados pelo peso de cada artista (todos os géneros do artista, não só o 1º).
    const genreW = new Map<string, number>();
    const counted = new Set<string>();
    for (const a of [...short, ...medium]) {
      if (counted.has(a.id)) { continue; }
      counted.add(a.id);
      const w = weights.get(a.id)?.w ?? 0;
      a.genres.forEach((g, gi) => genreW.set(g, (genreW.get(g) ?? 0) + w / (gi + 1)));
    }
    const topGenres = [...genreW.entries()]
      .map(([genre, w]) => ({ genre, w }))
      .sort((a, b) => b.w - a.w);

    const topArtists = [...weights.values()].sort((a, b) => b.w - a.w);

    this.profile = { meId: me.id, meName: me.name, weights, topArtists, topGenres, playlists, at: Date.now() };
    return this.profile;
  }

  private mult(uri: string): number {
    return this.deps.feedback?.multiplier(uri) ?? 1;
  }

  /**
   * Sugestões para ti, por esta ordem:
   *  1. a playlist do projeto aberto;
   *  2. o que costumas ouvir neste projeto e a esta hora (histórico local);
   *  3. as tuas playlists ordenadas pelos artistas que ouves, com diversidade;
   *  4. se forem poucas, playlists públicas de artistas teus de géneros diferentes.
   */
  async forYou(excludeUri?: string, shuffle = false): Promise<Card[]> {
    const p = await this.getProfile();
    const seen = new Set<string>(excludeUri ? [excludeUri] : []);
    const lead: Card[] = [];

    const proj = this.deps.project?.playlist;
    if (proj && !seen.has(proj.uri)) {
      seen.add(proj.uri);
      lead.push({ uri: proj.uri, name: proj.name, subtitle: t('kind.playlist'), image: proj.image, reason: t('rec.project'), mine: true, pinned: true });
    }
    for (const c of await this.habitCards(seen)) { lead.push(c); }

    const own = p.playlists
      .filter((pl) => (pl.ownerId === p.meId || pl.collaborative) && !seen.has(pl.uri) && this.mult(pl.uri) > 0)
      .slice(0, 30);

    const artistsOf = await this.loadArtists(own);

    const scored = own.map((pl) => {
      const ids = new Set(artistsOf.get(pl.id) ?? []);
      const matched: ArtistW[] = [];
      ids.forEach((id) => { const hit = p.weights.get(id); if (hit) { matched.push(hit); } });
      matched.sort((a, b) => b.w - a.w);
      let score = matched.reduce((s, a) => s + a.w, 0) / Math.sqrt(ids.size + 1);
      score *= this.mult(pl.uri); // o que escolhes sobe, o que ignoras desce
      if (shuffle) { score *= 0.5 + Math.random(); }
      const main = matched[0];
      return { pl, score, matched, mainArtist: main?.id, mainGenre: dominantGenre(matched) };
    }).filter((s) => s.score > 0);

    const room = MAX_CARDS - lead.length;
    const picked = diversify(scored, room);
    const cards: Card[] = picked.map(({ pl, matched }) => ({
      ...cardFrom(pl, true),
      reason: matched.length > 1
        ? t('rec.andMore', matched[0].name, matched.length - 1)
        : t('rec.has', matched[0].name),
    }));
    cards.forEach((c) => seen.add(c.uri));

    // Poucas playlists tuas com match? Junta playlists públicas de artistas de géneros DIFERENTES.
    if (cards.length < Math.min(8, room)) {
      const usedGenres = new Set(picked.map((s) => s.mainGenre).filter(Boolean));
      const pool = shuffle ? shuffled(p.topArtists.slice(0, 15)) : p.topArtists.slice(0, 15);
      const artists: ArtistW[] = [];
      for (const a of pool) {
        if (artists.length >= 3) { break; }
        if (a.genre && usedGenres.has(a.genre)) { continue; }
        artists.push(a);
        if (a.genre) { usedGenres.add(a.genre); }
      }
      // Se toda a gente for do mesmo género, aceita repetir para não ficar vazio.
      for (const a of pool) { if (artists.length >= 3) { break; } if (!artists.includes(a)) { artists.push(a); } }

      const results = await Promise.all(artists.map((a) => this.client.searchPlaylists(a.name, 3).catch(() => [])));
      // Intercala: 1 de cada artista, depois o 2º de cada, etc.
      const extra: Card[] = [];
      for (let round = 0; round < 3; round++) {
        artists.forEach((a, i) => {
          const pl = results[i][round];
          if (!pl || seen.has(pl.uri)) { return; }
          seen.add(pl.uri);
          extra.push({ ...cardFrom(pl, false), reason: t('rec.because', a.name) });
        });
      }
      cards.push(...this.rerank(extra).slice(0, room - cards.length));
    }
    return [...lead, ...cards];
  }

  /** Até duas sugestões tiradas do histórico local: neste projeto e a esta hora. */
  private async habitCards(seen: Set<string>): Promise<Card[]> {
    const { history, contexts, project } = this.deps;
    if (!history || !contexts) { return []; }
    const out: Card[] = [];
    const tryAdd = async (list: { ctx: string }[], reason: string) => {
      for (const c of list) {
        if (seen.has(c.ctx) || this.mult(c.ctx) === 0) { continue; }
        const meta = await contexts.get(c.ctx);
        if (!meta) { continue; }
        seen.add(c.ctx);
        out.push({ uri: meta.uri, name: meta.name, subtitle: metaSubtitle(meta), image: meta.image, reason, mine: false });
        return;
      }
    };
    try {
      const ws = project?.key;
      if (ws) { await tryAdd(await history.topContexts({ ws, min: HABIT_MIN_PROJECT }), t('rec.habitProject')); }
      await tryAdd(await history.topContexts({ hour: new Date().getHours(), min: HABIT_MIN_HOUR }), t('rec.habitHour'));
    } catch {
      // histórico ilegível: segue sem hábitos
    }
    return out;
  }

  /**
   * Playlists para um mood. A pesquisa geral é a base; o teu gosto entra só como tempero
   * (no máximo 4 resultados) e cada mood usa um género teu diferente.
   */
  async forMood(moodId: string, excludeUri?: string, shuffle = false): Promise<Card[]> {
    const moods = getMoods();
    const moodIndex = moods.findIndex((m) => m.id === moodId);
    const mood = moods[moodIndex];
    if (!mood) { return []; }
    const p = await this.getProfile();
    const seen = new Set<string>(excludeUri ? [excludeUri] : []);
    const cards: Card[] = [];
    const push = (pl: PlaylistInfo | undefined, mine: boolean, reason?: string) => {
      if (!pl || seen.has(pl.uri)) { return; }
      seen.add(pl.uri);
      cards.push({ ...cardFrom(pl, mine), reason });
    };

    // 1) Até 4 playlists tuas com nome/descrição a condizer.
    const own = p.playlists.filter((pl) => matches(`${pl.name} ${pl.description}`, mood.keywords));
    (shuffle ? shuffled(own) : own).slice(0, 4).forEach((pl) => push(pl, pl.ownerId === p.meId, t('rec.library')));

    // 2) Género para temperar: roda pelos teus 3 principais, um diferente por mood.
    const genres = p.topGenres.slice(0, 3).map((g) => g.genre);
    const genre = genres.length
      ? genres[shuffle ? Math.floor(Math.random() * genres.length) : moodIndex % genres.length]
      : undefined;
    const offset = shuffle ? [0, 10, 20][Math.floor(Math.random() * 3)] : 0;

    const [general, flavoured] = await Promise.all([
      this.client.searchPlaylists(mood.query, 10, offset).catch(() => []),
      genre ? this.client.searchPlaylists(`${mood.query} ${genre}`, 4).catch(() => []) : Promise.resolve([]),
    ]);

    // 3) Intercala: 2 gerais, 1 com o teu género, 2 gerais, 1 com o teu género...
    let g = 0, f = 0;
    while (g < general.length || f < flavoured.length) {
      push(general[g++], false);
      push(general[g++], false);
      if (f < flavoured.length) { push(flavoured[f++], false, `${moodLabel(mood.id)} · ${genre}`); }
    }

    return this.rerank(cards).slice(0, 15);
  }

  /**
   * Reordena uma lista que já vem por ordem de relevância, aplicando o feedback:
   * a posição dá a pontuação base e o multiplicador faz subir, descer ou desaparecer.
   */
  private rerank(cards: Card[]): Card[] {
    if (!this.deps.feedback) { return cards; }
    const n = cards.length;
    return cards
      .map((c, i) => ({ c, s: (n - i) * this.mult(c.uri) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }

  /** Artistas de cada playlist, com cache em disco invalidada quando a playlist muda. */
  private async loadArtists(pls: PlaylistInfo[]): Promise<Map<string, string[]>> {
    const store = this.deps.store;
    if (!this.artistCache) {
      const saved = store ? await store.read<Record<string, { snap?: string; ids: string[] }>>(ARTISTS_FILE, {}) : {};
      this.artistCache = new Map(Object.entries(saved));
    }
    const cache = this.artistCache;
    const missing = pls.filter((pl) => {
      const hit = cache.get(pl.id);
      return !hit || (pl.snapshotId !== undefined && hit.snap !== pl.snapshotId);
    });

    let fetched = 0;
    // Em grupos de 5 para não disparar o rate limit.
    for (let i = 0; i < missing.length; i += 5) {
      await Promise.all(missing.slice(i, i + 5).map(async (pl) => {
        try {
          cache.set(pl.id, { snap: pl.snapshotId, ids: await this.client.getPlaylistArtistIds(pl.id) });
          fetched++;
        } catch {
          // Sem acesso ou falha temporária: ignora por agora, sem guardar em disco.
          if (!cache.has(pl.id)) { cache.set(pl.id, { snap: '', ids: [] }); }
        }
      }));
    }
    if (fetched && store) {
      const keep: Record<string, { snap?: string; ids: string[] }> = {};
      cache.forEach((v, k) => { if (v.snap !== '') { keep[k] = v; } });
      await store.write(ARTISTS_FILE, keep).catch(() => undefined);
    }
    return new Map(pls.map((pl) => [pl.id, cache.get(pl.id)?.ids ?? []]));
  }
}

/** Género com mais peso entre os artistas em comum (só se sabe para artistas do teu top). */
function dominantGenre(matched: ArtistW[]): string | undefined {
  const w = new Map<string, number>();
  matched.forEach((a) => { if (a.genre) { w.set(a.genre, (w.get(a.genre) ?? 0) + a.w); } });
  let best: string | undefined, bestW = 0;
  w.forEach((v, k) => { if (v > bestW) { best = k; bestW = v; } });
  return best;
}

/**
 * Escolha gananciosa com penalização: a cada passo escolhe a melhor pontuação ajustada,
 * em que repetir artista/género principal multiplica por SAME_ARTIST/SAME_GENRE.
 */
function diversify<T extends { score: number; mainArtist?: string; mainGenre?: string }>(items: T[], n: number): T[] {
  const left = [...items];
  const out: T[] = [];
  const artistUses = new Map<string, number>();
  const genreUses = new Map<string, number>();
  while (out.length < n && left.length) {
    let bestI = 0, bestS = -1;
    left.forEach((it, i) => {
      const a = it.mainArtist ? artistUses.get(it.mainArtist) ?? 0 : 0;
      const g = it.mainGenre ? genreUses.get(it.mainGenre) ?? 0 : 0;
      const s = it.score * SAME_ARTIST ** a * SAME_GENRE ** g;
      if (s > bestS) { bestS = s; bestI = i; }
    });
    const [it] = left.splice(bestI, 1);
    out.push(it);
    if (it.mainArtist) { artistUses.set(it.mainArtist, (artistUses.get(it.mainArtist) ?? 0) + 1); }
    if (it.mainGenre) { genreUses.set(it.mainGenre, (genreUses.get(it.mainGenre) ?? 0) + 1); }
  }
  return out;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardFrom(pl: PlaylistInfo, mine: boolean): Card {
  const bits = [mine ? t('rec.yours') : pl.ownerName ? t('by', pl.ownerName) : t('kind.playlist')];
  if (pl.total) { bits.push(t('rec.tracks', pl.total)); }
  return { uri: pl.uri, name: pl.name, subtitle: bits.join(' · '), image: pl.image, mine };
}

/** Segunda linha de um cartão feito a partir dos dados de um contexto. */
export function metaSubtitle(meta: ContextMeta): string {
  if (meta.type === 'playlist') { return meta.owner ? t('by', meta.owner) : t('kind.playlist'); }
  if (meta.type === 'album') { return meta.artists || t('kind.album'); }
  return t('kind.artist');
}

/** Minúsculas e sem acentos, para comparar nomes. */
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function matches(text: string, keywords: string[]): boolean {
  const hay = norm(text);
  return keywords.some((k) => hay.includes(norm(k)));
}

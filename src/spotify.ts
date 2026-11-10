import { SpotifyAuth } from './auth';
import { t } from './i18n';

const API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
  }
}

export type RepeatMode = 'off' | 'context' | 'track';

export interface Device {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  volume?: number;
  supportsVolume: boolean;
}

/** Estado completo do player (GET /me/player). */
export interface PlayerState {
  isPlaying: boolean;
  id?: string;
  uri?: string;
  type: 'track' | 'episode';
  title: string;
  artists: string;
  artistList: { id: string; name: string }[];
  album?: string;
  albumUri?: string;
  image?: string;
  url?: string;
  progressMs: number;
  durationMs: number;
  fetchedAt: number;      // quando foi lido, para interpolar o progresso sem novos pedidos
  contextUri?: string;    // playlist/álbum de onde vem a música
  device?: Device;
  shuffle: boolean;
  repeat: RepeatMode;
}
export type NowPlaying = PlayerState;

export interface TrackLite {
  id: string;
  uri: string;
  name: string;
  artists: string;
  artistList: { id: string; name: string }[];
  image?: string;
  albumUri?: string;
}

export interface ContextMeta {
  uri: string;
  type: 'playlist' | 'album' | 'artist';
  name: string;
  image?: string;
  owner?: string;    // playlists
  artists?: string;  // álbuns
}

export interface SearchItem {
  uri: string;
  type: 'track' | 'album' | 'playlist' | 'artist';
  name: string;
  subtitle: string;
  image?: string;
  albumUri?: string; // músicas: para tocar dentro do álbum e a música seguinte fazer sentido
}

/** O que se pode mandar tocar. Sem nada, retoma o que estava. */
export interface PlayTarget {
  contextUri?: string;  // playlist/álbum/artista
  trackUri?: string;    // música solta
  offsetUri?: string;   // com contextUri: começar nesta música
}

export interface Suggestion extends PlayTarget {
  label: string;          // texto a mostrar ("a playlist X", "Música — Artista")
  name?: string;          // nome limpo, para o cartão
  kind?: string;          // "Playlist", "Playlist deste projeto", "Música"...
  subtitle?: string;      // dono da playlist, artistas do álbum, etc.
  imageUrl?: string;      // capa
}

export class SpotifyClient {
  private blockedUntil = 0;

  constructor(private readonly auth: SpotifyAuth) {}

  /** Milissegundos que faltam até o Spotify voltar a aceitar pedidos (0 se não houver limite ativo). */
  get rateLimitedMs(): number {
    return Math.max(0, this.blockedUntil - Date.now());
  }

  private rateLimitError(): SpotifyError {
    return new SpotifyError(429, 'RATE_LIMITED', t('err.rateLimited', Math.ceil(this.rateLimitedMs / 1000)));
  }

  private async request(method: string, path: string, body?: unknown, retried = false): Promise<any> {
    // O Spotify mandou abrandar: não insiste até passar o tempo indicado.
    if (this.rateLimitedMs > 0) { throw this.rateLimitError(); }

    let token: string | undefined;
    try {
      token = await this.auth.getAccessToken();
    } catch (e) {
      throw new SpotifyError(0, 'NETWORK', t('err.network'));
    }
    if (!token) { throw new SpotifyError(401, 'NOT_LOGGED_IN', t('err.notLoggedIn')); }

    let res: Response;
    try {
      res = await fetch(path.startsWith('http') ? path : API + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SpotifyError(0, 'NETWORK', t('err.network'));
    }

    if (res.status === 401 && !retried) {
      try { await this.auth.refresh(); } catch { throw new SpotifyError(0, 'NETWORK', t('err.network')); }
      return this.request(method, path, body, true);
    }
    if (res.status === 429) {
      const secs = Number(res.headers.get('retry-after')) || 5;
      this.blockedUntil = Date.now() + secs * 1000;
      throw this.rateLimitError();
    }
    if (res.status === 204 || res.status === 202) { return undefined; }

    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const reason = data?.error?.reason ?? '';
      const msg = data?.error?.message ?? res.statusText;
      throw new SpotifyError(res.status, reason, msg);
    }
    return data;
  }

  // ---------- player ----------

  async getPlayerState(): Promise<PlayerState | undefined> {
    const d = await this.request('GET', '/me/player?additional_types=episode');
    if (!d?.item) { return undefined; }
    const item = d.item;
    const ep = item.type === 'episode';
    return {
      isPlaying: !!d.is_playing,
      id: item.id,
      uri: item.uri,
      type: ep ? 'episode' : 'track',
      title: item.name,
      artists: ep ? (item.show?.name ?? '') : artistNames(item.artists),
      artistList: ep ? [] : artistList(item.artists),
      album: ep ? undefined : item.album?.name,
      albumUri: ep ? undefined : item.album?.uri,
      image: (ep ? (item.images ?? item.show?.images) : item.album?.images)?.[0]?.url,
      url: item.external_urls?.spotify,
      progressMs: d.progress_ms ?? 0,
      durationMs: item.duration_ms ?? 0,
      fetchedAt: Date.now(),
      contextUri: d.context?.uri,
      device: d.device ? toDevice(d.device) : undefined,
      shuffle: !!d.shuffle_state,
      repeat: (d.repeat_state as RepeatMode) ?? 'off',
    };
  }

  /** Nome antigo, mantido para o resto do código. */
  getNowPlaying(): Promise<PlayerState | undefined> {
    return this.getPlayerState();
  }

  async getDevices(): Promise<Device[]> {
    const data = await this.request('GET', '/me/player/devices');
    return (data?.devices ?? []).filter((d: any) => d?.id).map(toDevice);
  }

  /** Toca o alvo (ou retoma, se não houver) e escolhe um dispositivo se nenhum estiver ativo. */
  async play(target?: PlayTarget): Promise<void> {
    const body = target?.contextUri
      ? { context_uri: target.contextUri, ...(target.offsetUri ? { offset: { uri: target.offsetUri } } : {}) }
      : target?.trackUri ? { uris: [target.trackUri] }
      : undefined;
    try {
      await this.request('PUT', '/me/player/play', body);
    } catch (e) {
      if (e instanceof SpotifyError && e.status === 404) {
        // Sem dispositivo ativo: tenta usar o primeiro disponível.
        const devices = await this.getDevices();
        if (devices.length === 0) {
          throw new SpotifyError(404, 'NO_DEVICE', t('err.noDevice'));
        }
        await this.request('PUT', `/me/player/play?device_id=${encodeURIComponent(devices[0].id)}`, body);
        return;
      }
      throw e;
    }
  }

  playUri(contextUri: string): Promise<void> {
    return this.play({ contextUri });
  }

  pause() { return this.request('PUT', '/me/player/pause'); }
  next() { return this.request('POST', '/me/player/next'); }
  previous() { return this.request('POST', '/me/player/previous'); }
  seek(ms: number) { return this.request('PUT', `/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`); }
  setVolume(pct: number) { return this.request('PUT', `/me/player/volume?volume_percent=${clamp(Math.round(pct), 0, 100)}`); }
  setShuffle(on: boolean) { return this.request('PUT', `/me/player/shuffle?state=${on}`); }
  setRepeat(mode: RepeatMode) { return this.request('PUT', `/me/player/repeat?state=${mode}`); }
  transfer(deviceId: string, play = true) { return this.request('PUT', '/me/player', { device_ids: [deviceId], play }); }

  async getQueue(limit = 10): Promise<TrackLite[]> {
    const d = await this.request('GET', '/me/player/queue');
    return (d?.queue ?? []).filter((i: any) => i?.uri).slice(0, limit).map(toTrack);
  }

  addToQueue(uri: string) { return this.request('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}`); }

  // ---------- biblioteca ----------

  async isSaved(uri: string): Promise<boolean> {
    const d = await this.request('GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`);
    return Array.isArray(d) && d[0] === true;
  }

  save(uri: string) { return this.request('PUT', `/me/library?uris=${encodeURIComponent(uri)}`); }
  unsave(uri: string) { return this.request('DELETE', `/me/library?uris=${encodeURIComponent(uri)}`); }

  async createPlaylist(name: string, description: string): Promise<{ id: string; uri: string; url?: string }> {
    const d = await this.request('POST', '/me/playlists', { name, description, public: false });
    return { id: d.id, uri: d.uri, url: d.external_urls?.spotify };
  }

  async addToPlaylist(id: string, uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += 100) {
      await this.request('POST', `/playlists/${id}/items`, { uris: uris.slice(i, i + 100) });
    }
  }

  // ---------- contexto e histórico ----------

  /** Nome, capa e dono de uma playlist, álbum ou artista. Outros contextos devolvem undefined. */
  async getContextMeta(uri: string): Promise<ContextMeta | undefined> {
    const m = /^spotify:(playlist|album|artist):([A-Za-z0-9]+)$/.exec(uri);
    if (!m) { return undefined; }
    const type = m[1] as ContextMeta['type'];
    const d = await this.request('GET', `/${type}s/${m[2]}`);
    if (!d?.name) { return undefined; }
    return {
      uri,
      type,
      name: d.name,
      image: d.images?.[0]?.url,
      owner: type === 'playlist' ? d.owner?.display_name : undefined,
      artists: type === 'album' ? artistNames(d.artists) : undefined,
    };
  }

  async getRecentlyPlayed(limit = 50): Promise<{ track: TrackLite; contextUri?: string; playedAt: number }[]> {
    const d = await this.request('GET', `/me/player/recently-played?limit=${limit}`);
    return (d?.items ?? []).filter((i: any) => i?.track?.uri).map((i: any) => ({
      track: toTrack(i.track),
      contextUri: i.context?.uri,
      playedAt: Date.parse(i.played_at) || 0,
    }));
  }

  /** Artistas das últimas músicas ouvidas (uma entrada por música, com repetições). */
  async getRecentArtists(): Promise<ArtistInfo[]> {
    const items = await this.getRecentlyPlayed(50);
    return items.flatMap((i) => i.track.artistList.map((a) => ({ id: a.id, name: a.name, genres: [] })));
  }

  // ---------- dados para as recomendações ----------

  async getMe(): Promise<{ id: string; name: string }> {
    const d = await this.request('GET', '/me');
    return { id: d.id, name: d.display_name ?? d.id };
  }

  /** short_term ≈ últimas 4 semanas, medium_term ≈ 6 meses, long_term ≈ 1 ano. */
  async getTopArtists(limit = 20, range: 'short_term' | 'medium_term' | 'long_term' = 'short_term'): Promise<ArtistInfo[]> {
    const d = await this.request('GET', `/me/top/artists?time_range=${range}&limit=${limit}`);
    return (d?.items ?? []).map((a: any) => ({ id: a.id, name: a.name, genres: a.genres ?? [] }));
  }

  async getMyPlaylists(limit = 50): Promise<PlaylistInfo[]> {
    const d = await this.request('GET', `/me/playlists?limit=${limit}`);
    return (d?.items ?? []).filter(Boolean).map(toPlaylist);
  }

  /** IDs dos artistas de uma playlist. Só funciona em playlists tuas ou colaborativas. */
  async getPlaylistArtistIds(id: string): Promise<string[]> {
    const d = await this.request('GET', `/playlists/${id}/items?limit=100`);
    return (d?.items ?? []).flatMap((i: any) =>
      ((i.item ?? i.track)?.artists ?? []).map((a: any) => a.id)).filter(Boolean);
  }

  async searchPlaylists(query: string, limit = 10, offset = 0): Promise<PlaylistInfo[]> {
    const q = encodeURIComponent(query);
    const d = await this.request('GET', `/search?type=playlist&limit=${Math.min(limit, 10)}&offset=${offset}&q=${q}`);
    // A pesquisa às vezes devolve entradas null; filtram-se.
    return (d?.playlists?.items ?? []).filter(Boolean).map(toPlaylist);
  }

  /** Pesquisa geral: músicas, álbuns, playlists e artistas. */
  async search(query: string, limit = 5): Promise<SearchItem[]> {
    const q = encodeURIComponent(query);
    const d = await this.request('GET', `/search?type=track,album,playlist,artist&limit=${Math.min(limit, 10)}&q=${q}`);
    const ok = (arr: any): any[] => (arr?.items ?? []).filter((i: any) => i?.uri);
    return [
      ...ok(d?.tracks).map((x): SearchItem => ({
        uri: x.uri, type: 'track', name: x.name, subtitle: artistNames(x.artists),
        image: x.album?.images?.[0]?.url, albumUri: x.album?.uri,
      })),
      ...ok(d?.albums).map((x): SearchItem => ({
        uri: x.uri, type: 'album', name: x.name, subtitle: artistNames(x.artists), image: x.images?.[0]?.url,
      })),
      ...ok(d?.playlists).map((x): SearchItem => ({
        uri: x.uri, type: 'playlist', name: x.name, subtitle: x.owner?.display_name ?? '', image: x.images?.[0]?.url,
      })),
      ...ok(d?.artists).map((x): SearchItem => ({
        uri: x.uri, type: 'artist', name: x.name, subtitle: '', image: x.images?.[0]?.url,
      })),
    ];
  }
}

export interface ArtistInfo { id: string; name: string; genres: string[] }

export interface PlaylistInfo {
  id: string;
  uri: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  image?: string;
  total?: number;
  collaborative: boolean;
  snapshotId?: string; // muda quando a playlist é alterada; serve para invalidar caches
}

function toPlaylist(p: any): PlaylistInfo {
  return {
    id: p.id,
    uri: p.uri,
    name: p.name ?? '',
    description: stripHtml(p.description ?? ''),
    ownerId: p.owner?.id ?? '',
    ownerName: p.owner?.display_name ?? p.owner?.id ?? '',
    image: p.images?.[0]?.url,
    total: (p.items ?? p.tracks)?.total,
    collaborative: !!p.collaborative,
    snapshotId: p.snapshot_id,
  };
}

function toTrack(x: any): TrackLite {
  const ep = x.type === 'episode';
  return {
    id: x.id,
    uri: x.uri,
    name: x.name,
    artists: ep ? (x.show?.name ?? '') : artistNames(x.artists),
    artistList: ep ? [] : artistList(x.artists),
    image: (ep ? (x.images ?? x.show?.images) : x.album?.images)?.[0]?.url,
    albumUri: ep ? undefined : x.album?.uri,
  };
}

function toDevice(d: any): Device {
  return {
    id: d.id,
    name: d.name,
    type: d.type ?? '',
    isActive: !!d.is_active,
    volume: typeof d.volume_percent === 'number' ? d.volume_percent : undefined,
    supportsVolume: d.supports_volume !== false,
  };
}

function artistNames(artists: any): string {
  return (artists ?? []).map((a: any) => a.name).join(', ');
}

function artistList(artists: any): { id: string; name: string }[] {
  return (artists ?? []).filter((a: any) => a?.id).map((a: any) => ({ id: a.id, name: a.name }));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

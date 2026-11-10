import { SpotifyClient, Suggestion, ContextMeta } from './spotify';
import { History, ContextCache } from './history';
import { Project } from './project';
import { metaSubtitle } from './recommender';
import { t } from './i18n';

export interface SuggestDeps {
  client: SpotifyClient;
  project: Project;
  history: History;
  contexts: ContextCache;
}

const PLAYABLE = /^spotify:(playlist|album|artist):/;

function fromMeta(meta: ContextMeta, kind?: string): Suggestion {
  const article: Record<string, string> = { playlist: t('ctx.playlist'), album: t('ctx.album'), artist: t('ctx.artist') };
  const kinds: Record<string, string> = { playlist: t('kind.playlist'), album: t('kind.album'), artist: t('kind.artist') };
  return {
    label: `${article[meta.type]} "${meta.name}"`,
    contextUri: meta.uri,
    name: meta.name,
    kind: kind ?? kinds[meta.type],
    subtitle: metaSubtitle(meta),
    imageUrl: meta.image,
  };
}

/**
 * O que sugerir quando o Spotify está parado, por ordem de preferência:
 *  1. a playlist associada a este projeto;
 *  2. o que costumas ouvir neste projeto (a esta hora, se houver dados; senão em geral);
 *  3. a última playlist ou álbum que ouviste;
 *  4. a última música.
 */
export async function buildSuggestion(d: SuggestDeps): Promise<Suggestion | undefined> {
  const proj = d.project.playlist;
  if (proj) {
    return {
      label: `${t('ctx.playlist')} "${proj.name}"`,
      contextUri: proj.uri,
      name: proj.name,
      kind: t('sug.project'),
      subtitle: d.project.name,
      imageUrl: proj.image,
    };
  }

  const ws = d.project.key;
  if (ws) {
    try {
      const hour = new Date().getHours();
      const habits = [
        ...(await d.history.topContexts({ ws, hour, min: 3 })),
        ...(await d.history.topContexts({ ws, min: 5 })),
      ];
      for (const h of habits) {
        const meta = await d.contexts.get(h.ctx);
        if (meta) { return fromMeta(meta, t('sug.habit')); }
      }
    } catch {
      // histórico ilegível: passa à opção seguinte
    }
  }

  const recent = await d.client.getRecentlyPlayed(20);
  if (recent.length === 0) { return undefined; }

  const withContext = recent.find((r) => r.contextUri && PLAYABLE.test(r.contextUri));
  if (withContext?.contextUri) {
    const meta = await d.contexts.get(withContext.contextUri);
    if (meta) {
      // Se a playlist não tiver capa, usa a do álbum da música que estavas a ouvir.
      return fromMeta({ ...meta, image: meta.image ?? withContext.track.image });
    }
  }

  const track = recent[0].track;
  return {
    label: `"${track.name}" — ${track.artists}`,
    // Dentro do álbum, para a música seguinte fazer sentido.
    ...(track.albumUri ? { contextUri: track.albumUri, offsetUri: track.uri } : { trackUri: track.uri }),
    name: track.name,
    kind: t('kind.track'),
    subtitle: track.artists,
    imageUrl: track.image,
  };
}

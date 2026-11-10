// Servidor do Spotify a fingir: substitui global.fetch e regista os pedidos feitos.
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const empty = (status = 204) => new Response(null, { status });

/**
 * routes: lista de [método, regex do caminho, handler(req) -> Response | objeto].
 * O caminho é relativo a https://api.spotify.com/v1, ou o URL completo para accounts.spotify.com.
 */
function fakeSpotify(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    const path = url.replace('https://api.spotify.com/v1', '');
    const req = { method, url, path, body: opts.body, json: () => JSON.parse(opts.body), form: () => new URLSearchParams(opts.body) };
    calls.push(`${method} ${path}`);
    for (const [m, re, handler] of routes) {
      if (m === method && re.test(path)) {
        const out = await handler(req);
        return out instanceof Response ? out : json(out);
      }
    }
    throw new Error(`pedido inesperado: ${method} ${path}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

/** Tokens válidos já guardados, com todas as permissões atuais. */
function storedTokens(extra = {}) {
  const scope = [
    'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
    'user-read-recently-played', 'user-top-read', 'playlist-read-private', 'playlist-read-collaborative',
    'user-library-read', 'user-library-modify', 'playlist-modify-private', 'playlist-modify-public',
  ].join(' ');
  return JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000, scope, ...extra });
}

const track = (id, name, artists, extra = {}) => ({
  type: 'track', id, uri: `spotify:track:${id}`, name, duration_ms: 200_000,
  artists: artists.map(([aid, an]) => ({ id: aid, name: an })),
  album: { name: 'Álbum', uri: `spotify:album:al${id}`, images: [{ url: `https://img/${id}` }] },
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  ...extra,
});

module.exports = { fakeSpotify, json, empty, storedTokens, track };

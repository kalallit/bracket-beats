// Cenário: binge de fado recente, mas gosto variado a 6 meses.
const { test } = require('node:test');
const assert = require('assert');
const Module = require('module'); const _l = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? { env: { language: 'pt' }, workspace: { getConfiguration: () => ({ get: (k, d) => k === 'language' ? 'pt' : d }) } } : _l.call(this, r, ...a); };
const dir = require('path').join(__dirname, '../out');
const { Recommender, MOODS } = require(dir + '/recommender.js');

const A = (id, name, genres) => ({ id, name, genres });
const fado = [A('am', 'Amália', ['fado']), A('mz', 'Mariza', ['fado']), A('ca', 'Carminho', ['fado']), A('ar', 'Ana Moura', ['fado']), A('cm', 'Camané', ['fado'])];
const others = [
  A('ma', 'Massive Attack', ['trip hop']), A('bon', 'Bonobo', ['downtempo']), A('rad', 'Radiohead', ['art rock']),
  A('daf', 'Daft Punk', ['french house']), A('bp', 'Buraka Som Sistema', ['kuduro']), A('jb', 'Jorge Palma', ['rock portugues']),
  A('nn', 'Norah Jones', ['jazz pop']), A('ty', 'Tycho', ['chillwave']),
];
const short = [...fado, others[0], others[2]];                 // últimas 4 semanas: quase só fado
const medium = [others[0], others[1], fado[0], others[2], others[3], others[4], fado[1], others[5], others[6], others[7]];
const recent = Array.from({ length: 50 }, (_, i) => fado[i % 5]); // 50 fados seguidos

const pl = (id, name, owner, extra = {}) => ({ id, uri: 'spotify:playlist:' + id, name, description: '', ownerId: owner, ownerName: owner, image: 'https://i/' + id, total: 30, collaborative: false, ...extra });
const playlists = [
  pl('f1', 'Fado da noite', 'me'), pl('f2', 'Amália sempre', 'me'), pl('f3', 'Fado novo', 'me'), pl('f4', 'Mariza & Carminho', 'me'), pl('f5', 'Fados de domingo', 'me'),
  pl('o1', 'Trip hop', 'me'), pl('o2', 'Electrónica para programar', 'me'), pl('o3', 'Rock', 'me'), pl('o4', 'Festa', 'me'), pl('o5', 'Jazz à noite', 'me'),
];
const items = {
  f1: ['am', 'mz', 'ca'], f2: ['am', 'am', 'am'], f3: ['ca', 'ar', 'cm'], f4: ['mz', 'ca'], f5: ['am', 'cm', 'ar'],
  o1: ['ma', 'bon', 'ty'], o2: ['bon', 'daf', 'ty'], o3: ['rad', 'jb'], o4: ['daf', 'bp'], o5: ['nn'],
};
const searches = [];
const fake = {
  getMe: async () => ({ id: 'me', name: 'Leandro' }),
  getTopArtists: async (_n, range) => range === 'medium_term' ? medium : short,
  getRecentArtists: async () => recent.map((a) => ({ ...a, genres: [] })),
  getMyPlaylists: async () => playlists,
  getPlaylistArtistIds: async (id) => items[id] ?? [],
  searchPlaylists: async (q, _l, off = 0) => { searches.push(q); return Array.from({ length: 6 }, (_, i) => pl(`s${q}${off}${i}`.replace(/\W/g, ''), `${q} #${i + 1}`, 'spotify')); },
};

test('diversidade: uma fase de fado não ocupa as sugestões todas', async () => {
  const rec = new Recommender(fake);
  const fy = await rec.forYou();
  const isFado = (c) => /fad|amália|mariza/i.test(c.name);
  void ('Para ti:'); fy.forEach((c, i) => void (`  ${String(i + 1).padStart(2)}. ${isFado(c) ? '🎻' : '  '} ${c.name.padEnd(28)} ${c.reason}`));
  const top5Fado = fy.slice(0, 5).filter(isFado).length;
  void (`  → fado no top 5: ${top5Fado}/5, no total: ${fy.filter(isFado).length}/${fy.length}`);

  const moodGenres = [];
  for (const m of MOODS) {
    searches.length = 0;
    await rec.forMood(m.id);
    moodGenres.push(`${m.id}: ${searches.join(' | ')}`);
  }
  void ('\nPesquisas por mood:'); moodGenres.forEach((l) => void ('  ' + l));
  const fadoMoods = moodGenres.filter((l) => l.includes('fado')).length;
  void (`  → moods temperados com fado: ${fadoMoods}/${MOODS.length}`);

  if (rec.summary) {
    const s = await rec.summary();
    void ('\nPerfil:', s.genres.slice(0, 5).map((g) => `${g.genre} ${g.pct}%`).join(', '));
  }
  {
    assert.ok(top5Fado <= 3, 'top 5 não devia ser quase só fado');
    assert.ok(fadoMoods <= 3, 'fado não devia temperar todos os moods');
    const sh = await rec.forYou(undefined, true);
    assert.ok(sh.length > 0);
    void ('\n✔ diversidade OK');
  }
});

// Corre antes de empacotar (vscode:prepublish). Avisa se o logótipo oficial do Spotify ainda não está em media/spotify/.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'media', 'spotify');
const has = (v) => ['svg', 'png'].some((e) => fs.existsSync(path.join(dir, `logo-${v}.${e}`)));
if (!has('white') && !has('black')) {
  console.warn('\n⚠  Falta o logótipo oficial do Spotify em media/spotify/ (logo-white.svg/png e logo-black.svg/png).');
  console.warn('   As regras de marca do Spotify exigem-no antes de publicar: https://developer.spotify.com/design\n');
}

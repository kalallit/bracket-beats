# Changelog

## 0.9.2
- README com imagens da extensão a funcionar.
- Código no GitHub: https://github.com/kalallit/bracket-beats

## 0.9.1
- Nome no Marketplace: "Bracket Beats for Spotify", para ser mais fácil de encontrar.
- Descrição e etiquetas de pesquisa melhoradas.

## 0.9.0
- **Novo nome: Bracket Beats** (antes "Spotify Now"). As regras de marca do Spotify não permitem "Spotify" no nome de produtos de terceiros.
- Migração automática: definições (`spotifyNow.*` → `bracketBeats.*`, incluindo o Client ID) e histórico local vêm da versão anterior. É preciso voltar a ligar a conta uma vez, e as playlists associadas a projetos têm de ser definidas outra vez.
- Espaço para o logótipo oficial do Spotify na barra lateral, no cartão e no painel, como as regras exigem (ver `media/spotify/README.md`).
- README em inglês para o Marketplace; documentação em português em `README.pt.md`.

## 0.8.2
- Controlo de volume da barra lateral redesenhado: fino como a barra de progresso, sem a caixa azul de foco.

## 0.8.1
- Identidade visual nova: ícone "< equalizador >" (código + som), ícone a condizer na barra lateral, faixa escura na página da extensão.
- Cor de destaque própria (verde-menta) no player, cartão e painel, em vez do verde do Spotify.
- Descrição da extensão atualizada.

## 0.8.0

**Robustez**
- Várias janelas: só a janela em foco faz pedidos; as outras leem o estado partilhado. Sugestão ao arrancar numa só janela.
- Tokens partilhados com segurança entre janelas; falhas temporárias ao renovar já não terminam a sessão.
- Respeita o rate limit do Spotify (429 + `Retry-After`).
- Polling adaptativo e progresso interpolado.
- `extensionKind: ui`: o login funciona em WSL, SSH e Codespaces.
- Cache em disco dos artistas por playlist e dos nomes/capas.

**Player**
- Barra lateral com capa, progresso clicável, aleatório, repetir, volume, dispositivo e fila.
- Gostar / deixar de gostar (barra de estado e barra lateral).
- Pesquisa (`Ctrl+Alt+S`) com tocar e acrescentar à fila.
- Comandos para volume, dispositivo, fila, aleatório e repetir.

**Contexto de programação**
- Playlist por projeto.
- Histórico local (projeto, hora, linguagem) que alimenta sugestões por projeto e por hora.
- Sessões de foco (pomodoro) que pausam a música no intervalo.
- Guardar a sessão como playlist.

**Moods**
- Moods personalizados (`customMoods`) e esconder os de origem (`hiddenMoods`).
- As sugestões aprendem com o que escolhes; ✕ para esconder, 📌 para associar ao projeto.

Exige voltar a ligar a conta uma vez (permissões novas para gostar de músicas e criar playlists).

## 0.7.0
- Assistente de ligação ao Spotify.

## 0.6.0
- Sugestões mais variadas, botão Baralhar, perfil de gostos.

## 0.5.0
- Português e inglês.

## 0.4.0
- Painel de sugestões e moods.

## 0.3.0
- Cartão de sugestão com capa, sem som.

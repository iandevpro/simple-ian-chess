# Simple Ian's Chess

A small, self-contained (HTML/CSS/JS only) chess webapp for GitHub Pages, playing
against a negamax + alpha-beta engine with iterative deepening, an abort-and-move-now
button, and optional Polyglot opening-book support.

## Running it

To preview locally: `python3 -m http.server 8000` from inside this folder, then
open `http://localhost:8000/`.

For GitHub Pages: push this folder's contents to your repo (root, or a `docs/`
folder, or a dedicated branch — whichever you point Pages at) and enable Pages in
the repo settings. No build step, no other dependencies to install.

## What's here

```
index.html
css/styles.css
js/chess.min.js          - chess.js 0.10.3
js/app.js                - UI: board rendering, input, move list, controls
js/engine.worker.js      - negamax/alpha-beta search, runs off the main thread
js/polyglot.js           - Polyglot opening-book parser + Zobrist hashing
js/random64.js           - the standard 781-value Polyglot random table
assets/pieces/*.svg      - 12 piece icons (wP.svg ... bK.svg)
assets/board/            - (empty - the board is drawn with CSS)
assets/book/             - put a .bin opening book here (see below)
```

The engine (`js/engine.worker.js`) is a JavaScript port of a reference Python
negamax/alpha-beta implementation: same evaluation function (material count +
checkmate/stalemate/insufficient-material handling, plus an optional "Pawns Rush"
positional bonus for advanced pawns), same move ordering (checkmate moves first,
then MVV-LVA on captures), same alpha-beta pruning. It adds iterative deepening
(depth 1, 2, 3, ... up to the requested depth) so that pressing **"Abort computer
thinking and move now"** always has a valid best-move-so-far to fall back on.
Chess move generation/legality/FEN comes from
[chess.js](https://github.com/jhlywa/chess.js) 0.10.3 — the same local file both
the main page and the worker load, so make/unmake semantics match exactly. See the
in-page "History, quotes, licenses" section at the bottom of `index.html` for the
full background and attribution.

## Opening book

`js/polyglot.js` is a complete implementation of the Polyglot `.bin` format
(Zobrist hashing verified against all three official test vectors from the format
spec, including the en-passant and castling-encoding edge cases). This copy ships
with `assets/book/gm2001.bin`, which the app loads automatically on startup. To use
a different book instead:

1. Get any other Polyglot `.bin` book (e.g. another one from
   [https://github.com/michaeldv/donna_opening_books/](https://github.com/michaeldv/donna_opening_books/) ).
2. Either replace `assets/book/gm2001.bin` with it, or just use the **file picker**
   under "Opening book" in the UI — that works with any Polyglot `.bin` file, no
   redeploy needed.
3. Tick "Use openings book". While ticked and a book is loaded, the engine plays
   book moves (weighted-random by the book's own weights) whenever the current
   position is in the book, and falls back to search otherwise.

## Notes on the engine / abort behavior

Because JavaScript is single-threaded, an in-progress synchronous search can't be
interrupted *instantly* — the worker can only check for an abort message between
discrete steps. This app yields (and checks the abort flag) **between every
root-level candidate move**, and **between every iterative-deepening depth**, so in
practice "abort and move now" responds within a fraction of a second unless a
single root move's own subtree is itself taking unusually long (rare, since
alpha-beta pruning cuts most branches quickly). Whatever the best move found so far
is at that point is what gets played — never an illegal or null move, unless no
move had been evaluated yet at all (in which case the request just runs to
completion).

## Licensing

This project bundles pieces under three different licenses, so there isn't one
single license that can cover the whole repo — see "History, quotes, licenses" in
`index.html` for the exact sources. In short:

- **The chess piece SVGs** (`assets/pieces/`) are lichess's "staunty" set, by
  **sadsnake1**, under **CC BY-NC-SA 4.0** (Attribution-NonCommercial-ShareAlike) -
  [https://creativecommons.org/licenses/by-nc-sa/4.0/](https://creativecommons.org/licenses/by-nc-sa/4.0/)
- **chess.js** (`js/chess.min.js`) is **BSD-2-Clause** (permissive) -
[https://github.com/jhlywa/chess.js/tree/master?tab=BSD-2-Clause-1-ov-file](https://github.com/jhlywa/chess.js/tree/master?tab=BSD-2-Clause-1-ov-file)
- **The Polyglot opening book** (`assets/book/gm2001.bin`, included) is described as
  free by its author, but check [https://github.com/michaeldv/donna_opening_books/](https://github.com/michaeldv/donna_opening_books/)
  for the exact terms before relying on that for anything beyond personal use.
- **Everything else** (the HTML/CSS/JS written for this project - `index.html`,
  `css/styles.css`, `js/app.js`, `js/engine.worker.js`, `js/polyglot.js`,
  `js/random64.js`) not yet covered by any free/permissive license.

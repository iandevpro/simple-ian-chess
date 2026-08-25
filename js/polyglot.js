/**
 * Polyglot opening book support.
 *
 * Implements:
 *  - Polyglot Zobrist hashing (matches the standard used by every polyglot-compatible
 *    engine/book, including gm2001.bin), ported from python-chess's chess/polyglot.py.
 *  - Binary .bin book parsing (16-byte entries: key, move, weight, learn).
 *  - Move decoding (including the "castling as king-takes-rook" quirk) into the
 *    {from, to, promotion} shape chess.js expects.
 *
 * Requires POLYGLOT_RANDOM64 (random64.js) to be loaded first.
 */

const PolyglotBook = (() => {
  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  // square index 0..63, a1=0, b1=1, ..., h1=7, a2=8, ... h8=63 (polyglot / little-endian rank-file order)
  function squareIndex(file, rank) {
    return rank * 8 + file;
  }

  function algebraicToIndex(square) {
    const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(square[1], 10) - 1;
    return squareIndex(file, rank);
  }

  function indexToAlgebraic(idx) {
    const file = idx % 8;
    const rank = Math.floor(idx / 8);
    return FILES[file] + (rank + 1);
  }

  // Maps a chess.js piece {type, color} to the polyglot "piece index" (0..11).
  // Per the Polyglot spec: black pawn=0, white pawn=1, black knight=2, white
  // knight=3, ... i.e. black=even, white=odd, ordered pawn/knight/bishop/rook/queen/king.
  const PIECE_ORDER = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
  function pieceIndex(pieceType, color) {
    return PIECE_ORDER[pieceType] * 2 + (color === 'w' ? 1 : 0);
  }

  /**
   * Computes the Polyglot Zobrist hash for a chess.js Chess() instance's current position.
   * chess.js exposes `.board()` (8x8 array, rank8->rank1, a->h) and FEN metadata helpers.
   */
  function zobristHash(chess) {
    let hash = 0n;
    const board = chess.board(); // board()[0] = rank 8 ... board()[7] = rank 1

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const piece = board[r][f];
        if (!piece) continue;
        const rank = 7 - r; // convert to 0-based rank from rank1
        const idx = squareIndex(f, rank);
        const pIdx = pieceIndex(piece.type, piece.color);
        hash ^= POLYGLOT_RANDOM64[64 * pIdx + idx];
      }
    }

    // Castling rights - inspect FEN castling field directly (chess.js doesn't
    // expose a per-side helper in the 0.10.x API).
    const fen = chess.fen();
    const castling = fen.split(' ')[2] || '-';
    if (castling.includes('K')) hash ^= POLYGLOT_RANDOM64[768];
    if (castling.includes('Q')) hash ^= POLYGLOT_RANDOM64[768 + 1];
    if (castling.includes('k')) hash ^= POLYGLOT_RANDOM64[768 + 2];
    if (castling.includes('q')) hash ^= POLYGLOT_RANDOM64[768 + 3];

    // En-passant: only hashed in if an enemy pawn could actually capture there
    // (mirrors python-chess's hash_ep_square, which itself mirrors Polyglot's
    // convention of only counting the ep file when the capture is physically
    // possible, regardless of pins/legality).
    const fenParts = fen.split(' ');
    const epSquare = fenParts[3];
    const turn = fenParts[1]; // 'w' or 'b' - side to move now, i.e. potential capturer
    if (epSquare && epSquare !== '-') {
      const epFile = epSquare.charCodeAt(0) - 'a'.charCodeAt(0);
      const epRank = parseInt(epSquare[1], 10); // 1-based rank of the skipped square
      // The pawn that just double-moved actually sits one rank further in
      // the direction of travel: e6 (black's ep target) -> pawn is on e5;
      // e3 (white's ep target) -> pawn is on e4.
      const actualPawnRank = turn === 'w' ? epRank - 1 : epRank + 1;
      const rowIdx = 8 - actualPawnRank; // row index into board() (0 = rank8)
      let hasCapturingPawn = false;
      if (rowIdx >= 0 && rowIdx < 8) {
        for (const df of [-1, 1]) {
          const f = epFile + df;
          if (f < 0 || f > 7) continue;
          const sq = board[rowIdx][f];
          if (sq && sq.type === 'p' && sq.color === turn) {
            hasCapturingPawn = true;
          }
        }
      }
      if (hasCapturingPawn) {
        hash ^= POLYGLOT_RANDOM64[772 + epFile];
      }
    }

    if (turn === 'w') hash ^= POLYGLOT_RANDOM64[780];

    return hash;
  }

  /**
   * Parses an ArrayBuffer containing a polyglot .bin book into an array of entries:
   * { key: BigInt, rawMove: Number, weight: Number, learn: Number }
   * Entries are sorted by key ascending already, per the format spec, but we
   * build a Map<key, entries[]> for O(1) average lookup.
   */
  function parseBook(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const entrySize = 16;
    const count = Math.floor(arrayBuffer.byteLength / entrySize);
    const map = new Map();

    for (let i = 0; i < count; i++) {
      const off = i * entrySize;
      const keyHi = dv.getUint32(off, false);
      const keyLo = dv.getUint32(off + 4, false);
      const key = (BigInt(keyHi) << 32n) | BigInt(keyLo);
      const rawMove = dv.getUint16(off + 8, false);
      const weight = dv.getUint16(off + 10, false);
      const learn = dv.getUint32(off + 12, false);

      const keyStr = key.toString();
      if (!map.has(keyStr)) map.set(keyStr, []);
      map.get(keyStr).push({ key, rawMove, weight, learn });
    }

    return { map, count };
  }

  /**
   * Decodes a polyglot raw move (uint16) into { from, to, promotion } algebraic squares.
   * Handles the "castling encoded as king-takes-rook" quirk used by polyglot books:
   * e1h1 -> e1g1 (white O-O), e1a1 -> e1c1 (white O-O-O), similarly for black.
   */
  function decodeMove(rawMove, chess) {
    const toIdx = rawMove & 0x3f;
    const fromIdx = (rawMove >> 6) & 0x3f;
    const promoPart = (rawMove >> 12) & 0x7;
    const PROMO_PIECES = [null, 'n', 'b', 'r', 'q'];
    let promotion = PROMO_PIECES[promoPart] || undefined;

    let from = indexToAlgebraic(fromIdx);
    let to = indexToAlgebraic(toIdx);

    // Detect castling quirk: king moving from e1/e8 landing on a rook's original square.
    const piece = chess.get(from);
    if (piece && piece.type === 'k') {
      if (from === 'e1' && to === 'h1') to = 'g1';
      else if (from === 'e1' && to === 'a1') to = 'c1';
      else if (from === 'e8' && to === 'h8') to = 'g8';
      else if (from === 'e8' && to === 'a8') to = 'c8';
    }

    return { from, to, promotion };
  }

  /**
   * Looks up book moves for the current position, returns an array of
   * { move: {from,to,promotion}, weight } for all *legal* entries found,
   * or [] if none / book not loaded.
   */
  function findMoves(book, chess) {
    if (!book) return [];
    const key = zobristHash(chess);
    const entries = book.map.get(key.toString());
    if (!entries || entries.length === 0) return [];

    const legalMoves = chess.moves({ verbose: true });
    const results = [];
    for (const entry of entries) {
      if (entry.weight <= 0) continue;
      const decoded = decodeMove(entry.rawMove, chess);
      const match = legalMoves.find(m =>
        m.from === decoded.from &&
        m.to === decoded.to &&
        (decoded.promotion ? m.promotion === decoded.promotion : true)
      );
      if (match) {
        const moveOut = decoded.promotion
          ? { from: decoded.from, to: decoded.to, promotion: decoded.promotion }
          : { from: decoded.from, to: decoded.to };
        results.push({ move: moveOut, weight: entry.weight });
      }
    }
    return results;
  }

  /** Weighted-random pick from findMoves() results (mirrors reader.weighted_choice). */
  function weightedChoice(moves) {
    const total = moves.reduce((s, m) => s + m.weight, 0);
    if (total <= 0) return null;
    let choice = Math.floor(Math.random() * total);
    for (const m of moves) {
      choice -= m.weight;
      if (choice < 0) return m.move;
    }
    return moves[moves.length - 1].move;
  }

  return { parseBook, findMoves, weightedChoice, zobristHash };
})();

if (typeof module !== 'undefined') module.exports = PolyglotBook;

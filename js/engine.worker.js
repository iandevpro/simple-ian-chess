/**
 * Chess engine worker.
 *
 * Runs a negamax + alpha-beta search (ported line-for-line from the reference
 * Python implementation) off the main thread, with iterative deepening so the
 * "abort and move now" button can interrupt a long search and still return the
 * best move found so far.
 *
 * Protocol (postMessage):
 *   -> {type:'loadBook', buffer: ArrayBuffer}
 *   -> {type:'go', fen, depth, useBook}
 *   -> {type:'abort'}
 *   <- {type:'ready'}
 *   <- {type:'bookLoaded', count}
 *   <- {type:'bookError', message}
 *   <- {type:'info', depth, move, score, nodes, elapsedMs}   (progress per completed depth)
 *   <- {type:'bestmove', move, score, depth, nodes, elapsedMs, aborted, fromBook}
 */

importScripts('chess.min.js');
importScripts('random64.js');
importScripts('polyglot.js');

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const CHECKMATE = 99999;
const DRAW = 0;

// "Pawns Rush" evaluation tweak: extra centipawns per rank a pawn has advanced
// from its starting rank, added on top of plain material. Purely additive and
// off by default - only applied while pawnRushEnabled is true for the current
// search (set per-request from the 'go' message).
const PAWN_RUSH_BONUS_PER_RANK = 10;
let pawnRushEnabled = false;

let book = null;
let aborted = false;
let nodeCount = 0;

function materialScore(chess) {
  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const value = PIECE_VALUES[piece.type];
      score += piece.color === 'w' ? value : -value;

      if (pawnRushEnabled && piece.type === 'p') {
        const rank = 8 - r; // board()'s row 0 is rank 8, row 7 is rank 1
        // White pawns start on rank 2 and want to increase rank; black pawns
        // start on rank 7 and want to decrease rank - both expressed as
        // "ranks advanced from start", 0 at the starting rank.
        const advanced = piece.color === 'w' ? rank - 2 : 7 - rank;
        const bonus = advanced * PAWN_RUSH_BONUS_PER_RANK;
        score += piece.color === 'w' ? bonus : -bonus;
      }
    }
  }
  return chess.turn() === 'w' ? score : -score;
}

// Cheap, ordering-only heuristic - no make/unmake needed here at all. chess.js
// already plays each move, checks in_check()/in_checkmate(), and undoes it
// internally while building the '+'/'#' suffix on move.san for every verbose
// move (see move_to_san() in chess.js's source). So the checkmate flag we want
// for ordering is already sitting there for free; doing our own extra
// make/undo/in_checkmate() pass on top (as an earlier version of this file
// did) was pure duplicated work.
function moveScore(move) {
  if (move.san && move.san.charAt(move.san.length - 1) === '#') return CHECKMATE;
  if (move.captured) {
    const victimValue = PIECE_VALUES[move.captured];
    const attackerValue = PIECE_VALUES[move.piece];
    return 10 * victimValue - attackerValue;
  }
  return 0;
}

function orderMoves(rawMoves) {
  return rawMoves
    .map(m => ({ m, s: moveScore(m) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.m);
}

// Note: negamax() is a plain synchronous recursive function. Because the
// worker's event loop can only process an incoming 'abort' postMessage
// between synchronous call stacks, checking `aborted` *inside* this
// recursion would never actually see it flip mid-search - so we don't
// bother here. The real interruption point is between root moves, in
// findBestMoveAtDepth() below, where we explicitly yield with `await`.
//
// Terminal detection (checkmate/stalemate) is folded into the single move
// generation call every node needs anyway, rather than asking chess.js
// separately via in_checkmate()/in_stalemate()/game_over() - each of those
// would silently re-run the entire legal-move generator again internally,
// tripling the work per node for no benefit. (An earlier version of this file
// also called in_threefold_repetition() here, which is dramatically more
// expensive still - it rewinds the *entire* game history back to move one and
// replays it looking for repeated FENs. That check isn't in the reference
// Python this engine is based on either, so it's simply removed rather than
// optimized.)
function negamax(chess, depth, alpha, beta) {
  nodeCount++;
  const rawMoves = chess.moves({ verbose: true });

  if (rawMoves.length === 0) {
    return chess.in_check() ? -CHECKMATE : DRAW;
  }
  if (chess.insufficient_material()) {
    return DRAW;
  }
  if (depth === 0) {
    return materialScore(chess);
  }

  const moves = orderMoves(rawMoves);
  let best = -Infinity;
  for (const move of moves) {
    chess.move(move);
    const score = -negamax(chess, depth - 1, -beta, -alpha);
    chess.undo();

    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Root search for a single fixed depth. Yields control back to the event loop
 * between root moves (so an in-flight 'abort' postMessage can be processed and
 * the aborted flag observed) - this is what makes the abort button responsive
 * even mid-depth, not just between iterative-deepening iterations.
 */
async function findBestMoveAtDepth(chess, depth) {
  const moves = orderMoves(chess.moves({ verbose: true }));
  let bestMove = null;
  let bestScore = -Infinity;

  for (const move of moves) {
    chess.move(move);
    const score = -negamax(chess, depth - 1, -Infinity, Infinity);
    chess.undo();

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }

    // Yield so pending messages (abort) get processed before the next root move.
    await Promise.resolve();
    if (aborted) break;
  }

  return { move: bestMove, score: bestScore };
}

async function findBestMove(fen, targetDepth, useBook, pawnRush) {
  const chess = new Chess(fen);
  aborted = false;
  nodeCount = 0;
  pawnRushEnabled = !!pawnRush;
  const start = performance.now();

  if (useBook && book) {
    const bookMoves = PolyglotBook.findMoves(book, chess);
    if (bookMoves.length > 0) {
      const chosen = PolyglotBook.weightedChoice(bookMoves);
      postMessage({
        type: 'bestmove',
        move: chosen,
        score: null,
        depth: 0,
        nodes: 0,
        elapsedMs: performance.now() - start,
        aborted: false,
        fromBook: true,
      });
      return;
    }
  }

  let lastResult = null;
  let lastDepth = 0;
  for (let d = 1; d <= targetDepth; d++) {
    const result = await findBestMoveAtDepth(chess, d);
    if (result.move) {
      lastResult = result;
      lastDepth = d;
      postMessage({
        type: 'info',
        depth: d,
        move: { from: result.move.from, to: result.move.to, promotion: result.move.promotion },
        score: result.score,
        nodes: nodeCount,
        elapsedMs: performance.now() - start,
      });
    }
    if (aborted) break;
    // Also yield between depths.
    await Promise.resolve();
  }

  if (!lastResult || !lastResult.move) {
    postMessage({ type: 'bestmove', move: null, score: null, depth: 0, nodes: nodeCount, elapsedMs: performance.now() - start, aborted, fromBook: false });
    return;
  }

  postMessage({
    type: 'bestmove',
    move: { from: lastResult.move.from, to: lastResult.move.to, promotion: lastResult.move.promotion },
    score: lastResult.score,
    depth: lastDepth,
    nodes: nodeCount,
    elapsedMs: performance.now() - start,
    aborted,
    fromBook: false,
  });
}

self.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'loadBook': {
      try {
        book = PolyglotBook.parseBook(msg.buffer);
        postMessage({ type: 'bookLoaded', count: book.count });
      } catch (err) {
        book = null;
        postMessage({ type: 'bookError', message: String(err && err.message || err) });
      }
      break;
    }
    case 'unloadBook': {
      book = null;
      break;
    }
    case 'go': {
      findBestMove(msg.fen, msg.depth, msg.useBook, msg.pawnRush);
      break;
    }
    case 'abort': {
      aborted = true;
      break;
    }
    default:
      break;
  }
};

postMessage({ type: 'ready' });

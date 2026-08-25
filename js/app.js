/**
 * Simple Ian's Chess - main UI application.
 *
 * Talks to js/engine.worker.js (negamax + alpha-beta + polyglot book) over
 * postMessage so the search never blocks the UI thread, and the "abort" button
 * can interrupt a long search.
 */

(() => {
  'use strict';

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const PIECE_LABEL = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const game = new Chess();
  let humanColor = 'w';
  let boardFlipped = false;
  let selectedSquare = null;
  let legalTargetsFromSelected = [];
  let lastMove = null; // {from, to}
  let thinking = false;
  let bookBuffer = null;
  let bookLoaded = false;

  const squareEls = {}; // name -> element

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------

  const boardEl = document.getElementById('board');
  const capturedTopEl = document.getElementById('capturedTop');
  const capturedBottomEl = document.getElementById('capturedBottom');
  const statusText = document.getElementById('statusText');
  const statusSub = document.getElementById('statusSub');
  const thinkingDot = document.getElementById('thinkingDot');
  const abortBtn = document.getElementById('abortBtn');
  const movesList = document.getElementById('movesList');
  const newGameBtn = document.getElementById('newGameBtn');
  const undoBtn = document.getElementById('undoBtn');
  const flipBtn = document.getElementById('flipBtn');
  const humanColorSelect = document.getElementById('humanColor');
  const depthSlider = document.getElementById('depthSlider');
  const depthNumber = document.getElementById('depthNumber');
  const depthDisplay = document.getElementById('depthDisplay');
  const useBookCheckbox = document.getElementById('useBookCheckbox');
  const pawnRushCheckbox = document.getElementById('pawnRushCheckbox');
  const bookFileInput = document.getElementById('bookFileInput');
  const bookStatus = document.getElementById('bookStatus');
  const fenInput = document.getElementById('fenInput');
  const loadFenBtn = document.getElementById('loadFenBtn');
  const copyFenBtn = document.getElementById('copyFenBtn');
  const copyPgnBtn = document.getElementById('copyPgnBtn');
  const downloadPgnBtn = document.getElementById('downloadPgnBtn');
  const promoModal = document.getElementById('promoModal');
  const promoBox = document.getElementById('promoBox');

  // ---------------------------------------------------------------------
  // Engine worker
  // ---------------------------------------------------------------------

  const worker = new Worker('js/engine.worker.js');

  worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'ready':
        break;
      case 'bookLoaded':
        bookLoaded = true;
        setBookStatus(`Book loaded: ${msg.count.toLocaleString()} positions.`, 'ok');
        break;
      case 'bookError':
        bookLoaded = false;
        setBookStatus(`Could not read book: ${msg.message}`, 'err');
        break;
      case 'info':
        if (thinking) {
          statusSub.textContent =
            `thinking… depth ${msg.depth}, ${msg.nodes.toLocaleString()} nodes, ` +
            `${(msg.elapsedMs / 1000).toFixed(1)}s, best so far ${msg.move.from}-${msg.move.to}`;
        }
        break;
      case 'bestmove':
        onComputerMove(msg);
        break;
      default:
        break;
    }
  };

  function setBookStatus(text, kind) {
    bookStatus.textContent = text;
    bookStatus.className = 'book-status' + (kind ? ' ' + kind : '');
  }

  // Try to auto-load a book shipped alongside the app, if present. This is
  // expected to 404 until you add assets/book/gm2001.bin yourself (see README).
  fetch('assets/book/gm2001.bin')
    .then(r => {
      if (!r.ok) throw new Error('not found');
      return r.arrayBuffer();
    })
    .then(buf => {
      bookBuffer = buf;
      worker.postMessage({ type: 'loadBook', buffer: buf }, [buf.slice(0)]);
    })
    .catch(() => {
      setBookStatus('No book loaded — will attempt assets/book/gm2001.bin automatically.', '');
    });

  bookFileInput.addEventListener('change', () => {
    const file = bookFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      bookBuffer = reader.result;
      worker.postMessage({ type: 'loadBook', buffer: bookBuffer }, [bookBuffer.slice(0)]);
    };
    reader.onerror = () => setBookStatus('Failed to read file.', 'err');
    reader.readAsArrayBuffer(file);
  });

  // ---------------------------------------------------------------------
  // Board rendering
  // ---------------------------------------------------------------------

  function boardOrderSquares() {
    const ranks = boardFlipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = boardFlipped ? [...FILES].reverse() : FILES;
    const squares = [];
    for (const rank of ranks) {
      for (const file of files) squares.push(file + rank);
    }
    return squares;
  }

  function buildStaticBoard() {
    boardEl.innerHTML = '';
    for (const key in squareEls) delete squareEls[key];

    const order = boardOrderSquares();
    order.forEach((sq, i) => {
      const file = sq[0];
      const rank = sq[1];
      const fileIdx = FILES.indexOf(file);
      const rankIdx = parseInt(rank, 10);
      const isLight = (fileIdx + rankIdx) % 2 === 0;

      const el = document.createElement('div');
      el.className = 'square ' + (isLight ? 'light' : 'dark');
      el.dataset.square = sq;

      // Coordinate labels along the outer edge only.
      const row = Math.floor(i / 8);
      const col = i % 8;
      if (row === 7) {
        const f = document.createElement('span');
        f.className = 'coord file';
        f.textContent = file;
        el.appendChild(f);
      }
      if (col === 0) {
        const r = document.createElement('span');
        r.className = 'coord rank';
        r.textContent = rank;
        el.appendChild(r);
      }

      boardEl.appendChild(el);
      squareEls[sq] = el;
    });
  }

  function pieceImgSrc(piece) {
    // piece: {type, color}
    const colorPrefix = piece.color === 'w' ? 'w' : 'b';
    const typeCode = PIECE_LABEL[piece.type];
    return `assets/pieces/${colorPrefix}${typeCode}.svg`;
  }

  function renderPieces() {
    // Clear existing piece/highlight markup but keep coordinate labels.
    Object.values(squareEls).forEach(el => {
      el.querySelectorAll('.piece-img, .move-dot').forEach(n => n.remove());
      el.classList.remove('highlight-select', 'highlight-lastmove', 'highlight-check', 'highlight-checkmate');
    });

    const board = game.board(); // 8x8, [0]=rank8 ... [7]=rank1, each row a->h
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const piece = board[r][f];
        if (!piece) continue;
        const file = FILES[f];
        const rank = 8 - r;
        const sq = file + rank;
        const el = squareEls[sq];
        if (!el) continue;
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.draggable = false;
        img.src = pieceImgSrc(piece);
        img.alt = piece.color + piece.type;
        img.dataset.square = sq;
        el.appendChild(img);
      }
    }

    if (lastMove) {
      if (squareEls[lastMove.from]) squareEls[lastMove.from].classList.add('highlight-lastmove');
      if (squareEls[lastMove.to]) squareEls[lastMove.to].classList.add('highlight-lastmove');
    }

    if (selectedSquare) {
      if (squareEls[selectedSquare]) squareEls[selectedSquare].classList.add('highlight-select');
      for (const target of legalTargetsFromSelected) {
        const el = squareEls[target.to];
        if (!el) continue;
        const dot = document.createElement('div');
        dot.className = 'move-dot' + (target.captured ? ' capture' : '');
        el.appendChild(dot);
      }
    }

    if (game.in_check()) {
      const turn = game.turn();
      const kingSquare = findKingSquare(turn);
      if (kingSquare && squareEls[kingSquare]) {
        // Checkmate gets the stronger red; a plain check (still escapable) gets orange.
        squareEls[kingSquare].classList.add(game.in_checkmate() ? 'highlight-checkmate' : 'highlight-check');
      }
    }
  }

  function findKingSquare(color) {
    const board = game.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (p && p.type === 'k' && p.color === color) {
          return FILES[f] + (8 - r);
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Input: a single unified pointer pipeline handles both click-to-move and
  // drag-and-drop. (Deliberately NOT mixing this with native 'click' events:
  // a plain click on a piece would fire pointerdown -> our selection logic
  // -> then a synthesized 'click' event on the very same square, which would
  // immediately toggle the selection back off. Handling everything through
  // pointerdown/pointermove/pointerup avoids that race entirely.)
  // ---------------------------------------------------------------------

  const DRAG_THRESHOLD_PX = 4;
  let pointerState = null; // {fromSquare, moved, ghost, startX, startY}

  boardEl.addEventListener('pointerdown', (ev) => {
    if (thinking) return;
    const squareEl = ev.target.closest('.square');
    if (!squareEl) return;
    pointerState = {
      fromSquare: squareEl.dataset.square,
      moved: false,
      ghost: null,
      startX: ev.clientX,
      startY: ev.clientY,
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp, { once: true });
  });

  function onPointerMove(ev) {
    if (!pointerState) return;
    const dx = ev.clientX - pointerState.startX;
    const dy = ev.clientY - pointerState.startY;

    if (!pointerState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      pointerState.moved = true;
      const fromEl = squareEls[pointerState.fromSquare];
      const img = fromEl && fromEl.querySelector('.piece-img');
      if (img) {
        pointerState.ghost = document.createElement('img');
        pointerState.ghost.src = img.src;
        pointerState.ghost.className = 'drag-ghost';
        document.body.appendChild(pointerState.ghost);
        img.classList.add('dragging');
      }
    }
    if (pointerState.moved && pointerState.ghost) {
      pointerState.ghost.style.left = ev.clientX + 'px';
      pointerState.ghost.style.top = ev.clientY + 'px';
    }
  }

  function onPointerUp(ev) {
    document.removeEventListener('pointermove', onPointerMove);
    if (!pointerState) return;
    const { fromSquare, moved, ghost } = pointerState;

    if (ghost) ghost.remove();
    const fromEl = squareEls[fromSquare];
    const draggedImg = fromEl && fromEl.querySelector('.piece-img.dragging');
    if (draggedImg) draggedImg.classList.remove('dragging');

    const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
    const targetSquareEl = targetEl && targetEl.closest('.square');
    const toSquare = targetSquareEl ? targetSquareEl.dataset.square : null;

    pointerState = null;
    if (thinking) return;

    if (moved) {
      handleDrop(fromSquare, toSquare);
    } else {
      handleTap(fromSquare);
    }
  }

  function handleDrop(fromSquare, toSquare) {
    if (toSquare && toSquare !== fromSquare) {
      const piece = game.get(fromSquare);
      if (piece && piece.color === game.turn() && piece.color === humanColor) {
        const legal = game.moves({ square: fromSquare, verbose: true });
        if (legal.some(m => m.to === toSquare)) {
          attemptMove(fromSquare, toSquare);
          return;
        }
      }
    }
    // No valid drop target, or dropped back on the origin square: cancel.
    clearSelection();
    renderPieces();
  }

  function handleTap(sq) {
    if (selectedSquare) {
      if (sq === selectedSquare) {
        clearSelection();
        renderPieces();
        return;
      }
      const isLegalTarget = legalTargetsFromSelected.some(t => t.to === sq);
      if (isLegalTarget) {
        attemptMove(selectedSquare, sq);
        return;
      }
      // Fall through: maybe tapping a different own piece to reselect.
    }

    const piece = game.get(sq);
    if (piece && piece.color === game.turn() && piece.color === humanColor) {
      selectSquare(sq);
    } else {
      clearSelection();
    }
    renderPieces();
  }

  function selectSquare(sq) {
    selectedSquare = sq;
    legalTargetsFromSelected = game.moves({ square: sq, verbose: true });
    renderPieces();
  }

  function clearSelection() {
    selectedSquare = null;
    legalTargetsFromSelected = [];
  }

  function attemptMove(from, to) {
    const piece = game.get(from);
    const isPromotion = piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1');

    clearSelection();

    if (isPromotion) {
      showPromotionDialog(piece.color, (promo) => {
        finalizeHumanMove(from, to, promo);
      });
      return;
    }
    finalizeHumanMove(from, to, undefined);
  }

  // ---------------------------------------------------------------------
  // Move animation (a lightweight FLIP-style slide). Since the squares
  // themselves never move, we don't need to snapshot anything before the
  // re-render: after renderPieces() has rebuilt the DOM, the moved piece is
  // already sitting in its destination square, so we just measure the two
  // (static) square positions, offset the piece back to where it started
  // with no transition, then let it transition to (0,0).
  // ---------------------------------------------------------------------

  const MOVE_ANIMATION_MS = 220;

  function buildAnimationPairs(move) {
    const pairs = [{ from: move.from, to: move.to }];
    if (move.flags && move.flags.indexOf('k') !== -1) {
      const rank = move.color === 'w' ? '1' : '8';
      pairs.push({ from: 'h' + rank, to: 'f' + rank }); // castling rook, kingside
    } else if (move.flags && move.flags.indexOf('q') !== -1) {
      const rank = move.color === 'w' ? '1' : '8';
      pairs.push({ from: 'a' + rank, to: 'd' + rank }); // castling rook, queenside
    }
    return pairs;
  }

  function playSlideAnimation(pairs) {
    pairs.forEach(({ from, to }) => {
      const fromEl = squareEls[from];
      const toEl = squareEls[to];
      if (!fromEl || !toEl) return;
      const img = toEl.querySelector('.piece-img');
      if (!img) return;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const dx = fromRect.left - toRect.left;
      const dy = fromRect.top - toRect.top;
      if (dx === 0 && dy === 0) return;

      img.style.transition = 'none';
      img.style.transform = `translate(${dx}px, ${dy}px)`;
      void img.offsetWidth; // force reflow so the transition below actually animates
      img.style.transition = `transform ${MOVE_ANIMATION_MS}ms ease-out`;
      img.style.transform = 'translate(0, 0)';

      const cleanup = () => {
        img.style.transition = '';
        img.style.transform = '';
        img.removeEventListener('transitionend', cleanup);
      };
      img.addEventListener('transitionend', cleanup);
      setTimeout(cleanup, MOVE_ANIMATION_MS + 80); // fallback if transitionend doesn't fire
    });
  }

  function finalizeHumanMove(from, to, promotion) {
    const moveObj = promotion ? { from, to, promotion } : { from, to };
    const move = game.move(moveObj);
    if (!move) {
      renderPieces();
      return;
    }
    lastMove = { from, to };
    afterAnyMove();
    playSlideAnimation(buildAnimationPairs(move));

    if (!game.game_over() && game.turn() !== humanColor) {
      requestComputerMove();
    }
  }

  function showPromotionDialog(color, callback) {
    promoBox.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(type => {
      const btn = document.createElement('button');
      const img = document.createElement('img');
      img.src = pieceImgSrc({ color, type });
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        promoModal.hidden = true;
        callback(type);
      });
      promoBox.appendChild(btn);
    });
    promoModal.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Computer move
  // ---------------------------------------------------------------------

  function requestComputerMove() {
    thinking = true;
    abortBtn.disabled = false;
    thinkingDot.hidden = false;
    statusSub.textContent = 'thinking…';
    updateStatus();

    const depth = clampDepth(parseInt(depthNumber.value, 10) || 4);
    worker.postMessage({
      type: 'go',
      fen: game.fen(),
      depth,
      useBook: useBookCheckbox.checked && bookLoaded,
      pawnRush: pawnRushCheckbox.checked,
    });
  }

  function onComputerMove(msg) {
    thinking = false;
    abortBtn.disabled = true;
    thinkingDot.hidden = true;

    if (!msg.move) {
      statusSub.textContent = 'engine found no move (game over?)';
      updateStatus();
      return;
    }

    const moveObj = msg.move.promotion
      ? { from: msg.move.from, to: msg.move.to, promotion: msg.move.promotion }
      : { from: msg.move.from, to: msg.move.to };
    const move = game.move(moveObj);
    if (!move) {
      statusSub.textContent = 'engine proposed an illegal move (ignored)';
      updateStatus();
      return;
    }
    lastMove = { from: msg.move.from, to: msg.move.to };

    if (msg.fromBook) {
      statusSub.textContent = 'played from opening book';
    } else {
      const scoreTxt = typeof msg.score === 'number' ? `eval ${(msg.score / 100).toFixed(2)}` : '';
      statusSub.textContent =
        `depth ${msg.depth}${msg.aborted ? ' (aborted)' : ''}, ${msg.nodes.toLocaleString()} nodes, ` +
        `${(msg.elapsedMs / 1000).toFixed(1)}s ${scoreTxt}`;
    }

    afterAnyMove();
    playSlideAnimation(buildAnimationPairs(move));
  }

  abortBtn.addEventListener('click', () => {
    worker.postMessage({ type: 'abort' });
  });

  // ---------------------------------------------------------------------
  // Captured pieces trays (above/below the board) + material difference
  // ---------------------------------------------------------------------

  const STARTING_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const PIECE_VALUES_UI = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const CAPTURE_DISPLAY_ORDER = ['p', 'n', 'b', 'r', 'q'];

  function computeCaptured() {
    const counts = {
      w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
      b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    };
    const board = game.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const piece = board[r][f];
        if (!piece || piece.type === 'k') continue;
        counts[piece.color][piece.type]++;
      }
    }

    // Pieces missing from the board of a given color are the pieces the
    // *opponent* has captured.
    const capturedFromWhite = {}; // white pieces black has taken
    const capturedFromBlack = {}; // black pieces white has taken
    let whiteCapturedValue = 0; // value of black pieces white has taken
    let blackCapturedValue = 0; // value of white pieces black has taken

    for (const type of CAPTURE_DISPLAY_ORDER) {
      capturedFromWhite[type] = Math.max(0, STARTING_COUNTS[type] - counts.w[type]);
      capturedFromBlack[type] = Math.max(0, STARTING_COUNTS[type] - counts.b[type]);
      blackCapturedValue += capturedFromWhite[type] * PIECE_VALUES_UI[type];
      whiteCapturedValue += capturedFromBlack[type] * PIECE_VALUES_UI[type];
    }

    return { capturedFromWhite, capturedFromBlack, whiteCapturedValue, blackCapturedValue };
  }

  function renderCapturedTray(container, capturedCounts, color, scoreBadge) {
    container.innerHTML = '';
    for (const type of CAPTURE_DISPLAY_ORDER) {
      const count = capturedCounts[type];
      for (let i = 0; i < count; i++) {
        const img = document.createElement('img');
        img.className = 'captured-piece';
        img.src = pieceImgSrc({ color, type });
        img.alt = color + type;
        container.appendChild(img);
      }
    }
    if (scoreBadge) {
      const badge = document.createElement('span');
      badge.className = 'captured-score';
      badge.textContent = '+' + scoreBadge;
      container.appendChild(badge);
    }
  }

  function renderCapturedPieces() {
    const { capturedFromWhite, capturedFromBlack, whiteCapturedValue, blackCapturedValue } = computeCaptured();
    const diff = whiteCapturedValue - blackCapturedValue;

    // White's tray shows the black pieces white has captured, and vice versa.
    const whiteTrayEl = boardFlipped ? capturedTopEl : capturedBottomEl;
    const blackTrayEl = boardFlipped ? capturedBottomEl : capturedTopEl;

    renderCapturedTray(whiteTrayEl, capturedFromBlack, 'b', diff > 0 ? diff : null);
    renderCapturedTray(blackTrayEl, capturedFromWhite, 'w', diff < 0 ? -diff : null);
  }

  // ---------------------------------------------------------------------
  // Shared post-move bookkeeping
  // ---------------------------------------------------------------------

  function afterAnyMove() {
    renderPieces();
    renderCapturedPieces();
    renderMoveList();
    updateStatus();
    fenInput.value = game.fen();
  }

  function updateStatus() {
    let text = '';
    if (game.in_checkmate()) {
      const winner = game.turn() === 'w' ? 'Black' : 'White';
      text = `Checkmate — ${winner} wins`;
    } else if (game.in_stalemate()) {
      text = 'Draw by stalemate';
    } else if (game.in_threefold_repetition()) {
      text = 'Draw by threefold repetition';
    } else if (game.insufficient_material()) {
      text = 'Draw by insufficient material';
    } else if (game.in_draw()) {
      text = 'Draw';
    } else {
      const turnName = game.turn() === 'w' ? 'White' : 'Black';
      text = `${turnName} to move` + (game.in_check() ? ' — check!' : '');
    }
    statusText.textContent = text;
    if (!thinking && !game.game_over()) statusSub.textContent = '';
  }

  function renderMoveList() {
    const history = game.history();
    movesList.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = (i / 2 + 1) + '.';
      const white = document.createElement('div');
      white.textContent = history[i] || '';
      const black = document.createElement('div');
      black.textContent = history[i + 1] || '';
      movesList.appendChild(num);
      movesList.appendChild(white);
      movesList.appendChild(black);
    }
    movesList.scrollTop = movesList.scrollHeight;
  }

  // ---------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------

  function clampDepth(v) {
    return Math.max(1, Math.min(100, v));
  }

  depthSlider.addEventListener('input', () => {
    depthNumber.value = depthSlider.value;
    depthDisplay.textContent = depthSlider.value;
  });
  depthNumber.addEventListener('input', () => {
    const v = clampDepth(parseInt(depthNumber.value, 10) || 1);
    if (v <= parseInt(depthSlider.max, 10)) depthSlider.value = v;
    depthDisplay.textContent = v;
  });

  newGameBtn.addEventListener('click', () => {
    if (thinking) worker.postMessage({ type: 'abort' });
    game.reset();
    lastMove = null;
    clearSelection();
    humanColor = humanColorSelect.value;
    thinking = false;
    abortBtn.disabled = true;
    thinkingDot.hidden = true;
    afterAnyMove();
    if (game.turn() !== humanColor) requestComputerMove();
  });

  undoBtn.addEventListener('click', () => {
    if (thinking || game.history().length === 0) return;
    // Undo the last move, then, if that leaves it not-the-human's-turn,
    // undo once more so the human always gets to redo their own move.
    game.undo();
    if (game.history().length > 0 && game.turn() !== humanColor) {
      game.undo();
    }
    clearSelection();
    lastMove = null;
    afterAnyMove();
    if (!game.game_over() && game.turn() !== humanColor) requestComputerMove();
  });

  flipBtn.addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    buildStaticBoard();
    renderPieces();
    renderCapturedPieces();
  });

  humanColorSelect.addEventListener('change', () => {
    humanColor = humanColorSelect.value;
  });

  useBookCheckbox.addEventListener('change', () => {
    if (useBookCheckbox.checked && !bookLoaded) {
      setBookStatus('No book loaded yet — choose a .bin file above.', 'err');
    }
  });

  loadFenBtn.addEventListener('click', () => {
    const fen = fenInput.value.trim();
    if (!fen) return;
    const ok = game.load(fen);
    if (!ok) {
      alert('Invalid FEN.');
      return;
    }
    lastMove = null;
    clearSelection();
    afterAnyMove();
    if (!game.game_over() && game.turn() !== humanColor) requestComputerMove();
  });

  copyFenBtn.addEventListener('click', () => {
    fenInput.value = game.fen();
    fenInput.select();
    document.execCommand('copy');
  });

  // ---------------------------------------------------------------------
  // PGN export
  // ---------------------------------------------------------------------

  function gameResultTag() {
    if (game.in_checkmate()) return game.turn() === 'w' ? '0-1' : '1-0';
    if (game.in_draw() || game.in_stalemate() || game.in_threefold_repetition() || game.insufficient_material()) {
      return '1/2-1/2';
    }
    return '*';
  }

  function buildPgn() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const pgnDate = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
    const depth = clampDepth(parseInt(depthNumber.value, 10) || 4);
    const whiteName = humanColor === 'w' ? 'Human' : `Simple Ian's Chess (depth ${depth})`;
    const blackName = humanColor === 'b' ? 'Human' : `Simple Ian's Chess (depth ${depth})`;

    game.header(
      'Event', 'Casual Game',
      'Site', "Simple Ian's Chess (browser)",
      'Date', pgnDate,
      'White', whiteName,
      'Black', blackName,
      'Result', gameResultTag()
    );
    return game.pgn({ max_width: 80, newline_char: '\n' });
  }

  function flashTooltip(btn, tempText, duration = 1200) {
    const original = btn.dataset.tooltip;
    btn.dataset.tooltip = tempText;
    btn.disabled = true;
    setTimeout(() => {
      btn.dataset.tooltip = original;
      btn.disabled = false;
    }, duration);
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        // fall through to legacy fallback below
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  copyPgnBtn.addEventListener('click', async () => {
    const pgn = buildPgn();
    const ok = await copyTextToClipboard(pgn);
    flashTooltip(copyPgnBtn, ok ? 'Copied!' : 'Copy failed');
  });

  downloadPgnBtn.addEventListener('click', () => {
    const pgn = buildPgn();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename =
      `chess-game-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.pgn`;

    const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    flashTooltip(downloadPgnBtn, 'Downloaded!');
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  buildStaticBoard();
  fenInput.value = game.fen();
  afterAnyMove();
})();

// Chess board renderer with click-to-move + tier-locked skins.
import { sfx, unlockAudio } from "./sounds.js";

const UNICODE = {
  "P": "♙", "N": "♘", "B": "♗", "R": "♖", "Q": "♕", "K": "♔",
  "p": "♟", "n": "♞", "b": "♝", "r": "♜", "q": "♛", "k": "♚",
};

const FILES = "abcdefgh";

// Board skins per tier — matches backend elo.py BOARD_SKINS
const TIER_SKINS = {
  bronze:      { light: "#ead9b8", dark: "#b58863", name: "Classic Bronze" },
  silver:      { light: "#dbeafe", dark: "#3b82f6", name: "Ocean Silver" },
  gold:        { light: "#dcfce7", dark: "#16a34a", name: "Forest Gold" },
  diamond:     { light: "#ede9fe", dark: "#7c3aed", name: "Royal Diamond" },
  grandmaster: { light: "#334155", dark: "#0f172a", name: "Void Grandmaster" },
};

export class ChessBoard {
  constructor(container) {
    this.container = container;
    this.state = null;
    this.myColor = null;
    this.whiteId = null;
    this.blackId = null;
    this.myTier = "bronze";
    this.onMove = null;
    this.onResign = null;
    this.selected = null;
    this.lastMove = null;
    this._build();
  }

  _build() {
    this.container.innerHTML = "";
    this.container.classList.add("chess-root");

    this.statusBar = document.createElement("div");
    this.statusBar.className = "chess-status-bar";
    this.container.appendChild(this.statusBar);

    this.tierLabel = document.createElement("div");
    this.tierLabel.className = "chess-tier-label";
    this.container.appendChild(this.tierLabel);

    this.board = document.createElement("div");
    this.board.className = "chess-board";
    this.container.appendChild(this.board);

    this.msgBar = document.createElement("div");
    this.msgBar.className = "chess-msg-bar";
    this.container.appendChild(this.msgBar);

    this.resignBtn = document.createElement("button");
    this.resignBtn.className = "chess-resign-btn";
    this.resignBtn.textContent = "🏳️ Resign";
    this.resignBtn.addEventListener("click", () => {
      if (confirm("Resign this game?")) this.onResign && this.onResign();
    });
    this.container.appendChild(this.resignBtn);
  }

  setIdentity(userId, whiteId, blackId, myTier = "bronze") {
    this.whiteId = whiteId;
    this.blackId = blackId;
    this.myTier = myTier || "bronze";
    if (userId === whiteId) this.myColor = "w";
    else if (userId === blackId) this.myColor = "b";
    else this.myColor = "w";
    this._updateTierLabel();
  }

  _updateTierLabel() {
    const skin = TIER_SKINS[this.myTier] || TIER_SKINS.bronze;
    const icons = {
      bronze: "🥉", silver: "🥈", gold: "🥇", diamond: "💎", grandmaster: "👑",
    };
    const icon = icons[this.myTier] || "🥉";
    this.tierLabel.textContent = `${icon} ${skin.name}`;
    this.tierLabel.style.color = skin.dark;
  }

  setCallbacks({ onMove, onResign }) {
    this.onMove = onMove;
    this.onResign = onResign;
  }



    playOpponentMoveSound(isCapture = false) {
    try {
      if (isCapture) sfx.chessCapture();
      else sfx.chessMove();
    } catch {}
  }

  playCheckSound() {
    try { sfx.chessCheck(); } catch {}
  }

  update(state) {
    this.state = state;
    this._render();
  }

  setLastMove(uci) {
    if (!uci || uci.length < 4) return;
    const fr = 8 - parseInt(uci[1]), fc = FILES.indexOf(uci[0]);
    const tr = 8 - parseInt(uci[3]), tc = FILES.indexOf(uci[2]);
    this.lastMove = { from: [fr, fc], to: [tr, tc] };
  }

  _sq(r, c) { return FILES[c] + String(8 - r); }

  _render() {
    if (!this.state || !this.state.squares) return;
    this.board.innerHTML = "";

    const skin = TIER_SKINS[this.myTier] || TIER_SKINS.bronze;
    const legalSet = new Set(this.state.legal_moves || []);
    const flip = this.myColor === "b";

    let legalDests = new Set();
    if (this.selected) {
      const from = this._sq(this.selected.r, this.selected.c);
      for (const mv of legalSet) {
        if (mv.startsWith(from)) {
          legalDests.add(mv.slice(2, 4));
        }
      }
    }

    for (let dRow = 0; dRow < 8; dRow++) {
      for (let dCol = 0; dCol < 8; dCol++) {
        const r = flip ? 7 - dRow : dRow;
        const c = flip ? 7 - dCol : dCol;
        const piece = this.state.squares[r][c];
        const isLight = (r + c) % 2 === 0;
        const sqName = this._sq(r, c);
        const isSelected = this.selected && this.selected.r === r && this.selected.c === c;
        const isLegalDest = legalDests.has(sqName);
        const isLastMove = this.lastMove && (
          (this.lastMove.from[0] === r && this.lastMove.from[1] === c) ||
          (this.lastMove.to[0] === r && this.lastMove.to[1] === c)
        );

        const cell = document.createElement("div");
        cell.className = "chess-cell";
        cell.style.background = isLight ? skin.light : skin.dark;
        if (isSelected) cell.classList.add("chess-selected");
        if (isLastMove) cell.classList.add("chess-lastmove");
        if (isLegalDest && piece === ".") cell.classList.add("chess-dest");
        if (isLegalDest && piece !== ".") cell.classList.add("chess-capture");

        if (this.state.in_check) {
          const isKing = (this.state.turn === "w" && piece === "K")
                       || (this.state.turn === "b" && piece === "k");
          if (isKing) cell.classList.add("chess-check");
        }

        if (piece !== ".") {
          const el = document.createElement("div");
          el.className = "chess-piece";
          el.textContent = UNICODE[piece] || "?";
          el.classList.add(piece === piece.toUpperCase() ? "chess-white" : "chess-black");
          cell.appendChild(el);

          const isMine = (this.myColor === "w" && piece === piece.toUpperCase())
                      || (this.myColor === "b" && piece === piece.toLowerCase());
          const isMyTurn = this.state.turn === this.myColor;
          if (isMine && isMyTurn && !this.state.result) {
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              this.selected = { r, c };
              this._render();
            });
            cell.style.cursor = "pointer";
          }
        }

        cell.addEventListener("click", () => {
          if (this.selected && isLegalDest) {
            this._attemptMove(this.selected.r, this.selected.c, r, c);
          } else {
            this.selected = null;
            this._render();
          }
        });

        const isBottomRow = dRow === 7;
        const isLeftCol = dCol === 0;
        if (isBottomRow) {
          const lbl = document.createElement("div");
          lbl.className = "chess-coord chess-coord-file";
          lbl.textContent = sqName[0];
          cell.appendChild(lbl);
        }
        if (isLeftCol) {
          const lbl = document.createElement("div");
          lbl.className = "chess-coord chess-coord-rank";
          lbl.textContent = sqName[1];
          cell.appendChild(lbl);
        }

        this.board.appendChild(cell);
      }
    }

    this._renderStatus();
  }

    _attemptMove(fromR, fromC, toR, toC) {
    unlockAudio();
    const uciBase = this._sq(fromR, fromC) + this._sq(toR, toC);
    const piece = this.state.squares[fromR][fromC];
    const target = this.state.squares[toR][toC];
    const isPromo = piece.toUpperCase() === "P" && (toR === 0 || toR === 7);
    const isCapture = target !== ".";

    this.selected = null;

    // Play sound immediately — feels responsive
    try {
      if (isCapture) sfx.chessCapture();
      else sfx.chessMove();
    } catch {}

    if (isPromo) {
      const raw = prompt("Promote to: Q / R / B / N", "Q");
      if (!raw) { this._render(); return; }
      const promo = ["Q","R","B","N"].includes(raw.toUpperCase()) ? raw.toUpperCase() : "Q";
      this.onMove && this.onMove(uciBase + promo.toLowerCase());
    } else {
      this.onMove && this.onMove(uciBase);
    }
  }

  _renderStatus() {
    if (!this.state) return;
    let txt = "";
    if (this.state.result) {
      if (this.state.result === "draw") txt = "🤝 Draw";
      else if (this.state.result === this.myColor) txt = "🏆 You won!";
      else txt = "You lost";
    } else if (this.state.turn === this.myColor) {
      txt = this.state.in_check ? "⚠️ Your turn — YOU ARE IN CHECK" : "● Your turn";
    } else {
      txt = "Opponent's turn…";
    }
    this.statusBar.textContent = txt;

    const over = !!this.state.result;
    this.resignBtn.style.display = over ? "none" : "block";
  }

  showMessage(text, type = "info") {
    this.msgBar.textContent = text;
    this.msgBar.className = `chess-msg-bar chess-msg-${type}`;
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => {
      this.msgBar.textContent = "";
      this.msgBar.className = "chess-msg-bar";
    }, 3000);
  }
}
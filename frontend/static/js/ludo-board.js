// Ludo board — bulletproof click handling + debug logs.

const LOOP_LEN = 52;
const HOME_POS = 56;

const OUTER_LOOP = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],
  [6,0],
];

const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };

const HOME_COLUMNS = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7]],
};

const HOME_CELLS = {
  red: [7,6], green: [6,7], yellow: [7,8], blue: [8,7],
};

const BASE_SLOTS = {
  red:    [[1.5,1.5],[1.5,4.0],[4.0,1.5],[4.0,4.0]],
  green:  [[1.5,10.5],[1.5,13.0],[4.0,10.5],[4.0,13.0]],
  yellow: [[10.5,10.5],[10.5,13.0],[13.0,10.5],[13.0,13.0]],
  blue:   [[10.5,1.5],[10.5,4.0],[13.0,1.5],[13.0,4.0]],
};

const SAFE_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

const COLOR_STYLE = {
  red:    { main: "#ef4444", dark: "#7f1d1d" },
  green:  { main: "#22c55e", dark: "#14532d" },
  yellow: { main: "#eab308", dark: "#713f12" },
  blue:   { main: "#3b82f6", dark: "#1e3a8a" },
};

const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

console.log("[Ludo v3] module loaded");

function relToAbs(color, rel) {
  if (rel === -1) return null;
  if (rel === HOME_POS) return HOME_CELLS[color];
  if (rel >= 0 && rel <= 50) return OUTER_LOOP[(START_INDEX[color] + rel) % LOOP_LEN];
  if (rel >= 51 && rel <= 55) return HOME_COLUMNS[color][rel - 51];
  return null;
}

// ---- Sound ----
let _audioCtx = null;
function getAudioCtx() {
  if (_audioCtx) return _audioCtx;
  try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { _audioCtx = null; }
  return _audioCtx;
}
function tone(freq, dur, type = "sine", vol = 0.06, delay = 0) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(vol, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur);
}
const SFX = {
  rollTick:  () => tone(380, 0.05, "square", 0.04),
  rollLand:  (n) => tone(600 + n * 40, 0.15, "triangle", 0.09),
  move:      () => tone(560, 0.09, "sine", 0.06),
  capture:   () => { tone(220, 0.2, "sawtooth", 0.08); tone(180, 0.3, "sawtooth", 0.06, 0.05); },
  win:       () => [660, 880, 1100, 1320].forEach((f, i) => tone(f, 0.35, "sine", 0.08, i * 0.12)),
  lose:      () => [440, 330, 220].forEach((f, i) => tone(f, 0.35, "sine", 0.07, i * 0.12)),
  yourTurn:  () => { tone(880, 0.12, "sine", 0.07); tone(1100, 0.18, "sine", 0.07, 0.1); },
  noMove:    () => tone(260, 0.18, "triangle", 0.05),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LudoBoard {
  constructor(container) {
    console.log("[Ludo v3] constructor");
    this.container = container;
    this.myId = null;
    this.state = null;
    this.onRoll = null;
    this.onMove = null;
    this.legalMoves = [];
    this._lastCurrentUserId = null;
    this._busy = false;
    this._build();
  }

  _build() {
    this.container.innerHTML = "";
    this.container.classList.add("ludo-root");

    this.statusBar = document.createElement("div");
    this.statusBar.className = "ludo-status-bar";
    this.container.appendChild(this.statusBar);

    this.boardWrap = document.createElement("div");
    this.boardWrap.className = "ludo-board-wrap";
    this.container.appendChild(this.boardWrap);

    this.board = document.createElement("div");
    this.board.className = "ludo-board";
    this.boardWrap.appendChild(this.board);

    this._buildCells();

    this.tokenLayer = document.createElement("div");
    this.tokenLayer.className = "ludo-token-layer";
    this.board.appendChild(this.tokenLayer);

    // Delegation safety net
    this.tokenLayer.addEventListener("click", (e) => {
      console.log("[Ludo v3] layer click. target=", e.target, "classes=", e.target.className);
      const el = e.target.closest(".ludo-token-movable");
      if (!el) { console.log("[Ludo v3] not a movable token"); return; }
      const idx = parseInt(el.dataset.tokenIndex, 10);
      console.log("[Ludo v3] movable token clicked idx=", idx);
      this._fireMove(idx);
    });

    this.turnBanner = document.createElement("div");
    this.turnBanner.className = "ludo-turn-banner";
    this.boardWrap.appendChild(this.turnBanner);

    this.winOverlay = document.createElement("div");
    this.winOverlay.className = "ludo-win-overlay";
    this.boardWrap.appendChild(this.winOverlay);

    this.diceBar = document.createElement("div");
    this.diceBar.className = "ludo-dice-bar";
    this.container.appendChild(this.diceBar);

    this.diceResult = document.createElement("div");
    this.diceResult.className = "ludo-dice-result";
    this.container.appendChild(this.diceResult);

    this.msgBar = document.createElement("div");
    this.msgBar.className = "ludo-msg-bar";
    this.container.appendChild(this.msgBar);
  }

  _fireMove(idx) {
    if (Number.isNaN(idx)) { console.log("[Ludo v3] bad idx"); return; }
    if (this._busy) { console.log("[Ludo v3] busy, ignoring"); return; }
    this._busy = true;
    setTimeout(() => { this._busy = false; }, 800);
    console.log("[Ludo v3] firing onMove(", idx, ")");
    if (this.onMove) this.onMove(idx);
    else console.log("[Ludo v3] onMove not set!");
  }

  _buildCells() {
    const baseDefs = [
      { color: "red",    area: "1 / 1 / 7 / 7" },
      { color: "green",  area: "1 / 10 / 7 / 16" },
      { color: "yellow", area: "10 / 10 / 16 / 16" },
      { color: "blue",   area: "10 / 1 / 16 / 7" },
    ];
    for (const b of baseDefs) {
      const el = document.createElement("div");
      el.className = `ludo-base ludo-base-${b.color}`;
      el.style.gridArea = b.area;
      el.innerHTML = `<div class="ludo-base-inner"></div>`;
      this.board.appendChild(el);
    }

    const pathKeys = new Set(OUTER_LOOP.map(([r, c]) => `${r},${c}`));
    const safeKeys = new Set();
    for (const idx of SAFE_INDICES) {
      const [r, c] = OUTER_LOOP[idx];
      safeKeys.add(`${r},${c}`);
    }
    const homeColKey = {};
    for (const [color, cells] of Object.entries(HOME_COLUMNS)) {
      for (const [r, c] of cells) homeColKey[`${r},${c}`] = color;
    }
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const isBase =
          (r <= 5 && c <= 5) || (r <= 5 && c >= 9) ||
          (r >= 9 && c >= 9) || (r >= 9 && c <= 5);
        if (isBase) continue;
        const isCenter = r >= 6 && r <= 8 && c >= 6 && c <= 8;
        if (isCenter) continue;

        const key = `${r},${c}`;
        const div = document.createElement("div");
        div.className = "ludo-cell";
        div.style.gridArea = `${r + 1} / ${c + 1} / ${r + 2} / ${c + 2}`;
        if (homeColKey[key]) div.classList.add("ludo-home-col", `ludo-home-${homeColKey[key]}`);
        else if (pathKeys.has(key)) {
          div.classList.add("ludo-path");
          if (safeKeys.has(key)) div.classList.add("ludo-safe");
        } else div.classList.add("ludo-void");
        this.board.appendChild(div);
      }
    }

    const center = document.createElement("div");
    center.className = "ludo-center";
    center.style.gridArea = "7 / 7 / 10 / 10";
    center.innerHTML = `
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon points="0,0 100,0 50,50" fill="#22c55e"/>
        <polygon points="100,0 100,100 50,50" fill="#eab308"/>
        <polygon points="100,100 0,100 50,50" fill="#3b82f6"/>
        <polygon points="0,100 0,0 50,50" fill="#ef4444"/>
      </svg>`;
    this.board.appendChild(center);
  }

  setIdentity(myId) { this.myId = myId; }

  setCallbacks({ onRoll, onMove }) {
    this.onRoll = onRoll;
    this.onMove = onMove;
    console.log("[Ludo v3] callbacks set. onRoll:", !!onRoll, "onMove:", !!onMove);
  }

  async handleStart(state) {
    this.state = state;
    this._lastCurrentUserId = state.current_user_id;
    this.update(state, { legalMoves: [] });
    this.showMessage("Game started. Roll 6 to release a token.", "info");
    await sleep(300);
    this._announceTurn(state);
  }

  async handleRoll({ userId, roll, legalMoves, state }) {
    const isMine = userId === this.myId;
    const hasMoves = legalMoves.length > 0;
    const stillMyTurn = state.current_user_id === this.myId;

    await this._spinDice(roll);

    this.diceResult.textContent = String(roll);
    this.diceResult.classList.add("show");
    SFX.rollLand(roll);

    let msg = "", msgType = "info";
    if (isMine && hasMoves) {
      msg = `You rolled ${roll}! Click a glowing token.`;
      msgType = "success";
    } else if (isMine && !hasMoves) {
      msg = stillMyTurn ? `Rolled ${roll} — no moves. Roll again.` : `Rolled ${roll} — no moves. Turn passes.`;
      msgType = "warn";
      SFX.noMove();
    } else {
      msg = `Opponent rolled ${roll}.`;
    }
    this.showMessage(msg, msgType);

    this.update(state, { legalMoves: isMine && hasMoves ? legalMoves : [] });

    if (isMine && hasMoves) {
      this._setDiceFace(roll);
    } else {
      await sleep(1800);
      this._hideDiceResult();
    }
  }

  async handleMove({ userId, tokenIndex, captured, enteredHome, extraTurn, state }) {
    const isMine = userId === this.myId;

    if (captured && captured.length > 0) {
      SFX.capture();
      this.showMessage(isMine ? `Captured ${captured.length} token!` : `You lost a token!`, isMine ? "success" : "error");
      this.update(state, { legalMoves: [] });
      await sleep(400);
    } else if (enteredHome) {
      SFX.move();
      this.showMessage(isMine ? "Token reached home! 🎉" : "Opponent reached home.", isMine ? "success" : "info");
      this.update(state, { legalMoves: [] });
      await sleep(400);
    } else {
      SFX.move();
      this.update(state, { legalMoves: [] });
      await sleep(250);
    }

    if (extraTurn && state.current_user_id === this.myId) {
      await sleep(250);
      this.showMessage("Extra turn! Roll again.", "success");
    }
    if (!state.winner_user_id) {
      await sleep(600);
      this._hideDiceResult();
    }
  }

  async handleEnd({ winnerId, wager, pot }) {
    const iWon = winnerId === this.myId;
    this.state = { ...this.state, winner_user_id: winnerId };
    this._renderStatus();
    this._renderDice();

    this.winOverlay.innerHTML = `
      <div class="ludo-win-title ${iWon ? "win" : "lose"}">${iWon ? "🏆 YOU WIN" : "DEFEAT"}</div>
      <div class="ludo-win-sub">${iWon ? `+${pot} PlayCoins` : `-${wager} PlayCoins`}</div>
    `;
    this.winOverlay.classList.add("show");
    if (iWon) SFX.win(); else SFX.lose();
  }

  update(state, { legalMoves = [], forcedDiceFace = null } = {}) {
    const oldCurrent = this._lastCurrentUserId;
    this.state = state;
    this.legalMoves = legalMoves;
    this._forcedDiceFace = forcedDiceFace;
    this._renderTokens();
    this._renderDice();
    this._renderStatus();

    if (oldCurrent && oldCurrent !== state.current_user_id && !state.winner_user_id) {
      this._announceTurn(state);
    }
    this._lastCurrentUserId = state.current_user_id;

    console.log("[Ludo v3] update. myId=", this.myId, "current=", state.current_user_id,
                "legalMoves=", legalMoves, "awaiting=", state.awaiting_token_choice);
  }

  _announceTurn(state) {
    const isMine = state.current_user_id === this.myId;
    this.turnBanner.textContent = isMine ? "YOUR TURN" : "OPPONENT'S TURN";
    this.turnBanner.className = `ludo-turn-banner ${isMine ? "me" : "them"}`;
    void this.turnBanner.offsetWidth;
    this.turnBanner.classList.add("show");
    if (isMine) SFX.yourTurn();
  }

  showMessage(text, type = "info") {
    this.msgBar.textContent = text;
    this.msgBar.className = `ludo-msg-bar ludo-msg-${type}`;
  }

  _hideDiceResult() {
    this.diceResult.classList.remove("show");
    this.diceResult.textContent = "";
  }

  _setDiceFace(value) {
    if (this.diceBtn && value) this.diceBtn.textContent = DICE_FACES[value] || "🎲";
  }

  _spinDice(finalRoll) {
    return new Promise((resolve) => {
      if (!this.diceBtn) { resolve(); return; }
      this.diceBtn.classList.add("dice-spinning");
      this.diceBtn.disabled = true;
      this.diceBtn.classList.add("ludo-dice-disabled");
      let ticks = 0;
      const totalTicks = 14;
      const interval = setInterval(() => {
        const v = 1 + Math.floor(Math.random() * 6);
        this.diceBtn.textContent = DICE_FACES[v];
        SFX.rollTick();
        ticks++;
        if (ticks >= totalTicks) {
          clearInterval(interval);
          this.diceBtn.textContent = DICE_FACES[finalRoll] || "🎲";
          this.diceBtn.classList.remove("dice-spinning");
          resolve();
        }
      }, 50);
    });
  }

  _renderTokens() {
    if (!this.state) return;
    this.tokenLayer.innerHTML = "";

    const active = this.legalMoves.length > 0 && this.state.current_user_id === this.myId;
    const movableSet = new Set(active ? this.legalMoves : []);
    console.log("[Ludo v3] renderTokens — active:", active, "movableSet:", [...movableSet]);

    const placed = [];
    for (const player of this.state.players) {
      for (let i = 0; i < player.tokens.length; i++) {
        const rel = player.tokens[i];
        let pos;
        if (rel === -1) pos = BASE_SLOTS[player.color][i];
        else {
          const abs = relToAbs(player.color, rel);
          if (!abs) continue;
          pos = abs;
        }
        placed.push({ color: player.color, userId: player.user_id, tokenIndex: i, pos, rel });
      }
    }

    const groups = {};
    for (const p of placed) {
      const k = `${p.pos[0].toFixed(2)},${p.pos[1].toFixed(2)}`;
      groups[k] = groups[k] || [];
      groups[k].push(p);
    }

    for (const key of Object.keys(groups)) {
      const group = groups[key];
      const n = group.length;
      group.forEach((p, idx) => {
        const token = document.createElement("div");
        token.className = "ludo-token";
        token.dataset.userId = p.userId;
        token.dataset.tokenIndex = String(p.tokenIndex);

        const isMine = p.userId === this.myId;
        const isMovable = isMine && movableSet.has(p.tokenIndex);

        token.style.background = COLOR_STYLE[p.color].main;
        token.style.borderColor = COLOR_STYLE[p.color].dark;
        if (isMovable) token.classList.add("ludo-token-movable");
        if (isMine) token.classList.add("ludo-token-mine");
        if (p.rel === -1) token.textContent = String(p.tokenIndex + 1);

        let dx = 0, dy = 0;
        if (n > 1) {
          const offsets = [[-0.22,-0.22],[0.22,-0.22],[-0.22,0.22],[0.22,0.22]];
          const o = offsets[idx % 4];
          dx = o[0]; dy = o[1];
        }
        const leftPct = ((p.pos[1] + 0.5 + dx) / 15) * 100;
        const topPct  = ((p.pos[0] + 0.5 + dy) / 15) * 100;
        token.style.left = `${leftPct}%`;
        token.style.top = `${topPct}%`;

        // DIRECT listener (belt + suspenders)
        if (isMovable) {
          token.addEventListener("click", (e) => {
            console.log("[Ludo v3] direct token click idx=", p.tokenIndex);
            e.stopPropagation();
            this._fireMove(p.tokenIndex);
          });
        }

        this.tokenLayer.appendChild(token);
      });
    }
  }

  _renderStatus() {
    if (!this.state) return;
    const cur = this.state.players.find((p) => p.user_id === this.state.current_user_id);
    const curLabel = cur ? cur.color.toUpperCase() : "?";
    const isMyTurn = this.state.current_user_id === this.myId;
    if (this.state.winner_user_id) {
      const winner = this.state.players.find((p) => p.user_id === this.state.winner_user_id);
      const iWon = this.state.winner_user_id === this.myId;
      this.statusBar.innerHTML = iWon
        ? `<span class="text-emerald-400 font-bold">🏆 You won!</span>`
        : `<span class="text-red-400 font-bold">${winner ? winner.color.toUpperCase() : "Opponent"} wins</span>`;
    } else if (isMyTurn) {
      this.statusBar.innerHTML = `<span class="text-brand-400 font-bold">● Your turn</span> <span class="text-slate-500">(${curLabel})</span>`;
    } else {
      this.statusBar.innerHTML = `<span class="text-slate-400">Waiting for ${curLabel}…</span>`;
    }
  }

  _renderDice() {
    this.diceBar.innerHTML = "";
    if (!this.state || this.state.winner_user_id) { this.diceBtn = null; return; }
    const isMyTurn = this.state.current_user_id === this.myId;
    const canRoll = isMyTurn && !this.state.dice_rolled && !this.state.awaiting_token_choice;
    const awaitingPick = isMyTurn && this.state.awaiting_token_choice;

    const btn = document.createElement("button");
    btn.className = "ludo-dice-btn";
    btn.type = "button";

    if (awaitingPick) {
      btn.textContent = this.state.last_roll ? DICE_FACES[this.state.last_roll] : "🎲";
      btn.disabled = true;
      btn.classList.add("ludo-dice-disabled");
    } else if (canRoll) {
      btn.textContent = this._forcedDiceFace ? DICE_FACES[this._forcedDiceFace]
                       : (this.state.last_roll ? DICE_FACES[this.state.last_roll] : "🎲");
      btn.addEventListener("click", () => this.onRoll && this.onRoll());
    } else {
      btn.textContent = this.state.last_roll ? DICE_FACES[this.state.last_roll] : "🎲";
      btn.disabled = true;
      btn.classList.add("ludo-dice-disabled");
    }
    this.diceBar.appendChild(btn);
    this.diceBtn = btn;
  }
}
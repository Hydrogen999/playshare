// Ludo board renderer + animated interaction handler + 3D Neon HUD.
// Fixes vs previous version:
//  - base tokens are now centred in their yard
//  - tokens are reused (not rebuilt) and walk cell by cell along the track
//  - dice drawn with CSS pips (no font-dependent glyphs) + double-click roll guard
//  - start squares are coloured, safe squares show a star
//  - capture message is correct in 3-4 player games

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

const HOME_CELLS = { red: [7,6], green: [6,7], yellow: [7,8], blue: [8,7] };

// Values are cell coordinates BEFORE the +0.5 centring offset, so 1.5 / 3.5
// land the tokens on 2 and 4 (symmetric around the yard centre at 3).
const BASE_SLOTS = {
  red:    [[1.5,1.5],[1.5,3.5],[3.5,1.5],[3.5,3.5]],
  green:  [[1.5,10.5],[1.5,12.5],[3.5,10.5],[3.5,12.5]],
  yellow: [[10.5,10.5],[10.5,12.5],[12.5,10.5],[12.5,12.5]],
  blue:   [[10.5,1.5],[10.5,3.5],[12.5,1.5],[12.5,3.5]],
};

const SAFE_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

const COLOR_STYLE = {
  red:    { main: "#ef4444", dark: "#7f1d1d", glow: "rgba(239,68,68,0.6)" },
  green:  { main: "#22c55e", dark: "#14532d", glow: "rgba(34,197,94,0.6)" },
  yellow: { main: "#eab308", dark: "#713f12", glow: "rgba(234,179,8,0.6)" },
  blue:   { main: "#3b82f6", dark: "#1e3a8a", glow: "rgba(59,130,246,0.6)" },
};

const PIPS = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };
const STACK_OFFSETS = [[-0.22,-0.22],[0.22,-0.22],[-0.22,0.22],[0.22,0.22]];
const STEP_MS = 130;

// Returns [row, col] of a cell in board units (top-left = 0,0), or null.
function relToAbs(color, rel) {
  if (rel === -1) return null;
  if (rel === HOME_POS) return HOME_CELLS[color];
  if (rel >= 0 && rel <= 50) return OUTER_LOOP[(START_INDEX[color] + rel) % LOOP_LEN];
  if (rel >= 51 && rel <= 55) return HOME_COLUMNS[color][rel - 51];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LudoBoard {
  constructor(container) {
    this.container = container;
    this.myId = null;
    this.state = null;
    this.onRoll = null;
    this.onMove = null;
    this.legalMoves = [];
    this._lastCurrentUserId = null;
    this._busy = false;
    this._rollPending = false;
    this.tokenEls = new Map();   // "userId:index" -> element
    this.prevRel = new Map();    // "userId:index" -> last known rel position
    this._walking = new Set();   // keys currently animating along the track
    this._walks = new Set();     // promises of running walks
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

    this.tokenLayer.addEventListener("click", (e) => {
      const el = e.target.closest(".ludo-token-movable");
      if (!el) return;
      const idx = parseInt(el.dataset.tokenIndex, 10);
      if (Number.isNaN(idx) || this._busy) return;
      this._busy = true;
      setTimeout(() => { this._busy = false; }, 800);
      if (this.onMove) this.onMove(idx);
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

  _buildCells() {
    const baseDefs = [
      { color: "red", area: "1 / 1 / 7 / 7" },
      { color: "green", area: "1 / 10 / 7 / 16" },
      { color: "yellow", area: "10 / 10 / 16 / 16" },
      { color: "blue", area: "10 / 1 / 16 / 7" },
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
    const startKey = {};
    for (const [color, idx] of Object.entries(START_INDEX)) {
      const [r, c] = OUTER_LOOP[idx];
      startKey[`${r},${c}`] = color;
    }
    const homeColKey = {};
    for (const [color, cells] of Object.entries(HOME_COLUMNS)) {
      for (const [r, c] of cells) homeColKey[`${r},${c}`] = color;
    }
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const isBase = (r <= 5 && c <= 5) || (r <= 5 && c >= 9) || (r >= 9 && c >= 9) || (r >= 9 && c <= 5);
        if (isBase) continue;
        if (r >= 6 && r <= 8 && c >= 6 && c <= 8) continue;

        const key = `${r},${c}`;
        const div = document.createElement("div");
        div.className = "ludo-cell";
        div.style.gridArea = `${r + 1} / ${c + 1} / ${r + 2} / ${c + 2}`;
        if (homeColKey[key]) div.classList.add("ludo-home-col", `ludo-home-${homeColKey[key]}`);
        else if (pathKeys.has(key)) {
          div.classList.add("ludo-path");
          if (startKey[key]) { div.classList.add("ludo-safe", "ludo-start", `ludo-start-${startKey[key]}`); div.textContent = "★"; }
          else if (safeKeys.has(key)) { div.classList.add("ludo-safe"); div.textContent = "★"; }
        } else div.classList.add("ludo-void");
        this.board.appendChild(div);
      }
    }

    const center = document.createElement("div");
    center.className = "ludo-center";
    center.style.gridArea = "7 / 7 / 10 / 10";
    center.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="0,0 100,0 50,50" fill="#22c55e"/><polygon points="100,0 100,100 50,50" fill="#eab308"/><polygon points="100,100 0,100 50,50" fill="#3b82f6"/><polygon points="0,100 0,0 50,50" fill="#ef4444"/></svg>`;
    this.board.appendChild(center);
  }

  setIdentity(myId) { this.myId = myId; }
  setCallbacks({ onRoll, onMove }) { this.onRoll = onRoll; this.onMove = onMove; }

  async handleStart(state) {
    this.state = state;
    this._lastCurrentUserId = state.current_user_id;
    this.update(state, { legalMoves: [] });
    this.showMessage("Game started. Roll 6 to release a token.", "info");
    await sleep(300);
    this._announceTurn(state);
  }

  async handleRoll({ userId, roll, legalMoves, state }) {
    this._rollPending = false;
    const isMine = userId === this.myId;
    const hasMoves = legalMoves.length > 0;
    const stillMyTurn = state.current_user_id === this.myId;

    await this._spinDice(roll);

    this.diceResult.textContent = String(roll);
    this.diceResult.classList.add("show");

    let msg = "", msgType = "info";
    if (isMine && hasMoves) { msg = `You rolled ${roll}! Click a glowing token.`; msgType = "success"; }
    else if (isMine && !hasMoves) { msg = stillMyTurn ? `Rolled ${roll} — no moves. Roll again.` : `Rolled ${roll} — no moves. Turn passes.`; msgType = "warn"; }
    else { msg = `Opponent rolled ${roll}.`; }
    this.showMessage(msg, msgType);

    this.update(state, { legalMoves: isMine && hasMoves ? legalMoves : [], forcedDiceFace: roll });

    if (isMine && hasMoves) { this._setFace(this.diceBtn, roll); }
    else { await sleep(1800); this._hideDiceResult(); }
  }

  async handleMove({ userId, tokenIndex, captured, enteredHome, extraTurn, state }) {
    const isMine = userId === this.myId;
    this.update(state, { legalMoves: [] });
    await this._settle(); // let the token finish walking before showing results

    if (captured && captured.length > 0) {
      const lostMine = !isMine && (
        state.players.length === 2 ||
        captured.some((c) => c && (c.user_id ?? c.userId) === this.myId)
      );
      this.showMessage(
        isMine ? `Captured ${captured.length} token${captured.length > 1 ? "s" : ""}!`
               : lostMine ? "You lost a token!" : "A token was captured.",
        isMine ? "success" : lostMine ? "error" : "info"
      );
      await sleep(400);
    } else if (enteredHome) {
      this.showMessage(isMine ? "Token reached home! 🎉" : "Opponent reached home.", isMine ? "success" : "info");
      await sleep(400);
    } else {
      await sleep(150);
    }

    if (extraTurn && state.current_user_id === this.myId) {
      await sleep(250);
      this.showMessage("Extra turn! Roll again.", "success");
    }
    if (!state.winner_user_id) { await sleep(600); this._hideDiceResult(); }
  }

  async handleEnd({ winnerId, wager, pot }) {
    await this._settle();
    const iWon = winnerId === this.myId;
    this.state = { ...this.state, winner_user_id: winnerId };
    this._renderStatus();
    this._renderDice();

    this.winOverlay.innerHTML = `<div class="ludo-win-title ${iWon ? "win" : "lose"}">${iWon ? "🏆 VICTORY" : "DEFEAT"}</div><div class="ludo-win-sub">${iWon ? `+${pot} PlayCoins` : `-${wager} PlayCoins`}</div>`;
    this.winOverlay.classList.add("show");
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
  }

  _announceTurn(state) {
    const isMine = state.current_user_id === this.myId;
    this.turnBanner.textContent = isMine ? "YOUR TURN" : "OPPONENT'S TURN";
    this.turnBanner.className = `ludo-turn-banner ${isMine ? "me" : "them"}`;
    void this.turnBanner.offsetWidth;
    this.turnBanner.classList.add("show");
  }

  showMessage(text, type = "info") {
    this.msgBar.textContent = text;
    this.msgBar.className = `ludo-msg-bar ludo-msg-${type}`;
  }

  _hideDiceResult() { this.diceResult.classList.remove("show"); this.diceResult.textContent = ""; }

  // Dice face drawn with CSS pips so it never depends on device fonts.
  _setFace(btn, n) {
    if (!btn) return;
    if (!n) { btn.innerHTML = `<span class="ludo-dice-label">ROLL</span>`; btn.setAttribute("aria-label", "Roll the dice"); return; }
    let html = `<span class="ludo-pips">`;
    for (let i = 0; i < 9; i++) html += `<i class="${PIPS[n].includes(i) ? "on" : ""}"></i>`;
    btn.innerHTML = html + `</span>`;
    btn.setAttribute("aria-label", `Dice shows ${n}`);
  }

  _spinDice(finalRoll) {
    return new Promise((resolve) => {
      const btn = this.diceBtn;
      if (!btn) { resolve(); return; }
      btn.classList.add("dice-spinning", "ludo-dice-disabled");
      btn.disabled = true;
      let ticks = 0;
      const interval = setInterval(() => {
        this._setFace(btn, 1 + Math.floor(Math.random() * 6));
        if (++ticks >= 14) {
          clearInterval(interval);
          this._setFace(btn, finalRoll);
          btn.classList.remove("dice-spinning");
          resolve();
        }
      }, 50);
    });
  }

  // ---------- tokens ----------

  // Centre of a token's cell in board units: [y, x].
  _cellPos(color, rel, index) {
    if (rel === -1) { const s = BASE_SLOTS[color][index]; return [s[0] + 0.5, s[1] + 0.5]; }
    const a = relToAbs(color, rel);
    return a ? [a[0] + 0.5, a[1] + 0.5] : null;
  }

  _place(el, y, x) {
    el.style.left = `${(x / 15) * 100}%`;
    el.style.top = `${(y / 15) * 100}%`;
  }

  _renderTokens() {
    if (!this.state) return;
    const mine = this.state.current_user_id === this.myId;
    const movable = new Set(mine ? this.legalMoves : []);
    const seen = new Set();

    for (const player of this.state.players) {
      for (let i = 0; i < player.tokens.length; i++) {
        const key = `${player.user_id}:${i}`;
        const rel = player.tokens[i];
        seen.add(key);

        let el = this.tokenEls.get(key);
        if (!el) {
          el = document.createElement("div");
          el.className = "ludo-token";
          el.dataset.userId = player.user_id;
          el.style.background = COLOR_STYLE[player.color].main;
          el.style.borderColor = "#fff";
          el.style.boxShadow = `0 0 10px ${COLOR_STYLE[player.color].glow}, inset 0 0 5px rgba(255,255,255,0.5)`;
          this.tokenLayer.appendChild(el);
          this.tokenEls.set(key, el);
        }
        el.dataset.tokenIndex = String(i);
        el.classList.toggle("ludo-token-mine", player.user_id === this.myId);
        el.classList.toggle("ludo-token-movable", player.user_id === this.myId && movable.has(i));
        el.textContent = rel === -1 ? String(i + 1) : "";

        const prev = this.prevRel.get(key);
        this.prevRel.set(key, rel);
        // Forward move on the track: walk it cell by cell.
        if (prev !== undefined && prev >= 0 && rel > prev && rel - prev <= 6 && !this._walking.has(key)) {
          this._walk(key, player.color, prev, rel, el);
        }
      }
    }

    for (const [key, el] of this.tokenEls) {
      if (!seen.has(key)) { el.remove(); this.tokenEls.delete(key); this.prevRel.delete(key); this._walking.delete(key); }
    }
    this._layout();
  }

  // Positions every non-walking token, fanning out tokens that share a cell.
  _layout() {
    if (!this.state) return;
    const groups = new Map();
    for (const player of this.state.players) {
      player.tokens.forEach((rel, i) => {
        const key = `${player.user_id}:${i}`;
        if (this._walking.has(key)) return;
        const pos = this._cellPos(player.color, rel, i);
        if (!pos) return;
        const gk = `${pos[0].toFixed(2)},${pos[1].toFixed(2)}`;
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push({ key, pos });
      });
    }
    for (const group of groups.values()) {
      const n = group.length;
      group.forEach((g, idx) => {
        const el = this.tokenEls.get(g.key);
        if (!el) return;
        const [dy, dx] = n > 1 ? [STACK_OFFSETS[idx % 4][1], STACK_OFFSETS[idx % 4][0]] : [0, 0];
        this._place(el, g.pos[0] + dy, g.pos[1] + dx);
      });
    }
  }

  _walk(key, color, from, to, el) {
    this._walking.add(key);
    el.classList.add("ludo-token-walking");
    const p = (async () => {
      for (let r = from + 1; r <= to; r++) {
        const pos = this._cellPos(color, r, 0);
        if (pos) this._place(el, pos[0], pos[1]);
        await sleep(STEP_MS);
      }
      this._walking.delete(key);
      el.classList.remove("ludo-token-walking");
      this._layout();
    })();
    this._walks.add(p);
    p.finally(() => this._walks.delete(p));
  }

  _settle() { return Promise.all([...this._walks]); }

  // ---------- HUD ----------

  _renderStatus() {
    if (!this.state) return;
    const cur = this.state.players.find((p) => p.user_id === this.state.current_user_id);
    const curLabel = cur ? cur.color.toUpperCase() : "?";
    const isMyTurn = this.state.current_user_id === this.myId;
    if (this.state.winner_user_id) {
      const winner = this.state.players.find((p) => p.user_id === this.state.winner_user_id);
      const iWon = this.state.winner_user_id === this.myId;
      this.statusBar.innerHTML = iWon ? `<span class="text-emerald-400 font-bold">🏆 YOU WON!</span>` : `<span class="text-red-400 font-bold">${winner ? winner.color.toUpperCase() : "OPPONENT"} WINS</span>`;
    } else if (isMyTurn) {
      this.statusBar.innerHTML = `<span class="text-cyber-cyan font-bold">● YOUR TURN</span> <span class="text-slate-500">(${curLabel})</span>`;
    } else {
      this.statusBar.innerHTML = `<span class="text-slate-400">WAITING FOR ${curLabel}…</span>`;
    }
  }

  _renderDice() {
    this.diceBar.innerHTML = "";
    if (!this.state || this.state.winner_user_id) { this.diceBtn = null; return; }
    const isMyTurn = this.state.current_user_id === this.myId;
    const canRoll = isMyTurn && !this.state.dice_rolled && !this.state.awaiting_token_choice;
    const shown = this._forcedDiceFace || this.state.last_roll || 0;

    const btn = document.createElement("button");
    btn.className = "ludo-dice-btn";
    btn.type = "button";

    if (canRoll) {
      this._setFace(btn, this._forcedDiceFace || 0);
      if (this._rollPending) { btn.disabled = true; btn.classList.add("ludo-dice-disabled"); }
      btn.addEventListener("click", () => {
        if (this._rollPending || !this.onRoll) return;
        this._rollPending = true;       // block double-rolls until the server answers
        btn.disabled = true;
        btn.classList.add("ludo-dice-disabled");
        this.onRoll();
        setTimeout(() => {              // safety net if the server never answers
          if (this._rollPending) { this._rollPending = false; this._renderDice(); }
        }, 3000);
      });
    } else {
      this._setFace(btn, shown);
      btn.disabled = true;
      btn.classList.add("ludo-dice-disabled");
    }
    this.diceBar.appendChild(btn);
    this.diceBtn = btn;
  }
}

// Inject Cyberpunk CSS for Ludo (once)
if (!document.getElementById("ludo-style")) {
  const style = document.createElement("style");
  style.id = "ludo-style";
  style.textContent = `
  .ludo-root { display: flex; flex-direction: column; gap: 10px; align-items: center; width: 100%; }
  .ludo-status-bar { width: min(94vw, 540px); text-align: center; font-size: 12px; font-family: 'Orbitron', sans-serif; font-weight: 700; letter-spacing: 1px; padding: 10px 12px; background: rgba(5,5,15,0.8); border: 1px solid rgba(6,182,212,0.5); border-radius: 8px; color: #06b6d4; box-shadow: 0 0 15px rgba(6,182,212,0.2); text-transform: uppercase; }
  .ludo-board-wrap { position: relative; }
  .ludo-board { position: relative; display: grid; grid-template-columns: repeat(15, 1fr); grid-template-rows: repeat(15, 1fr); aspect-ratio: 1 / 1; width: min(94vw, 540px); background: #0a0e1a; border: 2px solid rgba(6,182,212,0.6); border-radius: 4px; overflow: hidden; box-shadow: 0 0 40px rgba(6,182,212,0.3), inset 0 0 20px rgba(0,0,0,0.8); }
  .ludo-cell { position: relative; background: #1e293b; border: 0.5px solid #0f172a; }
  .ludo-path { background: #cbd5e1; }
  .ludo-path.ludo-safe { display: grid; place-items: center; color: #d97706; font-size: min(3.4vw, 17px); line-height: 1; }
  .ludo-start { color: #fff !important; }
  .ludo-start-red { background: #ef4444 !important; } .ludo-start-green { background: #22c55e !important; } .ludo-start-yellow { background: #eab308 !important; } .ludo-start-blue { background: #3b82f6 !important; }
  .ludo-void { background: transparent; border: none; }
  .ludo-home-col { border: 0.5px solid rgba(0,0,0,0.3); }
  .ludo-home-red { background: #ef4444; } .ludo-home-green { background: #22c55e; } .ludo-home-yellow { background: #eab308; } .ludo-home-blue { background: #3b82f6; }
  .ludo-base { border: 2px solid rgba(0,0,0,0.4); padding: 22%; display: grid; place-items: center; box-shadow: inset 0 0 30px rgba(0,0,0,0.5); }
  .ludo-base-red { background: #ef4444; } .ludo-base-green { background: #22c55e; } .ludo-base-yellow { background: #eab308; } .ludo-base-blue { background: #3b82f6; }
  .ludo-base-inner { width: 100%; height: 100%; background: rgba(0,0,0,0.8); border-radius: 4px; box-shadow: inset 0 0 15px rgba(255,255,255,0.1); }
  .ludo-center { position: relative; }
  .ludo-center svg { width: 100%; height: 100%; display: block; }
  .ludo-token-layer { position: absolute; inset: 0; pointer-events: none; }
  .ludo-token { position: absolute; width: 5.2%; aspect-ratio: 1 / 1; border-radius: 50%; transform: translate(-50%, -50%); border: 1.5px solid #fff; color: white; font-size: 9px; font-weight: 800; display: grid; place-items: center; pointer-events: none; transition: left 0.13s linear, top 0.13s linear; z-index: 3; }
  .ludo-token.ludo-token-walking { z-index: 12; }
  .ludo-token.ludo-token-mine { z-index: 4; }
  .ludo-token.ludo-token-movable { pointer-events: auto !important; cursor: pointer !important; z-index: 10; animation: tokenPulse 1.1s ease-in-out infinite; }
  @keyframes tokenPulse { 0%, 100% { box-shadow: 0 0 0 3px #fbbf24, 0 0 15px #fbbf24; transform: translate(-50%, -50%) scale(1); } 50% { box-shadow: 0 0 0 8px rgba(251,191,36,0.3), 0 0 30px #fbbf24; transform: translate(-50%, -50%) scale(1.15); } }
  .ludo-dice-bar { width: min(94vw, 540px); display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 10px; }
  .ludo-dice-btn { display: grid; place-items: center; padding: 0; background: #0f172a; color: #06b6d4; font-family: 'Orbitron', sans-serif; font-size: 14px; font-weight: 800; letter-spacing: 1px; width: 84px; height: 84px; border-radius: 8px; border: 2px solid #06b6d4; box-shadow: 0 0 20px rgba(6,182,212,0.4), inset 0 0 10px rgba(6,182,212,0.2); cursor: pointer; transition: transform 0.15s; }
  .ludo-dice-btn:hover:not(:disabled) { transform: scale(1.05); box-shadow: 0 0 30px rgba(6,182,212,0.8); }
  .ludo-dice-btn.ludo-dice-disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; border-color: #334155; color: #64748b; }
  .ludo-pips { display: grid; grid-template: repeat(3, 1fr) / repeat(3, 1fr); width: 66%; height: 66%; }
  .ludo-pips i { margin: 14%; border-radius: 50%; }
  .ludo-pips i.on { background: currentColor; box-shadow: 0 0 6px currentColor; }
  .ludo-dice-btn.dice-spinning { animation: diceSpin 0.7s ease-out; }
  @keyframes diceSpin { 0% { transform: rotate(0deg) scale(1); } 25% { transform: rotate(-120deg) scale(1.15); } 50% { transform: rotate(180deg) scale(0.9); } 75% { transform: rotate(360deg) scale(1.12); } 100% { transform: rotate(540deg) scale(1); } }
  .ludo-dice-result { font-size: 32px; font-family: 'Orbitron', sans-serif; font-weight: 900; color: #ec4899; min-width: 50px; text-align: center; opacity: 0; text-shadow: 0 0 15px rgba(236,72,153,0.8); }
  .ludo-dice-result.show { opacity: 1; animation: pop 0.45s ease-out; }
  @keyframes pop { 0% { transform: scale(0.6); opacity: 0; } 70% { transform: scale(1.12); } 100% { transform: scale(1); opacity: 1; } }
  .ludo-msg-bar { width: min(94vw, 540px); text-align: center; font-size: 12px; font-family: 'Orbitron', sans-serif; font-weight: 600; min-height: 20px; margin-top: 5px; }
  .ludo-msg-info { color: #94a3b8; } .ludo-msg-success { color: #22c55e; text-shadow: 0 0 10px rgba(34,197,94,0.5); } .ludo-msg-error { color: #ef4444; text-shadow: 0 0 10px rgba(239,68,68,0.5); } .ludo-msg-warn { color: #fbbf24; text-shadow: 0 0 10px rgba(251,191,36,0.5); }
  .ludo-turn-banner { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 12px 24px; border-radius: 8px; font-weight: 900; font-family: 'Orbitron', sans-serif; font-size: 20px; letter-spacing: 2px; text-transform: uppercase; pointer-events: none; z-index: 20; opacity: 0; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
  .ludo-turn-banner.show { animation: bannerFlash 1.6s ease-out; }
  @keyframes bannerFlash { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); } 15% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); } 30% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 85% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1.1); } }
  .ludo-turn-banner.me { background: rgba(6,182,212,0.9); color: #000; box-shadow: 0 0 30px #06b6d4; border: 2px solid #fff; }
  .ludo-turn-banner.them { background: rgba(236,72,153,0.9); color: #fff; box-shadow: 0 0 30px #ec4899; border: 2px solid #fff; }
  .ludo-win-overlay { position: absolute; inset: 0; background: rgba(2,0,10,0.9); backdrop-filter: blur(5px); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 30; border-radius: 4px; gap: 8px; opacity: 0; pointer-events: none; transition: opacity 0.3s; }
  .ludo-win-overlay.show { opacity: 1; pointer-events: auto; }
  .ludo-win-title { font-size: 38px; font-family: 'Orbitron', sans-serif; font-weight: 900; letter-spacing: 3px; animation: pop 0.6s ease-out; text-transform: uppercase; }
  .ludo-win-title.win { color: #06b6d4; text-shadow: 0 0 30px rgba(6,182,212,0.8); }
  .ludo-win-title.lose { color: #ec4899; text-shadow: 0 0 30px rgba(236,72,153,0.8); }
  .ludo-win-sub { font-size: 16px; color: #cbd5e1; font-family: 'Orbitron', sans-serif; font-weight: 600; }
  @media (prefers-reduced-motion: reduce) { .ludo-token, .ludo-token.ludo-token-movable { transition: none; animation: none; } }
  @media (max-width: 767px) {
    .ludo-dice-btn { width: 72px; height: 72px; }
    .ludo-dice-result { font-size: 26px; }
    .ludo-status-bar { font-size: 12px; padding: 5px 8px; }
    .ludo-win-title { font-size: 30px; }
    .ludo-win-sub { font-size: 14px; }
    .ludo-msg-bar { font-size: 12px; }
  }
`;
  document.head.appendChild(style);
}

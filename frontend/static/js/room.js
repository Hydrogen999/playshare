import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";
import { LudoBoard } from "./ludo-board.js";
import { ChessBoard } from "./chess-board.js";
import { sfx, unlockAudio } from "./sounds.js";

const params = new URLSearchParams(location.search);
const roomId = params.get("id");

const $ = (id) => document.getElementById(id);
const selectorPanel = $("selectorPanel");
const gameStatus = $("gameStatus");
const diceArea = $("diceArea");
const ludoArea = $("ludoArea");
const ludoContainer = $("ludoContainer");
const chessArea = $("chessArea");
const chessContainer = $("chessContainer");
const cardA = $("cardA");
const cardB = $("cardB");
const diceA = $("diceA");
const diceB = $("diceB");
const totalA = $("totalA");
const totalB = $("totalB");
const statusBadge = $("statusBadge");
const winnerBanner = $("winnerBanner");
const wagerSlider = $("wagerSlider");
const wagerValue = $("wagerValue");
const readyBtn = $("readyBtn");
const statusLine = $("statusLine");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const chatStatus = $("chatStatus");

let ws = null;
let me = null;
let myId = null;
let members = [];
let iAmReady = false;
let currentMatch = null;
let currentGame = "dice";
let wagerLocked = false;
let ludoBoard = null;
let chessBoard = null;

const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

// ---------- Mobile chat drawer ----------
const chatToggleBtn = $("chatToggleBtn");
const chatPanelClose = $("chatPanelClose");
const chatPanel = $("chatPanel");

function openChatDrawer() {
  if (!chatPanel) return;
  chatPanel.classList.remove("hidden");
  chatPanel.classList.add("flex");
  document.body.classList.add("chat-open");
  setTimeout(() => { if (chatInput) chatInput.focus(); }, 250);
}

function closeChatDrawer() {
  document.body.classList.remove("chat-open");
}

if (chatToggleBtn) {
  chatToggleBtn.addEventListener("click", () => {
    if (document.body.classList.contains("chat-open")) {
      closeChatDrawer();
    } else {
      openChatDrawer();
    }
  });
}
if (chatPanelClose) {
  chatPanelClose.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeChatDrawer();
  });
}

// ---------- Room code banner ----------
function renderRoomCodeBanner(room) {
  if (!room || !room.code) return;
  if (document.getElementById("roomCodeBanner")) return;

  const banner = document.createElement("div");
  banner.className = "mb-3 rounded-2xl border border-brand-500/40 bg-gradient-to-br from-brand-600/15 to-slate-900/60 p-3 sm:p-4 flex items-center justify-between gap-3";
  banner.id = "roomCodeBanner";
  banner.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="text-[10px] uppercase tracking-widest text-brand-400 font-bold">Room Code</div>
      <div class="text-lg sm:text-2xl font-black tracking-widest font-mono">${room.code}</div>
    </div>
    <button id="copyRoomCodeBtn" class="rounded-lg bg-brand-600 hover:bg-brand-700 px-3 py-2 text-xs font-bold whitespace-nowrap">
      📋 Copy Link
    </button>
  `;
  const main = document.querySelector("main");
  if (main) main.insertBefore(banner, main.firstChild);

  document.getElementById("copyRoomCodeBtn")?.addEventListener("click", async () => {
    const link = `${location.origin}/join?code=${room.code}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    const btn = document.getElementById("copyRoomCodeBtn");
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "✓ Copied!";
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  });
}

// ---------- Game selector ----------
function updateGameCard(slug) {
  currentGame = slug;
  document.querySelectorAll(".game-card").forEach((btn) => {
    if (btn.dataset.game === slug) {
      btn.classList.add("border-brand-500", "bg-brand-500/10");
      btn.classList.remove("border-slate-800");
    } else {
      btn.classList.remove("border-brand-500", "bg-brand-500/10");
      btn.classList.add("border-slate-800");
    }
  });
  const labels = { dice: "Roll-off", ludo: "Ludo", chess: "Chess" };
  gameStatus.textContent = slug ? `Selected: ${labels[slug] || slug}` : "Not selected";
  showGameArea(slug);
}

function showGameArea(slug) {
  if (diceArea) diceArea.classList.add("hidden");
  if (ludoArea) ludoArea.classList.add("hidden");
  if (chessArea) chessArea.classList.add("hidden");
  if (slug === "ludo" && ludoArea) ludoArea.classList.remove("hidden");
  else if (slug === "chess" && chessArea) chessArea.classList.remove("hidden");
  else if (diceArea) diceArea.classList.remove("hidden");
}

document.querySelectorAll(".game-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "room:set_game", game_slug: btn.dataset.game }));
  });
});

// ---------- Members ----------
function renderMembers() {
  const row = document.getElementById("playersRow");
  if (row) {
    row.innerHTML = "";
    for (const m of members) {
      const isMe = m.user_id === myId;
      const div = document.createElement("div");
      div.className = "flex flex-col items-center";
      div.innerHTML = `
        <div>${avatarHTML(m.avatar_id, "lg", m.frame_color, m.is_premium)}</div>
        <div class="mt-2 font-bold text-center text-xs sm:text-sm ${isMe ? "text-brand-500" : "text-slate-100"}">
          ${m.username}${m.is_premium ? ' <span class="text-amber-400">👑</span>' : ''}${isMe ? " (you)" : ""}
        </div>
        <div class="text-[10px] sm:text-xs ${m.ready ? "text-emerald-400" : "text-slate-500"} mt-0.5">
          ${m.ready ? "✓ Ready" : "Waiting…"}
        </div>
      `;
      row.appendChild(div);
    }
    return;
  }

  // Fallback for old layout
  const render = (m, slot) => {
    if (!slot) return;
    if (!m) { slot.innerHTML = ""; return; }
    const isMe = m.user_id === myId;
    slot.innerHTML = `
      <div class="flex flex-col items-center">
        <div>${avatarHTML(m.avatar_id, "lg", m.frame_color, m.is_premium)}</div>
        <div class="mt-2 font-bold ${isMe ? "text-brand-500" : "text-slate-100"}">${m.username}${m.is_premium ? ' <span class="text-amber-400">👑</span>' : ''}${isMe ? " (you)" : ""}</div>
        <div class="text-xs ${m.ready ? "text-emerald-400" : "text-slate-500"} mt-1">
          ${m.ready ? "✓ Ready" : "Waiting…"}
        </div>
      </div>`;
  };
  render(members[0], cardA);
  render(members[1], cardB);
}

function clearDice() {
  if (diceA) diceA.innerHTML = "";
  if (diceB) diceB.innerHTML = "";
  if (totalA) { totalA.textContent = "—"; totalA.className = "text-xl sm:text-2xl font-bold text-slate-400"; }
  if (totalB) { totalB.textContent = "—"; totalB.className = "text-xl sm:text-2xl font-bold text-slate-400"; }
  if (winnerBanner) {
    winnerBanner.classList.add("hidden");
    winnerBanner.textContent = "";
  }
}

function setStatus(text, color = "slate") {
  if (!statusBadge) return;
  const colors = {
    slate: "bg-slate-800 border-slate-700 text-slate-400",
    green: "bg-emerald-500/10 border-emerald-500/40 text-emerald-400",
    red: "bg-red-500/10 border-red-500/40 text-red-400",
    purple: "bg-brand-500/10 border-brand-500/40 text-brand-500",
  };
  statusBadge.className = `text-[10px] sm:text-xs px-2 sm:px-3 py-1 rounded-full border text-center ${colors[color]}`;
  statusBadge.textContent = text;
}

function addMessage(msg) {
  const mine = msg.sender_id === myId;
  const sender = members.find((m) => m.user_id === msg.sender_id);
  const name = mine ? "You" : (sender ? sender.username : "Player");
  const wrap = document.createElement("div");
  wrap.className = mine ? "flex flex-col items-end" : "flex flex-col items-start";
  wrap.innerHTML = `
    <div class="text-[10px] text-slate-500 mb-0.5">${name}</div>
    <div class="max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
      mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"
    }">${escapeHTML(msg.content)}</div>`;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Wager ----------
if (wagerSlider) {
  wagerSlider.addEventListener("input", () => {
    if (wagerValue) wagerValue.textContent = wagerSlider.value;
  });
  wagerSlider.addEventListener("change", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (wagerLocked) return;
    ws.send(JSON.stringify({ type: "room:set_wager", wager: Number(wagerSlider.value) }));
  });
}

// ---------- Ready ----------
if (readyBtn) {
  readyBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    iAmReady = !iAmReady;
    ws.send(JSON.stringify({ type: "room:ready", ready: iAmReady }));
    readyBtn.textContent = iAmReady ? "Cancel Ready" : "I'm Ready";
    readyBtn.className = iAmReady
      ? "rounded-lg border border-slate-700 hover:bg-slate-800 px-6 py-3 text-sm font-bold transition whitespace-nowrap"
      : "rounded-lg bg-brand-600 hover:bg-brand-700 px-6 py-3 text-sm font-bold transition whitespace-nowrap";
  });
}

// ---------- Chat form ----------
if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "chat:send", content: text }));
    chatInput.value = "";
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Dice animation ----------
async function animateRoll(result) {
  wagerLocked = true;
  if (wagerSlider) wagerSlider.disabled = true;
  if (readyBtn) {
    readyBtn.disabled = true;
    readyBtn.classList.add("opacity-50", "cursor-not-allowed");
  }
  clearDice();
  setStatus("Rolling…", "purple");
  try { sfx.diceRoll(); } catch {}

  for (let i = 0; i < 12; i++) {
    if (diceA) diceA.innerHTML = `<div class="die rolling">${DICE_FACES[1 + Math.floor(Math.random() * 6)]}</div>`;
    try { sfx.diceTick(); } catch {}
    await sleep(50);
  }
  if (diceA) diceA.innerHTML = `
    <div class="die">${DICE_FACES[result.roll_a.dice[0]]}</div>
    <div class="die">${DICE_FACES[result.roll_a.dice[1]]}</div>`;
  if (totalA) totalA.textContent = result.roll_a.total;
  try { sfx.diceLand(); } catch {}

  await sleep(200);
  try { sfx.diceRoll(); } catch {}

  for (let i = 0; i < 12; i++) {
    if (diceB) diceB.innerHTML = `<div class="die rolling">${DICE_FACES[1 + Math.floor(Math.random() * 6)]}</div>`;
    try { sfx.diceTick(); } catch {}
    await sleep(50);
  }
  if (diceB) diceB.innerHTML = `
    <div class="die">${DICE_FACES[result.roll_b.dice[0]]}</div>
    <div class="die">${DICE_FACES[result.roll_b.dice[1]]}</div>`;
  if (totalB) totalB.textContent = result.roll_b.total;
  try { sfx.diceLand(); } catch {}

  await sleep(300);

  if (result.winner_id === null) {
    setStatus("Draw — refunded");
    if (winnerBanner) {
      winnerBanner.textContent = "🤝 DRAW";
      winnerBanner.className = "mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-extrabold pop text-slate-300";
    }
    try { sfx.draw(); } catch {}
  } else if (result.winner_id === myId) {
    setStatus("You won!", "green");
    if (winnerBanner) {
      winnerBanner.textContent = `🏆 YOU WON ${result.pot} PC!`;
      winnerBanner.className = "mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-extrabold pop text-emerald-400";
    }
    try { sfx.win(); } catch {}
  } else {
    setStatus("You lost", "red");
    if (winnerBanner) {
      winnerBanner.textContent = `You lost ${result.wager} PC`;
      winnerBanner.className = "mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-extrabold pop text-red-400";
    }
    try { sfx.lose(); } catch {}
  }
  if (winnerBanner) winnerBanner.classList.remove("hidden");

  if (readyBtn) {
    readyBtn.textContent = "Play Again";
    readyBtn.disabled = false;
    readyBtn.classList.remove("opacity-50", "cursor-not-allowed");
  }
  iAmReady = false;
  wagerLocked = false;
  if (wagerSlider) wagerSlider.disabled = false;
}

// ---------- Boards ----------
function ensureLudoBoard() {
  if (ludoBoard) return ludoBoard;
  ludoBoard = new LudoBoard(ludoContainer);
  ludoBoard.setIdentity(myId);
  ludoBoard.setCallbacks({
    onRoll: () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ludo:roll" }));
    },
    onMove: (tokenIndex) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ludo:move", token_index: tokenIndex }));
    },
  });
  return ludoBoard;
}

function ensureChessBoard() {
  if (chessBoard) return chessBoard;
  chessBoard = new ChessBoard(chessContainer);
  chessBoard.setCallbacks({
    onMove: (uci) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "chess:move", uci }));
    },
    onResign: () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "chess:resign" }));
    },
  });
  return chessBoard;
}

// ---------- WebSocket ----------
async function boot() {
  if (!roomId) { window.location.href = "/lobby"; return; }
  const token = api.getToken();
  if (!token) { window.location.href = "/"; return; }

  try {
    me = await api.me();
    myId = me.id;
  } catch {
    api.clearToken();
    window.location.href = "/";
    return;
  }

  const unlockOnce = () => { try { unlockAudio(); } catch {} };
  window.addEventListener("click", unlockOnce, { once: true });
  window.addEventListener("touchstart", unlockOnce, { once: true });
  window.addEventListener("keydown", unlockOnce, { once: true });

  document.body.classList.remove("chat-open");

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/room/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => { if (chatStatus) chatStatus.textContent = "● connected"; });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case "room:init": {
        members = msg.members;
        renderMembers();
        for (const m of msg.messages) addMessage(m);
        if (msg.match) {
          currentMatch = msg.match;
          if (wagerSlider) wagerSlider.value = msg.match.wager;
          if (wagerValue) wagerValue.textContent = msg.match.wager;
        }
        updateGameCard(msg.room.game_slug || "dice");
        if (msg.room) renderRoomCodeBanner(msg.room);

        if (msg.match && msg.match.game_slug === "ludo" && msg.ludo_state) {
          if (selectorPanel) selectorPanel.classList.add("hidden");
          const board = ensureLudoBoard();
          board.update(msg.ludo_state);
        }
        if (msg.match && msg.match.game_slug === "chess" && msg.chess_state) {
          if (selectorPanel) selectorPanel.classList.add("hidden");
          const board = ensureChessBoard();
          board.setIdentity(myId, msg.chess_state.white_id, msg.chess_state.black_id);
          if (msg.chess_state.board) board.update(msg.chess_state.board);
          const hist = msg.chess_state.moves || [];
          if (hist.length > 0) board.setLastMove(hist[hist.length - 1]);
        }
        setStatus("Waiting for both ready");
        break;
      }

      case "chat:message": addMessage(msg); break;

      case "room:ready_update": {
        for (const ru of msg.members) {
          const m = members.find((x) => x.user_id === ru.user_id);
          if (m) m.ready = ru.ready;
        }
        renderMembers();
        break;
      }

      case "room:all_ready": setStatus("Starting…", "purple"); break;

      case "room:wager_update":
        currentMatch = msg.match;
        if (wagerSlider) wagerSlider.value = msg.match.wager;
        if (wagerValue) wagerValue.textContent = msg.match.wager;
        break;

      case "room:game_update": updateGameCard(msg.game_slug); break;

      case "match:result": animateRoll(msg.result); break;

      case "match:error":
        setStatus("Error: " + msg.error, "red");
        if (readyBtn) {
          readyBtn.disabled = false;
          readyBtn.classList.remove("opacity-50", "cursor-not-allowed");
        }
        break;

      case "ludo:start": {
        if (selectorPanel) selectorPanel.classList.add("hidden");
        currentMatch = { id: msg.match_id, game_slug: "ludo", wager: msg.wager };
        if (wagerSlider) { wagerSlider.value = msg.wager; wagerSlider.disabled = true; }
        if (wagerValue) wagerValue.textContent = msg.wager;
        const board = ensureLudoBoard();
        board.handleStart(msg.state);
        break;
      }

      case "ludo:rolled": {
        const board = ensureLudoBoard();
        board.handleRoll({ userId: msg.user_id, roll: msg.roll, legalMoves: msg.legal_moves || [], state: msg.state });
        break;
      }

      case "ludo:moved": {
        const board = ensureLudoBoard();
        board.handleMove({ userId: msg.user_id, tokenIndex: msg.token_index, captured: msg.captured || [], enteredHome: msg.entered_home, extraTurn: msg.extra_turn, state: msg.state });
        break;
      }

      case "ludo:end": {
        const board = ensureLudoBoard();
        board.handleEnd({ winnerId: msg.winner_user_id, wager: msg.wager, pot: msg.pot });
        try { if (msg.winner_user_id === myId) sfx.win(); else sfx.lose(); } catch {}
        iAmReady = false;
        if (readyBtn) {
          readyBtn.textContent = "I'm Ready";
          readyBtn.disabled = false;
          readyBtn.classList.remove("opacity-50", "cursor-not-allowed");
        }
        if (wagerSlider) wagerSlider.disabled = false;
        setTimeout(() => {
          if (selectorPanel) selectorPanel.classList.remove("hidden");
          if (ludoContainer) ludoContainer.innerHTML = "";
          ludoBoard = null;
        }, 5000);
        break;
      }

      case "ludo:error": {
        const board = ensureLudoBoard();
        board.showMessage(msg.error, "error");
        break;
      }

      case "chess:start": {
        if (selectorPanel) selectorPanel.classList.add("hidden");
        currentMatch = { id: msg.match_id, game_slug: "chess", wager: msg.wager };
        if (wagerSlider) { wagerSlider.value = msg.wager; wagerSlider.disabled = true; }
        if (wagerValue) wagerValue.textContent = msg.wager;
        const board = ensureChessBoard();
        board.setIdentity(myId, msg.white_id, msg.black_id);
        board.update(msg.board);
        board.showMessage("Game started. White moves first.", "info");
        break;
      }

      case "chess:moved": {
        const board = ensureChessBoard();
        board.setLastMove(msg.uci);
        if (msg.user_id !== myId) { try { board.playOpponentMoveSound(false); } catch {} }
        board.update(msg.board);
        if (msg.board && msg.board.in_check) { try { board.playCheckSound(); } catch {} }
        break;
      }

      case "chess:end": {
        const board = ensureChessBoard();
        if (board.state) { board.state.result = msg.result; board.update(board.state); }
        board.showMessage(msg.result === "draw" ? "🤝 Draw" : (msg.winner_id === myId ? "🏆 You won!" : "You lost"), msg.winner_id === myId ? "success" : "error");
        try {
          if (msg.result === "draw") sfx.draw();
          else if (msg.winner_id === myId) sfx.win();
          else sfx.lose();
        } catch {}
        iAmReady = false;
        if (readyBtn) {
          readyBtn.textContent = "I'm Ready";
          readyBtn.disabled = false;
          readyBtn.classList.remove("opacity-50", "cursor-not-allowed");
        }
        if (wagerSlider) wagerSlider.disabled = false;
        setTimeout(() => {
          if (selectorPanel) selectorPanel.classList.remove("hidden");
          if (chessContainer) chessContainer.innerHTML = "";
          chessBoard = null;
        }, 5000);
        break;
      }

      case "chess:error": {
        const board = ensureChessBoard();
        board.showMessage(msg.error, "error");
        break;
      }
    }
  });

  ws.addEventListener("close", () => { if (chatStatus) chatStatus.textContent = "● disconnected"; });
}

document.body.classList.remove("chat-open");

boot();
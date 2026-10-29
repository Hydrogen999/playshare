import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";
import { LudoBoard } from "./ludo-board.js";
import { ChessBoard } from "./chess-board.js";
import { WhotBoard } from "./whot-board.js";
import { sfx, unlockAudio } from "./sounds.js";

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
let roomId = params.get("id"); // 🟢 Changed to 'let' so we can swap the code for the UUID
const isSpectator = params.get("spectate") === "true"; // <-- Spectator Flag

const selectorPanel = $("selectorPanel");
const gameStatus = $("gameStatus");
const diceArea = $("diceArea");
const ludoArea = $("ludoArea");
const ludoContainer = $("ludoContainer");
const chessArea = $("chessArea");
const chessContainer = $("chessContainer");
const whotArea = $("whotArea");
const whotContainer = $("whotContainer");
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
let whotBoard = null;
let pingInterval = null; // 🟢 ADDED FOR HEARTBEAT

const RECONNECT_KEY = `ps_rc_${roomId}`;
let reconnectToken = localStorage.getItem(RECONNECT_KEY) || null;
let reconnectAttempts = 0;
let reconnectBanner = null;

const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

// Mobile Chat Drawer
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
function closeChatDrawer() { document.body.classList.remove("chat-open"); }

if (chatToggleBtn) {
  chatToggleBtn.addEventListener("click", () => {
    if (document.body.classList.contains("chat-open")) closeChatDrawer();
    else openChatDrawer();
  });
}
if (chatPanelClose) {
  chatPanelClose.addEventListener("click", (e) => { e.preventDefault(); closeChatDrawer(); });
}

function renderRoomCodeBanner(room) {
  if (!room || !room.code || document.getElementById("roomCodeBanner")) return;
  const banner = document.createElement("div");
  banner.className = "mb-3 rounded-2xl border border-brand-500/40 bg-gradient-to-br from-brand-600/15 to-slate-900/60 p-3 sm:p-4 flex items-center justify-between gap-3";
  banner.id = "roomCodeBanner";
  banner.innerHTML = `<div class="flex-1 min-w-0"><div class="text-[10px] uppercase tracking-widest text-brand-400 font-bold">Room Code</div><div class="text-lg sm:text-2xl font-black tracking-widest font-mono">${room.code}</div></div><div class="flex gap-2"><button id="copyRoomCodeBtn" class="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 text-xs font-bold whitespace-nowrap">📋 Copy</button><button id="shareRoomBtn" class="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-2 text-xs font-bold whitespace-nowrap">📢 Share</button></div>`;
  const main = document.querySelector("main");
  if (main) main.insertBefore(banner, main.firstChild);

  document.getElementById("shareRoomBtn")?.addEventListener("click", async () => {
    const link = `${location.origin}/join?code=${room.code}`;
    const text = `Join my PlaySphere room! 🎮 Code: ${room.code}\n${link}`;
    if (navigator.share) {
      try { await navigator.share({ title: "PlaySphere Room", text, url: link }); }
      catch {}
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    }
  });

  document.getElementById("copyRoomCodeBtn")?.addEventListener("click", async () => {
    const link = `${location.origin}/join?code=${room.code}`;
    try { await navigator.clipboard.writeText(link); } catch {
      const ta = document.createElement("textarea"); ta.value = link; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    }
    const btn = document.getElementById("copyRoomCodeBtn");
    if (btn) { const old = btn.textContent; btn.textContent = "✓ Copied!"; setTimeout(() => { btn.textContent = old; }, 1500); }
  });
}

function updateGameCard(slug) {
  currentGame = slug;
  document.querySelectorAll(".game-card").forEach((btn) => {
    if (btn.dataset.game === slug) { btn.classList.add("border-brand-500", "bg-brand-500/10"); btn.classList.remove("border-slate-800"); }
    else { btn.classList.remove("border-brand-500", "bg-brand-500/10"); btn.classList.add("border-slate-800"); }
  });
  const labels = { dice: "Roll-off", ludo: "Ludo", chess: "Chess", whot: "Whot" };
  gameStatus.textContent = slug ? `Selected: ${labels[slug] || slug}` : "Not selected";
  showGameArea(slug);
}

function showReconnectBanner(text, color = "amber") {
  if (!reconnectBanner) {
    reconnectBanner = document.createElement("div");
    reconnectBanner.id = "reconnectBanner";
    reconnectBanner.className = "fixed top-14 left-1/2 -translate-x-1/2 z-50 rounded-lg px-4 py-2 text-xs font-bold shadow-lg transition";
    document.body.appendChild(reconnectBanner);
  }
  const colors = { amber: "bg-amber-500/90 text-slate-900", red: "bg-red-500/90 text-white", green: "bg-emerald-500/90 text-slate-900" };
  reconnectBanner.className = `fixed top-14 left-1/2 -translate-x-1/2 z-50 rounded-lg px-4 py-2 text-xs font-bold shadow-lg transition ${colors[color]}`;
  reconnectBanner.textContent = text;
  reconnectBanner.style.display = "block";
}

function hideReconnectBanner() {
  if (reconnectBanner) reconnectBanner.style.display = "none";
}

function showGameArea(slug) {
  diceArea?.classList.add("hidden"); 
  ludoArea?.classList.add("hidden"); 
  chessArea?.classList.add("hidden"); 
  whotArea?.classList.add("hidden");
  
  if (slug === "ludo") ludoArea?.classList.remove("hidden");
  else if (slug === "chess") chessArea?.classList.remove("hidden");
  else if (slug === "whot") whotArea?.classList.remove("hidden");
  else diceArea?.classList.remove("hidden");
}

document.querySelectorAll(".game-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (isSpectator) return; // Spectators can't select games
    unlockAudio(); try { sfx.click(); } catch {}
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "room:set_game", game_slug: btn.dataset.game }));
  });
});

function renderMembers() {
  const row = document.getElementById("playersRow");
  if (!row) return;
  row.innerHTML = "";
  for (const m of members) {
    const isMe = m.user_id === myId;
    const div = document.createElement("div");
    div.className = "flex flex-col items-center";
    div.innerHTML = `<div>${avatarHTML(m.avatar_id, "lg", m.frame_color, m.is_premium)}</div><div class="mt-2 font-bold text-center text-xs sm:text-sm ${isMe ? "text-brand-500" : "text-slate-100"}">${m.username}${m.is_premium ? ' <span class="text-amber-400">👑</span>' : ''}${isMe ? " (you)" : ""}</div><div class="text-[10px] sm:text-xs ${m.ready ? "text-emerald-400" : "text-slate-500"} mt-0.5">${m.ready ? "✓ Ready" : "Waiting…"}</div>`;
    row.appendChild(div);
  }
}

function clearDice() {
  if (diceA) diceA.innerHTML = ""; if (diceB) diceB.innerHTML = "";
  if (totalA) { totalA.textContent = "—"; totalA.className = "text-xl sm:text-2xl font-bold text-slate-400"; }
  if (totalB) { totalB.textContent = "—"; totalB.className = "text-xl sm:text-2xl font-bold text-slate-400"; }
  if (winnerBanner) { winnerBanner.classList.add("hidden"); winnerBanner.textContent = ""; }
}

function setStatus(text, color = "slate") {
  if (!statusBadge) return;
  const colors = { slate: "bg-slate-800 border-slate-700 text-slate-400", green: "bg-emerald-500/10 border-emerald-500/40 text-emerald-400", red: "bg-red-500/10 border-red-500/40 text-red-400", purple: "bg-brand-500/10 border-brand-500/40 text-brand-500" };
  statusBadge.className = `text-[10px] sm:text-xs px-2 sm:px-3 py-1 rounded-full border text-center ${colors[color]}`;
  statusBadge.textContent = text;
}

function addMessage(msg) {
  const mine = msg.sender_id === myId;
  const sender = members.find((m) => m.user_id === msg.sender_id);
  const name = mine ? "You" : (sender ? sender.username : "Player");
  const wrap = document.createElement("div");
  wrap.className = mine ? "flex flex-col items-end" : "flex flex-col items-start";
  wrap.innerHTML = `<div class="text-[10px] text-slate-500 mb-0.5">${name}</div><div class="max-w-[75%] rounded-2xl px-3 py-2 text-sm ${mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"}">${escapeHTML(msg.content)}</div>`;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setupShareResult(winnerName, gameName) {
  const shareDiv = document.getElementById("shareResultDiv");
  const shareBtn = document.getElementById("shareResultBtn");
  if (!shareDiv || !shareBtn) return;

  shareDiv.classList.remove("hidden");
  shareBtn.onclick = async () => {
    const text = `I just beat ${winnerName} in ${gameName} on PlaySphere! 🏆\n\nThink you can beat me?`;
    const url = `${location.origin}/login`;
    if (navigator.share) {
      try { await navigator.share({ title: "PlaySphere Result", text, url }); } catch (err) {}
    } else {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      alert("Result copied! Go paste it in your group chat.");
    }
  };
}

wagerSlider.addEventListener("input", () => { wagerValue.textContent = wagerSlider.value; });
wagerSlider.addEventListener("change", () => {
  if (isSpectator) return;
  if (!ws || ws.readyState !== WebSocket.OPEN || wagerLocked) return;
  ws.send(JSON.stringify({ type: "room:set_wager", wager: Number(wagerSlider.value) }));
});

readyBtn.addEventListener("click", () => {
  if (isSpectator) return;
  unlockAudio(); try { sfx.click(); } catch {}
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  iAmReady = !iAmReady;
  ws.send(JSON.stringify({ type: "room:ready", ready: iAmReady }));
  readyBtn.textContent = iAmReady ? "Cancel Ready" : "I'm Ready";
  readyBtn.className = iAmReady ? "rounded-lg border border-slate-700 hover:bg-slate-800 px-6 py-3 text-sm font-bold transition whitespace-nowrap" : "rounded-lg bg-brand-600 hover:bg-brand-700 px-6 py-3 text-sm font-bold transition whitespace-nowrap";
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "chat:send", content: text }));
  chatInput.value = "";
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function animateRoll(result) {
  wagerLocked = true; wagerSlider.disabled = true; readyBtn.disabled = true; readyBtn.classList.add("opacity-50", "cursor-not-allowed"); clearDice(); setStatus("Rolling…", "purple");
  try { sfx.diceRoll(); } catch {}
  for (let i = 0; i < 12; i++) { diceA.innerHTML = `<div class="die rolling">${DICE_FACES[1 + Math.floor(Math.random() * 6)]}</div>`; try { sfx.diceTick(); } catch {} await sleep(50); }
  try { sfx.diceLand(); } catch {}
  diceA.innerHTML = `<div class="die">${DICE_FACES[result.roll_a.dice[0]]}</div><div class="die">${DICE_FACES[result.roll_a.dice[1]]}</div>`; totalA.textContent = result.roll_a.total;
  await sleep(200);
  try { sfx.diceRoll(); } catch {}
  for (let i = 0; i < 12; i++) { diceB.innerHTML = `<div class="die rolling">${DICE_FACES[1 + Math.floor(Math.random() * 6)]}</div>`; try { sfx.diceTick(); } catch {} await sleep(50); }
  try { sfx.diceLand(); } catch {}
  diceB.innerHTML = `<div class="die">${DICE_FACES[result.roll_b.dice[0]]}</div><div class="die">${DICE_FACES[result.roll_b.dice[1]]}</div>`; totalB.textContent = result.roll_b.total;
  await sleep(300);

  if (result.winner_id === null) { 
    setStatus("Draw — refunded"); winnerBanner.textContent = "🤝 DRAW"; winnerBanner.className = "mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-extrabold pop text-slate-300"; try { sfx.draw(); } catch {} 
  } else if (result.winner_id === myId) { 
    setStatus("You won!", "green"); winnerBanner.textContent = `🏆 YOU WON ${result.pot} PC!`; winnerBanner.className = "mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-extrabold pop text-emerald-400"; try { sfx.win(); } catch {}
    const oppName = members.find(m => m.user_id !== myId)?.username || "Opponent";
    setupShareResult(oppName, "Roll-off");
  } else { 
    setStatus("You lost", "red"); winnerBanner.textContent = `You lost ${result.wager} PC`; winnerBanner.className = "mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-extrabold pop text-red-400"; try { sfx.lose(); } catch {} 
  }
  winnerBanner.classList.remove("hidden");

  readyBtn.textContent = "Play Again"; readyBtn.disabled = false; readyBtn.classList.remove("opacity-50", "cursor-not-allowed"); iAmReady = false; wagerLocked = false; wagerSlider.disabled = false;
}

function ensureLudoBoard() {
  if (ludoBoard) return ludoBoard;
  ludoBoard = new LudoBoard(ludoContainer);
  ludoBoard.setIdentity(myId);
  ludoBoard.setCallbacks({
    onRoll: () => { unlockAudio(); try { sfx.click(); } catch {}; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ludo:roll" })); },
    onMove: (tokenIndex) => { unlockAudio(); try { sfx.click(); } catch {}; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ludo:move", token_index: tokenIndex })); },
  });
  return ludoBoard;
}

function ensureChessBoard() {
  if (chessBoard) return chessBoard;
  chessBoard = new ChessBoard(chessContainer);
  chessBoard.setCallbacks({
    onMove: (uci) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chess:move", uci })); },
    onResign: () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chess:resign" })); },
    onOfferDraw: () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chess:offer_draw" })); },
  });
  return chessBoard;
}

function ensureWhotBoard() {
  if (whotBoard) return whotBoard;
  whotBoard = new WhotBoard(whotContainer);
  whotBoard.setIdentity(myId);
  whotBoard.setCallbacks({
    onPlay: (cardIndex, shape) => { 
      if (isSpectator) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "whot:play", card_index: cardIndex, chosen_shape: shape }));
      }
    },
    onDraw: () => { 
      if (isSpectator) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "whot:draw" }));
      }
    },
  });
  return whotBoard;
}

function connectWebSocket(token) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let url = `${proto}//${location.host}/ws/room/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`;
  if (reconnectToken && !isSpectator) url += `&reconnect_token=${encodeURIComponent(reconnectToken)}`;
  if (isSpectator) url += `&spectator=true`;
  ws = new WebSocket(url);
  
  ws.addEventListener("open", () => { 
    chatStatus.textContent = "● connected"; 
    chatStatus.className = "text-xs text-emerald-400";
    reconnectAttempts = 0;
    if (reconnectBanner && !isSpectator) {
      showReconnectBanner("✓ Reconnected", "green");
      setTimeout(hideReconnectBanner, 1500);
    }

    // 🟢 HEARTBEAT: Send ping every 20 seconds to keep Render alive
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);

  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    // 🟢 IGNORE PONG RESPONSES
    if (msg.type === "pong" || msg.type === "ping") return;

    switch (msg.type) {
      case "room:init": {
        if (msg.reconnect_token && !isSpectator) {
          reconnectToken = msg.reconnect_token;
          localStorage.setItem(RECONNECT_KEY, reconnectToken);
        }
        
        members = msg.members; renderMembers();
        for (const m of msg.messages) addMessage(m);
        if (msg.match) { currentMatch = msg.match; wagerSlider.value = msg.match.wager; wagerValue.textContent = msg.match.wager; }
        updateGameCard(msg.room.game_slug || "dice");
        if (msg.room) renderRoomCodeBanner(msg.room);
        
        if (msg.is_spectator) {
          setStatus("👁️ SPECTATING", "purple");
        } else {
          setStatus("Waiting for both ready");
        }
        
        if (msg.match && msg.match.game_slug === "ludo" && msg.ludo_state) { 
          selectorPanel.classList.add("hidden"); 
          ensureLudoBoard().update(msg.ludo_state); 
        }
        if (msg.match && msg.match.game_slug === "chess" && msg.chess_state) {
          selectorPanel.classList.add("hidden");
          const b = ensureChessBoard();
          b.setIdentity(myId, msg.chess_state.white_id, msg.chess_state.black_id, msg.chess_state.white_tier);
          if (msg.chess_state.board) b.update(msg.chess_state.board);
          const hist = msg.chess_state.moves || []; if (hist.length > 0) b.setLastMove(hist[hist.length - 1]);
        }
        if (msg.match && msg.match.game_slug === "whot" && msg.whot_state) {
          selectorPanel.classList.add("hidden");
          ensureWhotBoard().update(msg.whot_state);
        }
        break;
      }
      case "chat:message": addMessage(msg); if (msg.sender_id !== myId) { try { sfx.message(); } catch {} } break;
      case "room:ready_update": { for (const ru of msg.members) { const m = members.find((x) => x.user_id === ru.user_id); if (m) m.ready = ru.ready; } renderMembers(); break; }
      case "room:all_ready": setStatus("Starting…", "purple"); document.getElementById("shareResultDiv")?.classList.add("hidden"); break;
      case "room:player_disconnected": {
        const m = members.find((x) => x.user_id === msg.user_id);
        if (m) setStatus(`${m.username} disconnected — waiting…`, "purple");
        break;
      }
      case "room:wager_update": currentMatch = msg.match; wagerSlider.value = msg.match.wager; wagerValue.textContent = msg.match.wager; break;
      case "room:game_update": updateGameCard(msg.game_slug); break;
      case "match:result": animateRoll(msg.result); break;
      case "match:error": setStatus("Error: " + msg.error, "red"); readyBtn.disabled = false; readyBtn.classList.remove("opacity-50", "cursor-not-allowed"); break;
      
      // LUDO
      case "ludo:start": { selectorPanel.classList.add("hidden"); wagerSlider.value = msg.wager; wagerValue.textContent = msg.wager; wagerSlider.disabled = true; ensureLudoBoard().handleStart(msg.state); break; }
      case "ludo:rolled": ensureLudoBoard().handleRoll({ userId: msg.user_id, roll: msg.roll, legalMoves: msg.legal_moves || [], state: msg.state }); break;
      case "ludo:moved": ensureLudoBoard().handleMove({ userId: msg.user_id, tokenIndex: msg.token_index, captured: msg.captured || [], enteredHome: msg.entered_home, extraTurn: msg.extra_turn, state: msg.state }); break;
      case "ludo:end": {
        const b = ensureLudoBoard(); b.handleEnd({ winnerId: msg.winner_user_id, wager: msg.wager, pot: msg.pot });
        try { if (msg.winner_user_id === myId) sfx.win(); else if (msg.winner_user_id) sfx.lose(); else sfx.draw(); } catch {}
        if (msg.winner_user_id === myId) {
          const oppName = members.find(m => m.user_id !== myId)?.username || "Opponent";
          setupShareResult(oppName, "Ludo");
        }
        iAmReady = false; readyBtn.textContent = "I'm Ready"; readyBtn.disabled = false; readyBtn.classList.remove("opacity-50", "cursor-not-allowed"); wagerSlider.disabled = false;
        setTimeout(() => { selectorPanel.classList.remove("hidden"); if (ludoContainer) ludoContainer.innerHTML = ""; ludoBoard = null; }, 5000); break;
      }
      case "ludo:error": ensureLudoBoard().showMessage(msg.error, "error"); break;

      // CHESS
      case "chess:start": {
        selectorPanel.classList.add("hidden"); wagerSlider.value = msg.wager; wagerValue.textContent = msg.wager; wagerSlider.disabled = true;
        const b = ensureChessBoard(); b.setIdentity(myId, msg.white_id, msg.black_id, msg.white_tier); b.update(msg.board); b.showMessage("Game started. White moves first.", "info"); break;
      }
      case "chess:moved": {
        const b = ensureChessBoard(); b.setLastMove(msg.uci);
        if (msg.user_id !== myId) { try { b.playOpponentMoveSound(false); } catch {} }
        b.update(msg.board); if (msg.board && msg.board.in_check) { try { b.playCheckSound(); } catch {} } break;
      }
      case "chess:end": {
        const b = ensureChessBoard();
        if (b.state) { b.state.result = msg.result; b.update(b.state); }
        b.showMessage(msg.result === "draw" ? "🤝 Draw" : (msg.winner_id === myId ? "🏆 You won!" : "You lost"), msg.winner_id === myId ? "success" : "error");
        try { if (msg.result === "draw") sfx.draw(); else if (msg.winner_id === myId) sfx.win(); else sfx.lose(); } catch {}
        if (msg.winner_id === myId) {
          const oppName = members.find(m => m.user_id !== myId)?.username || "Opponent";
          setupShareResult(oppName, "Chess");
        }
        iAmReady = false; readyBtn.textContent = "I'm Ready"; readyBtn.disabled = false; readyBtn.classList.remove("opacity-50", "cursor-not-allowed"); wagerSlider.disabled = false;
        setTimeout(() => { selectorPanel.classList.remove("hidden"); if (chessContainer) chessContainer.innerHTML = ""; chessBoard = null; }, 5000); break;
      }
      case "chess:error": ensureChessBoard().showMessage(msg.error, "error"); break;
      case "chess:draw_offered": { const accepted = confirm("Your opponent offers a draw. Accept?"); if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chess:respond_draw", accept: accepted })); break; }
      case "chess:draw_offered_sent": ensureChessBoard().showMessage("Draw offer sent to opponent", "info"); break;
      case "chess:draw_declined": ensureChessBoard().showMessage("Opponent declined the draw", "info"); break;

      // WHOT
      case "whot:start": {
        selectorPanel.classList.add("hidden");
        wagerSlider.value = msg.wager;
        wagerValue.textContent = msg.wager;
        wagerSlider.disabled = true;
        ensureWhotBoard().update(msg.state);
        ensureWhotBoard().showMessage("Game started!", "info");
        break;
      }
      case "whot:played": {
        ensureWhotBoard().update(msg.state);
        break;
      }
      case "whot:error": {
        ensureWhotBoard().showMessage(msg.error, "error");
        break;
      }
      case "whot:end": {
        const b = ensureWhotBoard();
        b.showMessage(msg.winner_user_id === myId ? "🏆 You won!" : "You lost", msg.winner_user_id === myId ? "success" : "error");
        try { if (msg.winner_user_id === myId) sfx.win(); else sfx.lose(); } catch {}
        if (msg.winner_user_id === myId) {
          const oppName = members.find(m => m.user_id !== myId)?.username || "Opponent";
          setupShareResult(oppName, "Whot");
        }
        iAmReady = false; readyBtn.textContent = "I'm Ready"; readyBtn.disabled = false; readyBtn.classList.remove("opacity-50", "cursor-not-allowed"); wagerSlider.disabled = false;
        setTimeout(() => { selectorPanel.classList.remove("hidden"); if (whotContainer) whotContainer.innerHTML = ""; whotBoard = null; }, 5000); 
        break;
      }
    }
  });

  ws.addEventListener("close", () => {
    // 🟢 CLEAR HEARTBEAT ON CLOSE
    clearInterval(pingInterval);
    
    chatStatus.textContent = "● disconnected";
    chatStatus.className = "text-xs text-red-400";

    if (isSpectator) return; // Spectators don't auto-reconnect

    if (reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
      reconnectAttempts++;
      showReconnectBanner(`⚠️ Reconnecting… (${reconnectAttempts}/5)`, "amber");
      setTimeout(() => {
        const t = api.getToken();
        if (t) connectWebSocket(t);
      }, delay);
    } else {
      showReconnectBanner("❌ Connection lost — refresh to retry", "red");
    }
  });
}

async function boot() {
  if (!roomId) { window.location.href = "/lobby"; return; }
  const token = api.getToken();
  if (!token) { window.location.href = "/"; return; }

  try { me = await api.me(); myId = me.id; } catch { api.clearToken(); window.location.href = "/"; return; }

  // 🟢 THE MAGIC FIX: Check if roomId is a 6-char code (like NYAM6V). If so, join first to get the real UUID.
  if (roomId.length <= 8 && !isSpectator) {
    try {
      const joinRes = await api.request(`/api/v1/rooms/join/${roomId}`, { method: "POST" });
      if (joinRes && joinRes.id) {
        roomId = joinRes.id; // Swap the code out for the UUID
      }
    } catch (err) {
      console.error("Failed to join room by code:", err);
      alert("Could not join this room. It might be full or already started.");
      window.location.href = "/lobby";
      return;
    }
  }

  document.body.classList.remove("chat-open");
  const unlockOnce = () => { try { unlockAudio(); } catch {} };
  window.addEventListener("click", unlockOnce, { once: true });
  window.addEventListener("touchstart", unlockOnce, { once: true });
  window.addEventListener("keydown", unlockOnce, { once: true });

  if (isSpectator) {
    selectorPanel?.classList.add("hidden");
    readyBtn?.classList.add("hidden");
    wagerSlider?.setAttribute("disabled", "true");
    if (statusLine) statusLine.textContent = "👁️ You are spectating this game.";
  }

  connectWebSocket(token);
}

boot();

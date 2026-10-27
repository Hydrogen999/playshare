import { api } from "./api.js";
import { sfx, unlockAudio } from "./sounds.js";

const $ = (id) => document.getElementById(id);

let pollTimer = null;

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showToast(text) {
  const el = $("roomsMsg");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

function gameIcon(slug) {
  if (slug === "ludo") return "🎯";
  if (slug === "chess") return "♟️";
  if (slug === "dice") return "🎲";
  return "🎮";
}

function gameLabel(slug) {
  if (slug === "ludo") return "Ludo";
  if (slug === "chess") return "Chess";
  if (slug === "dice") return "Roll-off";
  return "Game";
}

  list.innerHTML = rooms.map((r) => {
    const icon = gameIcon(r.game_slug);
    const label = gameLabel(r.game_slug);
    const isFull = r.player_count >= r.max_players;
    const isAlmostFull = r.player_count === r.max_players - 1;
    const isPlaying = r.status === "playing"; // <-- Check status

    let statusBadge = "";
    if (isPlaying) {
      statusBadge = `<span class="text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-bold animate-pulse">LIVE</span>`;
    } else if (isFull) {
      statusBadge = `<span class="text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-bold">FULL</span>`;
    } else if (isAlmostFull) {
      statusBadge = `<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">1 SLOT</span>`;
    } else {
      statusBadge = `<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold">OPEN</span>`;
    }

    return `
      <div class="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-800/40 hover:border-brand-500/40 transition px-3 py-2.5">
        <div class="text-2xl flex-shrink-0">${icon}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <div class="text-xs font-bold truncate">${escapeHTML(r.creator_username)}'s ${label}</div>
            ${statusBadge}
          </div>
          <div class="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2">
            <span>👥 ${r.player_count}/${r.max_players}</span>
            <span>·</span>
            <span class="font-mono">${r.code}</span>
          </div>
        </div>
        ${isPlaying ? `
          <a href="/room?id=${r.id}&spectate=true" class="text-[10px] px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 font-bold transition flex-shrink-0 text-white shadow-lg shadow-red-500/20">
            👁️ Watch
          </a>
        ` : !isFull ? `
          <button data-join="${r.code}" class="text-[10px] px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 font-bold transition flex-shrink-0">
            Join →
          </button>
        ` : `
          <span class="text-[10px] text-slate-600 flex-shrink-0">full</span>
        `}
      </div>
    `;
  }).join("");

  list.querySelectorAll("[data-join]").forEach((btn) => {
    btn.addEventListener("click", () => joinRoom(btn.dataset.join));
  });


async function refreshRooms() {
  try {
    const data = await api.listPublicRooms();
    renderRooms(data.rooms);
  } catch (err) {
    console.error("rooms load error", err);
  }
}

async function createRoom(gameSlug, maxPlayers, isPublic = true) {
  unlockAudio();
  try { sfx.click(); } catch {}
  try {
    const res = await api.createRoom({
      game_slug: gameSlug,
      max_players: maxPlayers,
      is_public: isPublic,
    });
    // Store reconnect token from server
    if (res.reconnect_token) {
      localStorage.setItem(`ps_rc_${res.id}`, res.reconnect_token);
    }
    showToast(isPublic ? "Public room created!" : "Private room created — share the code!");
    try { sfx.success(); } catch {}
    setTimeout(() => { window.location.href = `/room?id=${res.id}`; }, 400);
  } catch (err) {
    try { sfx.error(); } catch {}
    showToast(err.message);
  }
}


async function joinRoom(code) {
  unlockAudio();
  try { sfx.click(); } catch {}
  try {
    const res = await api.joinRoomByCode(code);
    try { sfx.success(); } catch {}
    window.location.href = `/room?id=${res.id}`;
  } catch (err) {
    try { sfx.error(); } catch {}
    showToast(err.message);
  }
}

function boot() {
  if (!api.getToken()) return;

  const ludo4Btn = $("createLudo4Btn");
  const ludo3Btn = $("createLudo3Btn");
  const ludo2Btn = $("createLudo2Btn");
  const chessBtn = $("createChessBtn");
  const codeInput = $("roomCodeInput");
  const codeBtn = $("roomCodeBtn");
  const refreshBtn = $("refreshRoomsBtn");

  if (ludo4Btn) ludo4Btn.addEventListener("click", () => createRoom("ludo", 4));
  if (ludo3Btn) ludo3Btn.addEventListener("click", () => createRoom("ludo", 3));
  if (ludo2Btn) ludo2Btn.addEventListener("click", () => createRoom("ludo", 2));
  if (chessBtn) chessBtn.addEventListener("click", () => createRoom("chess", 2));

  if (codeBtn && codeInput) {
    codeBtn.addEventListener("click", () => {
      const code = (codeInput.value || "").trim().toUpperCase();
      if (!code) return;
      joinRoom(code);
    });
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const code = (codeInput.value || "").trim().toUpperCase();
        if (code) joinRoom(code);
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      try { sfx.tap(); } catch {}
      refreshRooms();
    });
  }

  refreshRooms();
  pollTimer = setInterval(refreshRooms, 6000);
}
const privateLudoBtn = $("createPrivateLudoBtn");
  const privateChessBtn = $("createPrivateChessBtn");
  if (privateLudoBtn) privateLudoBtn.addEventListener("click", () => createRoom("ludo", 4, false));
  if (privateChessBtn) privateChessBtn.addEventListener("click", () => createRoom("chess", 2, false));
boot();
  

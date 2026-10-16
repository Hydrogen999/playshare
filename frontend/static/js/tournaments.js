import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null;
let myId = null;
let activeTab = "open";
let pollTimer = null;
let openDetailId = null;

function showMsg(text, type = "info") {
  const el = $("msg");
  const colors = {
    info: "bg-slate-800 border-slate-700 text-slate-300",
    success: "bg-emerald-500/10 border-emerald-500/40 text-emerald-400",
    error: "bg-red-500/10 border-red-500/40 text-red-400",
  };
  el.className = `mt-4 rounded-lg p-3 text-sm text-center border ${colors[type]}`;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Tabs
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      if (b.dataset.tab === activeTab) {
        b.className = "tab-btn px-4 py-2.5 text-sm font-bold text-brand-400 border-b-2 border-brand-500";
      } else {
        b.className = "tab-btn px-4 py-2.5 text-sm font-bold text-slate-400 hover:text-slate-200";
      }
    });
    load();
  });
});

// ---------- Render list ----------
function renderList(items) {
  const grid = $("listArea");
  if (!items || items.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-500 text-sm py-8">${
      activeTab === "open" ? "No open tournaments. Create one!" : "You haven't joined any tournaments yet."
    }</div>`;
    return;
  }

  grid.innerHTML = items.map((t) => {
    const joined = t.player_count !== undefined
      ? t.player_count
      : (t.status !== "waiting" ? null : null);

    const statusBadge = t.status === "waiting"
      ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">OPEN</span>`
      : t.status === "active"
      ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-brand-500/20 text-brand-400">IN PROGRESS</span>`
      : t.status === "finished"
      ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">FINISHED</span>`
      : "";

    const placement = t.placement
      ? `<div class="mt-2 text-xs font-bold ${
          t.placement === 1 ? "text-yellow-400" :
          t.placement === 2 ? "text-slate-300" :
          t.placement === 3 ? "text-orange-400" : "text-slate-500"
        }">${t.placement === 1 ? "🥇 1st place" : t.placement === 2 ? "🥈 2nd place" : t.placement === 3 ? "🥉 3rd place" : `#${t.placement}`}</div>`
      : "";

    const countDisplay = t.player_count !== undefined
      ? `${t.player_count}/${t.max_players}`
      : `${t.max_players} players`;

    return `
      <div class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 flex flex-col cursor-pointer hover:border-brand-500/50 transition" data-open="${t.id}">
        <div class="flex items-start justify-between">
          <div class="font-bold text-sm">${escapeHTML(t.name)}</div>
          ${statusBadge}
        </div>
        <div class="text-xs text-slate-400 mt-2 space-y-1">
          <div>🎟️ Entry: <span class="text-slate-200 font-semibold">${t.entry_fee} PC</span></div>
          <div>💰 Prize pool: <span class="text-brand-400 font-semibold">${t.prize_pool} PC</span></div>
          <div>👥 ${countDisplay}</div>
        </div>
        ${placement}
      </div>`;
  }).join("");

  grid.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.open));
  });
}

// ---------- Detail view ----------
async function openDetail(id) {
  openDetailId = id;
  try {
    const d = await api.getTournament(id);
    renderDetail(d);
    const modal = $("detailModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  } catch (err) {
    showMsg(err.message, "error");
  }
}

function renderDetail(d) {
  const joined = d.players.some((p) => p.user_id === myId);
  const isFull = d.players.length >= d.max_players;
  const canJoin = d.status === "waiting" && !joined && !isFull;

  const playersHTML = d.players.length === 0
    ? `<div class="text-sm text-slate-500">No players yet</div>`
    : d.players.map((p) => `
        <div class="flex items-center gap-3 py-2">
          <div>${avatarHTML(p.avatar_id, "sm")}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold truncate">${escapeHTML(p.username)}${p.user_id === myId ? " (you)" : ""}</div>
            <div class="text-xs text-slate-500">Level ${p.level}</div>
          </div>
          ${p.placement ? `<div class="text-xs font-bold ${
            p.placement === 1 ? "text-yellow-400" :
            p.placement === 2 ? "text-slate-300" : "text-orange-400"
          }">${p.placement === 1 ? "🥇" : p.placement === 2 ? "🥈" : "🥉"}</div>` : ""}
          ${p.eliminated && !p.placement ? `<div class="text-xs text-red-400">eliminated</div>` : ""}
        </div>`).join("");

  // Bracket
  const roundsMap = {};
  for (const m of d.matches) {
    roundsMap[m.round] = roundsMap[m.round] || [];
    roundsMap[m.round].push(m);
  }
  const rounds = Object.keys(roundsMap).sort((a, b) => a - b);

  const bracketHTML = rounds.length === 0
    ? `<div class="text-sm text-slate-500">Bracket will appear when the tournament starts</div>`
    : rounds.map((r) => `
        <div class="mb-4">
          <div class="text-xs font-bold text-brand-400 uppercase tracking-widest mb-2">Round ${r}</div>
          <div class="space-y-2">
            ${roundsMap[r].map((m) => {
              const nameOf = (uid) => {
                if (!uid) return `<span class="text-slate-600">TBD</span>`;
                const p = d.players.find((x) => x.user_id === uid);
                return p ? `<span class="${uid === myId ? "text-brand-400 font-bold" : ""}">${escapeHTML(p.username)}</span>` : `<span class="text-slate-500">unknown</span>`;
              };
              const roomLink = m.room_id && (m.player_a === myId || m.player_b === myId) && m.status === "active"
                ? `<a href="/room?id=${m.room_id}" class="ml-2 text-[10px] px-2 py-0.5 rounded bg-brand-600 hover:bg-brand-700 font-bold">PLAY →</a>`
                : "";
              const winMark = (uid) => m.winner_id === uid ? `<span class="text-emerald-400 ml-1">✓</span>` : "";
              return `
                <div class="flex items-center gap-2 text-sm rounded-lg bg-slate-800/40 px-3 py-2">
                  <div class="flex-1 min-w-0 truncate">${nameOf(m.player_a)}${winMark(m.player_a)}</div>
                  <div class="text-xs text-slate-500 font-mono">vs</div>
                  <div class="flex-1 min-w-0 truncate text-right">${nameOf(m.player_b)}${winMark(m.player_b)}</div>
                  ${roomLink}
                </div>`;
            }).join("")}
          </div>
        </div>`).join("");

  const actionBtn = joined && d.status === "waiting"
    ? `<button id="leaveBtn" class="w-full mt-3 rounded-lg border border-red-700/50 bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2.5 text-sm font-bold">Leave Tournament</button>`
    : canJoin
    ? `<button id="joinBtn" class="w-full mt-3 rounded-lg bg-brand-600 hover:bg-brand-700 px-4 py-2.5 text-sm font-bold">Join for ${d.entry_fee} PC</button>`
    : "";

  const statusLabel = d.status === "waiting" ? "Waiting for players"
    : d.status === "active" ? "In progress"
    : d.status === "finished" ? "Finished" : d.status;

  $("detailBody").innerHTML = `
    <div class="flex items-start justify-between">
      <div>
        <div class="text-xl font-extrabold">${escapeHTML(d.name)}</div>
        <div class="text-xs text-slate-500 mt-1">${statusLabel}</div>
      </div>
      <div class="text-right">
        <div class="text-xs text-slate-500">Prize pool</div>
        <div class="text-xl font-bold text-brand-400">${d.prize_pool} PC</div>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-2 mt-4 text-xs">
      <div class="rounded-lg bg-slate-800/50 px-3 py-2">
        <div class="text-slate-500">Entry</div>
        <div class="font-bold">${d.entry_fee} PC</div>
      </div>
      <div class="rounded-lg bg-slate-800/50 px-3 py-2">
        <div class="text-slate-500">Size</div>
        <div class="font-bold">${d.players.length}/${d.max_players}</div>
      </div>
      <div class="rounded-lg bg-slate-800/50 px-3 py-2">
        <div class="text-slate-500">Payout</div>
        <div class="font-bold">70/20/5%</div>
      </div>
    </div>

    ${actionBtn}

    <div class="mt-5">
      <div class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Players</div>
      <div class="divide-y divide-slate-800">${playersHTML}</div>
    </div>

    <div class="mt-5">
      <div class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Bracket</div>
      ${bracketHTML}
    </div>
  `;

  // Wire buttons
  const joinBtn = $("joinBtn");
  if (joinBtn) joinBtn.addEventListener("click", async () => {
    joinBtn.disabled = true;
    joinBtn.textContent = "Joining…";
    try {
      await api.joinTournament(d.id);
      showMsg("Joined! Waiting for players…", "success");
      await load();
      await openDetail(d.id);
    } catch (err) {
      showMsg(err.message, "error");
      joinBtn.disabled = false;
    }
  });

  const leaveBtn = $("leaveBtn");
  if (leaveBtn) leaveBtn.addEventListener("click", async () => {
    if (!confirm("Leave this tournament? Entry fee will be refunded.")) return;
    leaveBtn.disabled = true;
    try {
      await api.leaveTournament(d.id);
      showMsg("Left tournament. Refunded.", "success");
      await load();
      closeDetail();
    } catch (err) {
      showMsg(err.message, "error");
      leaveBtn.disabled = false;
    }
  });
}

function closeDetail() {
  const modal = $("detailModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  openDetailId = null;
}

$("detailClose").addEventListener("click", closeDetail);

// ---------- Create modal ----------
$("createBtn").addEventListener("click", () => {
  const modal = $("createModal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
});

$("createCancel").addEventListener("click", () => {
  const modal = $("createModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
});

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    name: fd.get("name"),
    entry_fee: Number(fd.get("entry_fee")),
    max_players: Number(fd.get("max_players")),
  };
  try {
    await api.createTournament(payload);
    showMsg("Tournament created! Waiting for players…", "success");
    const modal = $("createModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    e.target.reset();
    await load();
  } catch (err) {
    showMsg(err.message, "error");
  }
});

// ---------- Load ----------
async function load() {
  try {
    const [meData, data] = await Promise.all([
      api.me(),
      activeTab === "open" ? api.listTournaments() : api.myTournaments(),
    ]);
    me = meData;
    myId = me.id;
    $("balance").textContent = me.profile.tokens;
    renderList(data.tournaments || []);
  } catch (err) {
    showMsg(err.message, "error");
  }
}

async function boot() {
  if (!api.getToken()) {
    window.location.href = "/";
    return;
  }
  try {
    me = await api.me();
    myId = me.id;
  } catch {
    api.clearToken();
    window.location.href = "/";
    return;
  }
  await load();
  pollTimer = setInterval(async () => {
    await load();
    if (openDetailId) await openDetail(openDetailId);
  }, 5000);
}

boot();
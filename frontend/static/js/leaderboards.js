import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let category = "xp";
let scope = "global";
let meId = null;
let pollTimer = null;

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function medal(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `#${rank}`;
}

function rankRowClass(rank) {
  if (rank === 1) return "rank-1";
  if (rank === 2) return "rank-2";
  if (rank === 3) return "rank-3";
  return "";
}

function renderEntries(data) {
  const list = $("entriesList");
  if (!data.entries || data.entries.length === 0) {
    list.innerHTML = `<div class="text-center text-slate-500 text-sm py-8">No players yet — go play a match!</div>`;
    return;
  }
  list.innerHTML = data.entries.map((e) => {
    const isMe = e.user_id === meId;
    const rowClass = isMe ? "me-row" : rankRowClass(e.rank);
    const crown = e.is_premium ? ' <span class="text-amber-400">👑</span>' : '';
    return `
      <div class="flex items-center gap-3 rounded-xl border px-3 sm:px-4 py-3 border-slate-800 bg-slate-900/60 ${rowClass}">
        <div class="w-8 sm:w-10 text-center font-black text-sm ${e.rank <= 3 ? "text-lg sm:text-2xl" : "text-slate-400"}">
          ${medal(e.rank)}
        </div>
        <div class="flex-shrink-0">${avatarHTML(e.avatar_id, "sm", e.frame_color, e.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-bold truncate">${escapeHTML(e.username)}${crown}${isMe ? ' <span class="text-brand-400">(you)</span>' : ''}</div>
          <div class="text-[10px] text-slate-500">Level ${e.level}</div>
        </div>
        <div class="text-right">
          <div class="text-sm font-black text-brand-400">${e.value_label}</div>
        </div>
      </div>
    `;
  }).join("");
}

function renderMyRank(me) {
  if (me.rank === null) {
    $("myRankLine").textContent = "Not ranked yet";
    $("myValue").textContent = me.value_label || "–";
    $("myRankSub").textContent = "Play matches or earn XP to appear here";
    return;
  }
  $("myRankLine").textContent = `#${me.rank} of ${me.total_players}`;
  $("myValue").textContent = me.value_label;
  if (me.in_top) {
    $("myRankSub").textContent = "You're in the top 50! 🎉";
  } else {
    $("myRankSub").textContent = `You're ranked #${me.rank}. Keep playing to climb!`;
  }
}

async function load() {
  try {
    const data = await api.leaderboard(category, scope);
    renderEntries(data);
    renderMyRank(data.me);
  } catch (err) {
    $("entriesList").innerHTML = `<div class="text-center text-red-400 text-sm py-8">${escapeHTML(err.message)}</div>`;
  }
}

// Scope tabs
document.querySelectorAll(".scope-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    scope = btn.dataset.scope;
    document.querySelectorAll(".scope-btn").forEach((b) => {
      if (b.dataset.scope === scope) {
        b.className = "scope-btn px-4 py-2 text-sm font-bold rounded-lg bg-brand-600";
      } else {
        b.className = "scope-btn px-4 py-2 text-sm font-bold rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200";
      }
    });
    load();
  });
});

// Category tabs
document.querySelectorAll(".cat-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    category = btn.dataset.cat;
    document.querySelectorAll(".cat-btn").forEach((b) => {
      if (b.dataset.cat === category) {
        b.className = "cat-btn px-3 sm:px-4 py-2 text-xs sm:text-sm font-bold rounded-lg border border-brand-500 bg-brand-500/20 text-brand-400";
      } else {
        b.className = "cat-btn px-3 sm:px-4 py-2 text-xs sm:text-sm font-bold rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200";
      }
    });
    load();
  });
});

async function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }
  try {
    const me = await api.me();
    meId = me.id;
  } catch {
    api.clearToken();
    window.location.href = "/";
    return;
  }
  await load();
  pollTimer = setInterval(load, 15000);
}

boot();
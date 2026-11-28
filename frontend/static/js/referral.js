import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let myCode = "";
let pollTimer = null;

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showCopyMsg(text) {
  const el = $("copyMsg");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showCopyMsg._t);
  showCopyMsg._t = setTimeout(() => el.classList.add("hidden"), 2000);
}

function formatCode(code) {
  return code.split("").join(" ");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    return true;
  }
}

function renderRecent(recent) {
  const list = $("recentList");
  if (!recent || recent.length === 0) {
    list.innerHTML = `<div class="text-xs text-slate-500 text-center py-4">No referrals yet — share your code!</div>`;
    return;
  }
  list.innerHTML = recent.map((r) => `
    <div class="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2">
      <div class="flex-shrink-0">${avatarHTML(r.avatar_id, "sm", null, r.is_premium)}</div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-bold truncate">${escapeHTML(r.username)}${r.is_premium ? ' <span class="text-amber-400">👑</span>' : ''}</div>
        <div class="text-[10px] text-slate-500">Level ${r.level}</div>
      </div>
      <div class="text-xs font-bold text-emerald-400">+500 PC</div>
    </div>
  `).join("");
}

async function load() {
  try {
    const data = await api.myReferral();
    myCode = data.code;
    $("myCode").textContent = formatCode(myCode);
    $("statTotal").textContent = data.total_referrals;
    $("statEarned").textContent = data.total_earned_coins.toLocaleString();
    renderRecent(data.recent);
  } catch (err) {
    console.error(err);
  }
}

function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }

  $("copyCodeBtn").addEventListener("click", async () => {
    if (!myCode) return;
    await copyText(myCode);
    showCopyMsg("Code copied! ✓");
  });

  $("copyLinkBtn").addEventListener("click", async () => {
    if (!myCode) return;
    const link = `${location.origin}/login?ref=${myCode}`;
    await copyText(link);
    showCopyMsg("Invite link copied! Share it now 🎉");
  });

  load();
  pollTimer = setInterval(load, 15000);
}

boot();
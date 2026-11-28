import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

let allItems = [];
let filter = "all";

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function render() {
  const grid = $("grid");
  let items = allItems;
  if (filter === "unlocked") items = allItems.filter((x) => x.unlocked);
  if (filter === "locked")   items = allItems.filter((x) => !x.unlocked);

  if (items.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-500 text-sm py-8">Nothing here yet.</div>`;
    return;
  }

  grid.innerHTML = items.map((a) => `
    <div class="rounded-2xl border-2 ${a.unlocked ? `tier-${a.tier}` : "border-slate-800"} ${a.unlocked ? "" : "locked"} bg-slate-900/60 p-4 flex flex-col items-center text-center">
      <div class="text-4xl sm:text-5xl mb-2">${a.unlocked ? a.icon : "🔒"}</div>
      <div class="font-bold text-xs sm:text-sm">${escapeHTML(a.name)}</div>
      <div class="text-[10px] sm:text-xs text-slate-500 mt-1 leading-tight">${escapeHTML(a.desc)}</div>

      ${a.unlocked
        ? `<div class="mt-2 text-[10px] uppercase font-bold text-emerald-400 tracking-widest">✓ Unlocked</div>`
        : `
          <div class="mt-2 w-full">
            <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div class="h-full bg-brand-500" style="width: ${Math.round((a.progress_pct || 0) * 100)}%"></div>
            </div>
            <div class="text-[10px] text-slate-500 mt-1">${a.progress}/${a.goal}</div>
          </div>
        `}
    </div>
  `).join("");
}

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    filter = btn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach((b) => {
      if (b.dataset.filter === filter) {
        b.className = "filter-btn px-3 py-2 text-xs font-bold rounded-lg bg-brand-600";
      } else {
        b.className = "filter-btn px-3 py-2 text-xs font-bold rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200";
      }
    });
    render();
  });
});

async function load() {
  // Check for newly unlocked first (safe — server filters duplicates)
  try { await api.checkAchievements(); } catch {}

  try {
    const data = await api.myAchievements();
    allItems = data.items;
    $("unlockedCount").textContent = data.unlocked;
    $("totalCount").textContent = data.total;
    const pct = data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0;
    $("progressBar").style.width = `${pct}%`;
    render();
  } catch (err) {
    $("grid").innerHTML = `<div class="col-span-full text-center text-red-400 text-sm py-8">${escapeHTML(err.message)}</div>`;
  }
}

function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }
  load();
}

boot();
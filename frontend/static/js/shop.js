import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

let activeTab = "shop";
let catalog = [];
let inventory = [];
let balance = 0;

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
  showMsg._t = setTimeout(() => el.classList.add("hidden"), 3000);
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
    render();
  });
});

function renderItem(item) {
  const card = document.createElement("div");
  card.className = "rounded-2xl border border-slate-800 bg-slate-900/60 p-3 sm:p-4 flex flex-col";

  const isOwned = item.owned;
  const isEquipped = item.equipped;

  card.innerHTML = `
    <div class="flex justify-center">
      <div class="frame-preview" style="background:${item.style};box-shadow:0 0 20px ${item.style}66">
        <div class="frame-preview-inner">😎</div>
      </div>
    </div>
    <div class="mt-3 text-center flex-1">
      <div class="font-bold text-sm">${item.name}</div>
      <div class="text-[11px] text-slate-500 mt-0.5">${item.description || ""}</div>
      <div class="mt-2 text-xs">
        ${isOwned
          ? `<span class="text-emerald-400 font-bold">✓ Owned</span>`
          : `<span class="text-brand-400 font-bold">${item.price} PC</span>`}
      </div>
    </div>
    <div class="mt-3">
      ${renderAction(item)}
    </div>
  `;

  const btn = card.querySelector("button");
  if (btn) {
    btn.addEventListener("click", () => handleAction(item, btn));
  }
  return card;
}

function renderAction(item) {
  if (item.equipped) {
    return `<button data-act="unequip" class="w-full rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 text-xs font-bold transition">Unequip</button>`;
  }
  if (item.owned) {
    return `<button data-act="equip" class="w-full rounded-lg bg-brand-600 hover:bg-brand-700 px-3 py-2 text-xs font-bold transition">Equip</button>`;
  }
  return `<button data-act="buy" class="w-full rounded-lg bg-brand-600 hover:bg-brand-700 px-3 py-2 text-xs font-bold transition">Buy · ${item.price} PC</button>`;
}

async function handleAction(item, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "…";

  try {
    if (btn.dataset.act === "buy") {
      const res = await api.shopBuy(item.id);
      balance = res.new_balance;
      showMsg(`Bought ${item.name}!`, "success");
    } else if (btn.dataset.act === "equip") {
      await api.shopEquip(item.id);
      showMsg(`Equipped ${item.name}`, "success");
    } else if (btn.dataset.act === "unequip") {
      await api.shopEquip(null);
      showMsg("Unequipped", "info");
    }
    await load();
  } catch (err) {
    showMsg(err.message, "error");
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function render() {
  const grid = $("itemsGrid");
  const items = activeTab === "shop" ? catalog : inventory;
  grid.innerHTML = "";
  if (items.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-500 text-sm py-8">${activeTab === "shop" ? "No items." : "You don't own any items yet. Go buy something!"}</div>`;
    return;
  }
  for (const item of items) {
    grid.appendChild(renderItem(item));
  }
}

async function load() {
  try {
    const [cat, inv, me] = await Promise.all([
      api.shopCatalog(),
      api.shopInventory(),
      api.me(),
    ]);
    catalog = cat.items;
    inventory = inv.items;
    balance = me.profile.tokens;
    $("balance").textContent = balance;
    render();
  } catch (err) {
    showMsg(err.message, "error");
  }
}

async function boot() {
  if (!api.getToken()) {
    window.location.href = "/";
    return;
  }
  await load();
}

boot();
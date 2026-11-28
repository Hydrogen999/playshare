import { api } from "./api.js";
import { sfx, unlockAudio } from "./sounds.js";

const $ = (id) => document.getElementById(id);

let mode = "ngn";
let ngnPacks = [];
let usdPacks = [];
let flwAvailable = false;

function showMsg(text, type = "info") {
  const el = $("msg");
  const colors = {
    info: "bg-slate-800 border-slate-700 text-slate-300",
    success: "bg-emerald-500/10 border-emerald-500/40 text-emerald-400",
    error: "bg-red-500/10 border-red-500/40 text-red-400",
  };
  el.className = `mt-6 rounded-lg p-3 text-sm text-center border ${colors[type]}`;
  el.textContent = text;
  el.classList.remove("hidden");
}

function renderPacks() {
  const grid = $("packsGrid");
  const packs = mode === "ngn" ? ngnPacks : usdPacks;

  if (!packs || packs.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-500 text-sm py-8">No packs available.</div>`;
    return;
  }

  grid.innerHTML = packs.map((p, i) => `
    <button type="button" data-pack="${p.id}" data-mode="${mode}"
      class="text-left rounded-2xl border border-slate-800 bg-slate-900/60 hover:border-brand-500/60 hover:bg-slate-900 transition p-5 ${i === 1 ? 'ring-2 ring-brand-500/50' : ''}">
      <div class="text-3xl">🪙</div>
      <div class="font-bold text-lg mt-3">${p.label}</div>
      <div class="text-xs text-slate-500 mt-0.5">Instant delivery</div>
      <div class="mt-4 flex items-center justify-between">
        <span class="text-brand-400 font-bold text-lg">${p.price_label}</span>
        <span class="text-xs px-2 py-1 rounded bg-brand-600 font-bold">Buy →</span>
      </div>
    </button>
  `).join("");

  grid.querySelectorAll("[data-pack]").forEach((btn) => {
    btn.addEventListener("click", () => startCheckout(btn.dataset.pack, btn.dataset.mode, btn));
  });
}

async function startCheckout(packId, useMode, btn) {
  unlockAudio();
  try { sfx.click(); } catch {}
  btn.disabled = true;
  const original = btn.innerHTML;
  showMsg("Opening checkout…", "info");

  try {
    const res = useMode === "usd"
      ? await api.flwCheckout(packId)
      : await api.checkout(packId);

    if (res.authorization_url) {
      window.location.href = res.authorization_url;
    } else {
      showMsg("Checkout failed. Try again.", "error");
      btn.disabled = false;
      btn.innerHTML = original;
    }
  } catch (err) {
    try { sfx.error(); } catch {}
    showMsg(err.message, "error");
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function switchTab(newMode) {
  mode = newMode;
  if (mode === "ngn") {
    $("tabNgn").className = "px-5 py-2.5 rounded-lg font-bold text-sm bg-brand-600";
    $("tabUsd").className = "px-5 py-2.5 rounded-lg font-bold text-sm bg-slate-800 text-slate-400 hover:text-slate-200";
  } else {
    $("tabUsd").className = "px-5 py-2.5 rounded-lg font-bold text-sm bg-brand-600";
    $("tabNgn").className = "px-5 py-2.5 rounded-lg font-bold text-sm bg-slate-800 text-slate-400 hover:text-slate-200";
  }
  renderPacks();
}

$("tabNgn").addEventListener("click", () => { try { sfx.tap(); } catch {}; switchTab("ngn"); });
$("tabUsd").addEventListener("click", () => { try { sfx.tap(); } catch {}; switchTab("usd"); });

async function checkCallback() {
  const params = new URLSearchParams(location.search);

  // Paystack
  const ref = params.get("reference") || params.get("trxref");
  if (ref) {
    showMsg("Verifying payment…", "info");
    for (let i = 0; i < 5; i++) {
      try {
        const res = await api.verifyPayment(ref);
        if (res.ok) {
          try { sfx.purchase(); } catch {}
          showMsg(`🎉 +${res.coins} PlayCoins added! New balance: ${res.balance}`, "success");
          $("balance").textContent = res.balance;
          window.history.replaceState({}, "", "/buy");
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Flutterwave
  const flwStatus = params.get("status");
  const flwTxRef = params.get("tx_ref");
  if (flwStatus && flwTxRef) {
    showMsg("Verifying payment…", "info");
    for (let i = 0; i < 5; i++) {
      try {
        const res = await api.flwVerify(flwTxRef);
        if (res.ok) {
          try { sfx.purchase(); } catch {}
          showMsg(`🎉 +${res.coins} PlayCoins added! New balance: ${res.balance}`, "success");
          $("balance").textContent = res.balance;
          window.history.replaceState({}, "", "/buy");
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function boot() {
  if (!api.getToken()) {
    window.location.href = "/";
    return;
  }
  try {
    const me = await api.me();
    $("balance").textContent = me.profile.tokens;
  } catch {
    api.clearToken();
    window.location.href = "/";
    return;
  }

  try {
    const data = await api.getPacks();
    ngnPacks = data.ngn_packs || [];
    usdPacks = data.usd_packs || [];
    flwAvailable = !!data.flw_available;
    if (!flwAvailable) {
      $("tabUsd").style.display = "none";
    }
    renderPacks();
  } catch (err) {
    showMsg(err.message, "error");
  }

  await checkCallback();
}

boot();
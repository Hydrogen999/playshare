import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

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

function renderPlans(plans) {
  const grid = $("plansGrid");
  if (!plans || plans.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-500 text-sm py-8">No plans available.</div>`;
    return;
  }
  grid.innerHTML = plans.map((p) => {
    const isYearly = p.id === "yearly";
    return `
      <button type="button" data-plan="${p.id}"
        class="text-left rounded-2xl border ${isYearly ? "border-amber-500/50 ring-2 ring-amber-500/30" : "border-slate-800"} bg-slate-900/60 hover:border-amber-500/70 transition p-6 relative">
        ${isYearly ? `<span class="absolute top-3 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500 text-slate-900">BEST VALUE</span>` : ""}
        <div class="text-3xl">👑</div>
        <div class="font-bold text-lg mt-3">${p.label}</div>
        <div class="text-brand-400 font-bold text-2xl mt-3">${p.price_label}</div>
        ${p.savings ? `<div class="text-xs text-emerald-400 mt-1">${p.savings}</div>` : ""}
        <div class="mt-4 text-xs px-3 py-2 rounded bg-slate-800 font-bold text-center">Subscribe →</div>
      </button>`;
  }).join("");

  grid.querySelectorAll("[data-plan]").forEach((btn) => {
    btn.addEventListener("click", () => startSubscribe(btn.dataset.plan, btn));
  });
}

async function startSubscribe(planId, btn) {
  btn.disabled = true;
  showMsg("Opening checkout…", "info");
  try {
    const res = await api.premiumSubscribe(planId);
    if (res.authorization_url) {
      window.location.href = res.authorization_url;
    } else {
      showMsg("Checkout failed. Try again.", "error");
      btn.disabled = false;
    }
  } catch (err) {
    showMsg(err.message, "error");
    btn.disabled = false;
  }
}

async function showActive(expiresIso) {
  const card = $("activeCard");
  card.classList.remove("hidden");
  const d = expiresIso ? new Date(expiresIso) : null;
  $("activeExpiry").textContent = d
    ? `Active until ${d.toLocaleDateString()}`
    : "Active";
}

async function checkCallback() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("reference") || params.get("trxref");
  if (!ref) return;

  showMsg("Verifying subscription…", "info");

  for (let i = 0; i < 5; i++) {
    try {
      const res = await api.premiumVerify(ref);
      if (res.ok) {
        showMsg("🎉 Welcome to Premium! Refresh to see your crown.", "success");
        await showActive(res.expires_at);
        window.history.replaceState({}, "", "/premium");
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  showMsg("Subscription is still processing. Refresh in a moment.", "info");
}

async function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }

  // Status first
  try {
    const status = await api.premiumStatus();
    if (status.active) {
      await showActive(status.expires_at);
    }
  } catch {}

  // Plans
  try {
    const data = await api.premiumPlans();
    renderPlans(data.plans);
  } catch (err) {
    showMsg(err.message, "error");
  }

  await checkCallback();
}

boot();
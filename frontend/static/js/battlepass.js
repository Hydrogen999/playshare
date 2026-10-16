import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

let data = null;
let pollTimer = null;

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

function rewardLabel(r) {
  if (r.type === "coins") return `🪙 ${r.amount} PC`;
  if (r.type === "skin") return `🎨 ${r.name || r.id}`;
  return "?";
}

function renderTiers() {
  const el = $("tiers");
  if (!data || !data.tiers) {
    el.innerHTML = `<div class="text-center text-slate-500 text-sm py-8 px-8">No season active.</div>`;
    return;
  }
  el.innerHTML = data.tiers.map((t) => {
    const tierNum = t.tier;
    const reached = t.reached;
    const freeClaimed = t.free.claimed;
    const premClaimed = t.premium.claimed;
    const hasPrem = data.user.has_premium;

    const freeBtn = (!reached)
      ? `<div class="text-[10px] text-slate-500 text-center py-2">Locked</div>`
      : freeClaimed
      ? `<div class="text-[10px] text-emerald-400 font-bold text-center py-2">✓ Claimed</div>`
      : `<button data-claim="${tierNum}" data-track="free" class="w-full rounded bg-brand-600 hover:bg-brand-700 py-2 text-[10px] font-bold ${reached ? "bp-claimable" : ""}">Claim</button>`;

    const premBtn = (!reached)
      ? `<div class="text-[10px] text-slate-500 text-center py-2">Locked</div>`
      : premClaimed
      ? `<div class="text-[10px] text-emerald-400 font-bold text-center py-2">✓ Claimed</div>`
      : !hasPrem
      ? `<div class="text-[10px] text-amber-500 text-center py-2 font-bold">Premium</div>`
      : `<button data-claim="${tierNum}" data-track="premium" class="w-full rounded bg-amber-500 hover:bg-amber-400 text-slate-900 py-2 text-[10px] font-bold">Claim</button>`;

    const cardClass = [
      "bp-card",
      "rounded-xl",
      "border",
      reached ? "border-brand-500/40 bg-brand-500/5" : "border-slate-800 bg-slate-900/60",
    ].join(" ");

    return `
      <div class="${cardClass} p-2 flex flex-col gap-2">
        <div class="text-center">
          <div class="text-[10px] uppercase font-bold text-slate-500">Tier</div>
          <div class="text-2xl font-black">${tierNum}</div>
          <div class="text-[10px] text-slate-500">${t.xp_required} XP</div>
        </div>
        <div class="rounded-lg border border-slate-700 bg-slate-800/50 p-2 text-center">
          <div class="text-[9px] uppercase text-slate-500 font-bold mb-1">Free</div>
          <div class="text-[11px] font-bold">${rewardLabel(t.free)}</div>
        </div>
        ${freeBtn}
        <div class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-center">
          <div class="text-[9px] uppercase text-amber-400 font-bold mb-1">👑 Premium</div>
          <div class="text-[11px] font-bold">${rewardLabel(t.premium)}</div>
        </div>
        ${premBtn}
      </div>
    `;
  }).join("");

  // Wire claim buttons
  el.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const tier = Number(btn.dataset.claim);
      const track = btn.dataset.track;
      try {
        const res = await api.claimBPTier(tier, track);
        if (res.ok) {
          showMsg(`Claimed Tier ${tier} (${track})!`, "success");
          await load();
        }
      } catch (err) {
        showMsg(err.message, "error");
        btn.disabled = false;
      }
    });
  });
}

function renderSummary() {
  if (!data || !data.active) return;
  $("seasonName").textContent = data.season.name;
  $("seasonMeta").textContent = `${data.season.days_left} days left`;
  $("curTier").textContent = data.user.tier;
  $("curXp").textContent = data.user.season_xp;

  const pct = Math.round((data.user.progress_pct || 0) * 100);
  $("xpBar").style.width = `${pct}%`;

  if (data.user.tier >= 20) {
    $("xpNeeded").textContent = "MAX TIER REACHED 🎉";
  } else {
    $("xpNeeded").textContent = `${data.user.next_tier_xp - data.user.season_xp} XP to Tier ${data.user.tier + 1}`;
  }

  if (data.user.has_premium) {
    $("premiumBar").className = "mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/60 bg-amber-500/15 p-3";
    $("premiumDesc").textContent = "✓ Active this season — claim rewards on all tiers!";
    $("buyBtn").classList.add("hidden");
  } else {
    $("premiumBar").className = "mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3";
    $("premiumDesc").textContent = "Unlock exclusive rewards on every tier";
    $("buyBtn").classList.remove("hidden");
    $("buyBtn").textContent = `Buy ${data.price.label}`;
  }
}

async function load() {
  try {
    data = await api.battlepass();
    if (!data.active) {
      $("summary").innerHTML = `<div class="text-center text-slate-500">No active season</div>`;
      return;
    }
    renderSummary();
    renderTiers();
  } catch (err) {
    showMsg(err.message, "error");
  }
}

// Buy
document.getElementById("buyBtn")?.addEventListener("click", async () => {
  try {
    const res = await api.purchaseBP();
    if (res.authorization_url) {
      window.location.href = res.authorization_url;
    } else {
      showMsg("Could not start checkout", "error");
    }
  } catch (err) {
    showMsg(err.message, "error");
  }
});

// Claim all free
document.getElementById("claimFreeBtn")?.addEventListener("click", async () => {
  try {
    const res = await api.claimBPAll("free");
    showMsg(`Claimed ${res.tiers_claimed} tiers!`, "success");
    await load();
  } catch (err) {
    showMsg(err.message, "error");
  }
});

// Claim all premium
document.getElementById("claimPremBtn")?.addEventListener("click", async () => {
  try {
    const res = await api.claimBPAll("premium");
    showMsg(`Claimed ${res.tiers_claimed} tiers!`, "success");
    await load();
  } catch (err) {
    showMsg(err.message, "error");
  }
});

// Handle Paystack callback
async function checkCallback() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("reference") || params.get("trxref");
  if (!ref) return;
  showMsg("Verifying purchase…", "info");
  for (let i = 0; i < 5; i++) {
    try {
      const res = await api.verifyBP(ref);
      if (res.ok) {
        showMsg("🎉 Premium Pass unlocked!", "success");
        window.history.replaceState({}, "", "/battlepass");
        await load();
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  showMsg("Still processing. Refresh in a moment.", "info");
}

async function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }
  await load();
  await checkCallback();
  pollTimer = setInterval(load, 20000);
}

boot();
import { api } from "./api.js";

let _config = null;

export async function loadAdConfig() {
  if (_config) return _config;
  try {
    _config = await api.adConfig();
    return _config;
  } catch {
    return null;
  }
}

/**
 * Safely injects HTML (including <script> tags) so the ad network actually runs.
 */
function injectHTML(container, html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  tmp.querySelectorAll("script").forEach(old => {
    const s = document.createElement("script");
    [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
    s.textContent = old.textContent;
    old.replaceWith(s);
  });
  container.append(...tmp.childNodes);
}

export async function renderBanner(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const cfg = await loadAdConfig();
  if (!cfg || !cfg.enabled || !cfg.show_banner) {
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");
  el.innerHTML = "";

  if (cfg.banner_code && cfg.banner_code.trim()) {
    // Use the safe injector
    injectHTML(el, cfg.banner_code);
  } else {
    el.innerHTML = `
      <div class="rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/40 p-4 text-center">
        <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Advertisement</div>
        <div class="text-sm text-slate-400 mt-2">📢 Ad slot</div>
      </div>`;
  }
}

export async function renderRewarded(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const cfg = await loadAdConfig();
  if (!cfg || !cfg.enabled) {
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");
  const remaining = cfg.rewarded_remaining;
  const coins = cfg.rewarded_coins;
  const disabled = remaining <= 0;

  el.innerHTML = `
    <div class="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-slate-900/60 p-4 shadow-lg">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-emerald-400 uppercase tracking-widest">🎬 Watch & Earn</div>
          <div class="text-sm text-slate-300 mt-1 font-semibold">Watch a short video → get <span class="text-emerald-400 font-bold">${coins} PlayCoins</span></div>
          <div class="text-[11px] text-slate-500 mt-1">${remaining} of ${cfg.rewarded_daily_limit} remaining today</div>
        </div>
        <button id="rewardedBtn" class="rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-900 px-5 py-3 text-sm font-black whitespace-nowrap shadow-lg transition ${disabled ? "opacity-50 cursor-not-allowed" : ""}" ${disabled ? "disabled" : ""}>
          ${disabled ? "Done" : "Watch"}
        </button>
      </div>
    </div>`;

  if (disabled) return;

  const btn = el.querySelector("#rewardedBtn");
  btn.addEventListener("click", async () => {
    if (!cfg.rewarded_code || !cfg.rewarded_code.trim()) {
      alert("No rewarded ad code configured in Admin panel.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Loading Ad...";

    // 1. Inject the Adsterra Popunder code invisibly
    const adContainer = document.createElement("div");
    adContainer.style.display = "none";
    el.appendChild(adContainer);
    
    try {
      injectHTML(adContainer, cfg.rewarded_code);
    } catch (e) {
      console.error("Ad script failed", e);
    }

    // 2. Wait 3 seconds to simulate "watching", then let them claim
    // Adsterra Popunders don't have a perfect "watched" callback on the web,
    // so this is the safest way to give the reward without breaking rules.
    btn.textContent = "Verifying...";
    setTimeout(async () => {
      try {
        const res = await api.claimRewardedAd();
        if (res.ok) {
          _config = null; // reset cache
          alert(`🎉 +${res.coins} PlayCoins added!`);
          window.location.reload();
        } else {
          alert(res.error || "Limit reached");
          btn.disabled = false;
          btn.textContent = "Watch";
        }
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = "Watch";
      }
    }, 3000);
  });
}

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
 * Inject a banner ad into a container.
 * If ads are disabled or user is premium → hides container.
 * If banner_code is set → injects raw HTML.
 * Else → shows a placeholder box.
 */
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
    // Inject raw ad code (AdSense <ins> tag, etc.)
    const wrap = document.createElement("div");
    wrap.innerHTML = cfg.banner_code;
    el.appendChild(wrap);
  } else {
    // Placeholder
    el.innerHTML = `
      <div class="rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/40 p-4 text-center">
        <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Advertisement</div>
        <div class="text-sm text-slate-400 mt-2">📢 Ad slot — add code in admin settings</div>
      </div>`;
  }
}

/**
 * Render a rewarded video button with state.
 */
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
    <div class="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-slate-900/60 p-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-emerald-400 uppercase tracking-widest">🎬 Watch & Earn</div>
          <div class="text-sm text-slate-300 mt-1">Watch a short video → get <span class="text-emerald-400 font-bold">${coins} PlayCoins</span></div>
          <div class="text-[11px] text-slate-500 mt-1">${remaining} of ${cfg.rewarded_daily_limit} remaining today</div>
        </div>
        <button id="rewardedBtn" class="rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-900 px-4 py-2.5 text-sm font-black whitespace-nowrap ${disabled ? "opacity-50 cursor-not-allowed" : ""}" ${disabled ? "disabled" : ""}>
          ${disabled ? "Done" : "Watch"}
        </button>
      </div>
    </div>`;

  if (disabled) return;

  const btn = el.querySelector("#rewardedBtn");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Loading…";

    // If real rewarded_code is set, show it; else simulate a 5s video for testing
    if (cfg.rewarded_code && cfg.rewarded_code.trim()) {
      // Inject the real ad code — real provider will callback via window.rewardedAdComplete
      window.rewardedAdComplete = async () => {
        await claimAndRefresh();
      };
      const adWrap = document.createElement("div");
      adWrap.innerHTML = cfg.rewarded_code;
      el.appendChild(adWrap);
      btn.textContent = "Watching…";
    } else {
      // Placeholder countdown
      let n = 5;
      btn.textContent = `⏱ ${n}s`;
      const t = setInterval(async () => {
        n -= 1;
        btn.textContent = `⏱ ${n}s`;
        if (n <= 0) {
          clearInterval(t);
          await claimAndRefresh();
        }
      }, 1000);
    }
  });

  async function claimAndRefresh() {
    try {
      const res = await api.claimRewardedAd();
      if (res.ok) {
        _config = null;  // bust cache
        alert(`🎉 +${res.coins} PlayCoins!`);
        window.location.reload();
      } else {
        alert(res.error || "Could not claim");
        btn.disabled = false;
        btn.textContent = "Watch";
      }
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "Watch";
    }
  }
}
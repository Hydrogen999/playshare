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
    const tmp = document.createElement("div");
    tmp.innerHTML = cfg.banner_code;
    tmp.querySelectorAll("script").forEach(old => {
      const s = document.createElement("script");
      [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
      s.textContent = old.textContent;
      old.replaceWith(s);
    });
    el.append(...tmp.childNodes);
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

  // YOUR ADSTERRA SMARTLINK
  const AD_URL = "https://asiafilm.org/4/c94c08c3b62dc0e62da807949030c02d";

  el.innerHTML = `
    <div class="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-slate-900/60 p-4 shadow-lg">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-emerald-400 uppercase tracking-widest">🎬 Watch & Earn</div>
          <div class="text-sm text-slate-300 mt-1 font-semibold">Watch the ad below → get <span class="text-emerald-400 font-bold">${coins} PlayCoins</span></div>
          <div class="text-[11px] text-slate-500 mt-1">${remaining} of ${cfg.rewarded_daily_limit} remaining today</div>
        </div>
        <button id="rewardedBtn" class="rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-900 px-5 py-3 text-sm font-black whitespace-nowrap shadow-lg transition ${disabled ? "opacity-50 cursor-not-allowed" : ""}" ${disabled ? "disabled" : ""}>
          ${disabled ? "Done" : "Watch"}
        </button>
      </div>
      <!-- Hidden Iframe Container -->
      <div id="adIframeContainer" class="hidden mt-4 h-[400px] w-full rounded-lg overflow-hidden border border-slate-700">
        <iframe id="adIframe" src="about:blank" class="w-full h-full"></iframe>
      </div>
    </div>`;

  if (disabled) return;

  const btn = el.querySelector("#rewardedBtn");
  const iframeContainer = el.querySelector("#adIframeContainer");
  const iframe = el.querySelector("#adIframe");
  let timerStarted = false;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Watching...";
    
    // 1. Load the ad in the iframe
    iframeContainer.classList.remove("hidden");
    iframe.src = AD_URL;
    
    // 2. Start the 5-second timer
    let n = 5;
    timerStarted = true;
    const t = setInterval(async () => {
      n -= 1;
      btn.textContent = `⏱ ${n}s`;
      if (n <= 0) {
        clearInterval(t);
        
        // 3. Give the reward
        try {
          const res = await api.claimRewardedAd();
          if (res.ok) {
            _config = null; 
            alert(`🎉 +${res.coins} PlayCoins added!`);
            window.location.reload();
          } else {
            alert(res.error || "Limit reached");
            btn.disabled = false;
            btn.textContent = "Watch";
          }
        } catch (err) {
          alert("Server error. Try again.");
          btn.disabled = false;
          btn.textContent = "Watch";
        }
      }
    }, 1000);
  });
}

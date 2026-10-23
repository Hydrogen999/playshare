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
    injectHTML(el, cfg.banner_code);
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
          <div class="text-sm text-slate-300 mt-1 font-semibold">Watch a sponsor → get <span class="text-emerald-400 font-bold">${coins} PlayCoins</span></div>
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
    btn.disabled = true;
    btn.textContent = "Loading...";

    // 1. Inject the Popunder code (opens safe ad in background)
    if (cfg.rewarded_code && cfg.rewarded_code.trim()) {
      const adDiv = document.createElement("div");
      adDiv.style.display = "none";
      adDiv.innerHTML = cfg.rewarded_code;
      el.appendChild(adDiv);
      injectHTML(adDiv, cfg.rewarded_code); 
    }

    // 2. Wait 5 seconds, then give the coins
    let n = 5;
    btn.textContent = `⏱ ${n}s`;
    const t = setInterval(async () => {
      n -= 1;
      btn.textContent = `⏱ ${n}s`;
      if (n <= 0) {
        clearInterval(t);
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
          alert("Error");
          btn.disabled = false;
          btn.textContent = "Watch";
        }
      }
    }, 1000);
  });
}

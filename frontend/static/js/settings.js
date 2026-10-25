import { api } from "./api.js";
import { permissionStatus, requestPermission, setPushPrefs } from "./notifications.js";
import { isSoundEnabled, setSoundEnabled, sfx } from "./sounds.js";

const $ = (id) => document.getElementById(id);
let isPremium = false;

function showMsg(text, type = "success") {
  const el = $("msg");
  el.className = `mb-4 rounded-lg p-3 text-sm border ${type === "success" ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-400" : "bg-red-500/10 border-red-500/40 text-red-400"}`;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

function renderPermission() {
  const status = permissionStatus();
  const banner = $("permBanner");
  const text = $("permText");
  const btn = $("permBtn");

  if (status === "granted") {
    banner.className = "rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 mb-4 flex items-center justify-between gap-3";
    text.textContent = "✓ Browser notifications are enabled";
    btn.classList.add("hidden");
  } else if (status === "denied") {
    banner.className = "rounded-xl border border-red-500/40 bg-red-500/10 p-3 mb-4 flex items-center justify-between gap-3";
    text.textContent = "❌ Notifications blocked — enable in browser settings";
    btn.classList.add("hidden");
  } else if (status === "unsupported") {
    banner.className = "rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 mb-4 flex items-center justify-between gap-3";
    text.textContent = "⚠️ Your browser doesn't support notifications";
    btn.classList.add("hidden");
  } else {
    banner.className = "rounded-xl border border-brand-500/40 bg-brand-500/10 p-3 mb-4 flex items-center justify-between gap-3";
    text.textContent = "🔔 Enable browser notifications to get alerts";
    btn.classList.remove("hidden");
  }
}

async function loadSettings() {
  try {
    const s = await api.pushSettings();
    $("enabled").checked = s.enabled;
    $("on_challenge").checked = s.on_challenge;
    $("on_dm").checked = s.on_dm;
    $("on_friend").checked = s.on_friend;
    $("on_tournament").checked = s.on_tournament;
    $("on_achievement").checked = s.on_achievement;

    setPushPrefs({
      enabled: s.enabled, on_challenge: s.on_challenge, on_dm: s.on_dm,
      on_friend: s.on_friend, on_tournament: s.on_tournament, on_achievement: s.on_achievement,
    });

    // Load Premium Chat Settings
    const me = await api.me();
    isPremium = me.profile.is_premium || false;
    
    const retention = me.profile.chat_retention_days || 1;
    $("chatRetention").value = String(retention);

    if (!isPremium) {
      $("chatRetention").disabled = true;
      $("chatRetention").classList.add("opacity-50", "cursor-not-allowed");
      $("premiumNote").classList.remove("hidden");
    }

  } catch (err) {
    showMsg(err.message, "error");
  }
}

$("permBtn").addEventListener("click", async () => {
  const r = await requestPermission();
  if (r === "granted") {
    renderPermission();
    try { new Notification("PlaySphere", { body: "🎉 Notifications enabled!" }); } catch {}
  } else {
    renderPermission();
  }
});

$("saveBtn").addEventListener("click", async () => {
  const payload = {
    enabled: $("enabled").checked,
    on_challenge: $("on_challenge").checked,
    on_dm: $("on_dm").checked,
    on_friend: $("on_friend").checked,
    on_tournament: $("on_tournament").checked,
    on_achievement: $("on_achievement").checked,
  };
  
  if (isPremium) {
    payload.chat_retention_days = parseInt($("chatRetention").value, 10);
  }

  try {
    await api.updatePushSettings(payload);
    if (isPremium) {
      await api.updateProfile({ chat_retention_days: payload.chat_retention_days });
    }
    setPushPrefs(payload);
    showMsg("Saved! ✓");
  } catch (err) {
    showMsg(err.message, "error");
  }
});

$("logoutBtn").addEventListener("click", () => {
  api.clearToken();
  window.location.href = "/";
});

async function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }
  renderPermission();
  await loadSettings();
  initSoundToggle();
}

function initSoundToggle() {
  const el = document.getElementById("soundEnabled");
  if (!el) return;
  el.checked = isSoundEnabled();
  el.addEventListener("change", () => {
    setSoundEnabled(el.checked);
    if (el.checked) { try { sfx.success(); } catch {} }
  });
}

boot();

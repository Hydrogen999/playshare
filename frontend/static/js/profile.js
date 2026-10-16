import { api } from "./api.js";
import { AVATARS, avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let currentAvatarId = null;

function showMsg(text, type = "error") {
  const el = $("msg");
  if (!text) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.className = "text-sm " + (type === "error" ? "text-red-400" : "text-emerald-400");
  el.textContent = text;
}

function renderAvatarPreview(id) {
  $("avatarPreview").innerHTML = avatarHTML(id, "xl");
}

function renderAvatarGrid(selectedId) {
  const grid = $("avatarGrid");
  grid.innerHTML = "";
  AVATARS.forEach((a) => {
    const isSel = a.id === selectedId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.id = a.id;
    btn.className =
      "relative rounded-xl p-2 flex flex-col items-center gap-1 border transition " +
      (isSel
        ? "border-brand-500 bg-brand-500/10"
        : "border-slate-800 bg-slate-800/40 hover:border-slate-700");
    btn.innerHTML = `
      <div style="background:${a.bg}" class="h-10 w-10 rounded-full grid place-items-center text-xl">${a.emoji}</div>
      <span class="text-[10px] text-slate-400">${a.name}</span>
    `;
    btn.addEventListener("click", () => {
      currentAvatarId = a.id;
      renderAvatarPreview(a.id);
      renderAvatarGrid(a.id);
    });
    grid.appendChild(btn);
  });
}

async function load() {
  if (!api.getToken()) {
    window.location.href = "/";
    return;
  }
  try {
    const me = await api.me();
    $("username").textContent = me.username;
    currentAvatarId = me.profile.avatar_id;
    const form = $("profileForm");
    form.bio.value = me.profile.bio || "";
    form.country.value = me.profile.country || "";
    renderAvatarPreview(currentAvatarId);
    renderAvatarGrid(currentAvatarId);
  } catch {
    api.clearToken();
    window.location.href = "/";
  }
}

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = $("profileForm");
  try {
    showMsg("Saving...", "success");
    await api.updateProfile({
      bio: form.bio.value,
      country: form.country.value,
      avatar_id: currentAvatarId,
    });
    showMsg("Saved ✓", "success");
  } catch (err) {
    showMsg(err.message);
  }
});

load();
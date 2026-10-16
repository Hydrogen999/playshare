import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const WORLD_W = 1600;
const WORLD_H = 900;
const SPEED = 340;
const SEND_INTERVAL = 33;
const MOVE_THRESHOLD = 2;

const worldEl = document.getElementById("world");
const onlineCountEl = document.getElementById("onlineCount");
const mySmallEl = document.getElementById("myAvatarSmall");
const popup = document.getElementById("popup");
const popupAvatar = document.getElementById("popupAvatar");
const popupName = document.getElementById("popupName");
const popupLevel = document.getElementById("popupLevel");
const challengeBtn = document.getElementById("challengeBtn");
const messageBtn = document.getElementById("messageBtn");
const challengeModal = document.getElementById("challengeModal");
const challengerAvatar = document.getElementById("challengerAvatar");
const challengerName = document.getElementById("challengerName");
const acceptBtn = document.getElementById("acceptChallenge");
const declineBtn = document.getElementById("declineChallenge");
const toast = document.getElementById("toast");

let ws = null;
let myId = null;
let myX = WORLD_W / 2;
let myY = WORLD_H / 2;
let me = null;
let meEl = null;
const others = new Map();
const keys = new Set();
let lastFrame = performance.now();
let lastSend = 0;
let lastSentX = 0;
let lastSentY = 0;
let selectedPlayer = null;
let currentChallengeId = null;

// ---- Touch joystick state ----
let touchActive = false;
let touchId = null;
let touchStart = null;
let touchCurrent = null;
let touchStartTime = 0;
let joystickEl = null;
const TOUCH_DEAD_ZONE = 12;       // px — below this, treat as a tap
const TAP_MAX_DURATION = 300;     // ms — if finger up quickly, it's a tap
const TAP_MAX_MOVE = 15;          // px — if moved less than this, it's a tap

function pct(v, total) { return (v / total) * 100 + "%"; }

function showToast(text, ms = 2500) {
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), ms);
}

function makeAvatarEl(player, isMe) {
  const node = document.createElement("div");
  node.className = "avatar-node" + (isMe ? " me" : "");
  node.dataset.id = player.id;
  const ring = isMe ? "outline outline-2 outline-brand-500 outline-offset-2 rounded-full" : "";
    const crown = player.is_premium ? " 👑" : "";
  node.innerHTML = `
    <div class="${ring}">${avatarHTML(player.avatar_id, "md", player.frame_color, player.is_premium)}</div>
    <div class="label">${player.username}${crown}${isMe ? " (you)" : ""}</div>
  `;
  node.style.left = pct(player.x, WORLD_W);
  node.style.top = pct(player.y, WORLD_H);
  return node;
}

function addPlayer(player, isMe) {
  if (others.has(player.id) || (isMe && meEl)) return;
  const node = makeAvatarEl(player, isMe);
  if (isMe) {
    meEl = node;
  } else {
    // Store data on element for click delegation
        node.dataset.playerJson = JSON.stringify({
      id: player.id,
      username: player.username,
      avatar_id: player.avatar_id,
      level: player.level || 1,
      frame_color: player.frame_color || null,
      is_premium: player.is_premium || false,
    });
        others.set(player.id, {
      x: player.x, y: player.y, el: node,
      username: player.username, avatar_id: player.avatar_id,
      level: player.level || 1,
      frame_color: player.frame_color || null,
      is_premium: player.is_premium || false,
    });
  }
  worldEl.appendChild(node);
  updateOnlineCount();
}

function moveOther(id, x, y) {
  const o = others.get(id);
  if (!o) return;
  o.x = x; o.y = y;
  o.el.style.left = pct(x, WORLD_W);
  o.el.style.top = pct(y, WORLD_H);
}

function removePlayer(id) {
  const o = others.get(id);
  if (!o) return;
  o.el.remove();
  others.delete(id);
  updateOnlineCount();
}

function updateOnlineCount() {
  const n = others.size + (meEl ? 1 : 0);
  onlineCountEl.textContent = `● ${n} online`;
}

function openPopup(player) {
  selectedPlayer = player;
  popupAvatar.innerHTML = avatarHTML(player.avatar_id, "lg", player.frame_color, player.is_premium);
  popupName.innerHTML = `${player.username}${player.is_premium ? ' <span class="text-amber-400">👑</span>' : ''}`;
  popupLevel.textContent = `Level ${player.level || 1}`;
  messageBtn.href = `/friends?chat=${player.id}`;
  popup.classList.remove("hidden");
  popup.classList.add("flex");
}

function closePopup() {
  popup.classList.add("hidden");
  popup.classList.remove("flex");
  selectedPlayer = null;
}

document.getElementById("popupClose").addEventListener("click", closePopup);

challengeBtn.addEventListener("click", () => {
  if (!selectedPlayer) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Not connected");
    return;
  }
  ws.send(JSON.stringify({ type: "challenge:send", target_id: selectedPlayer.id }));
  showToast(`Challenge sent to ${selectedPlayer.username}`);
  closePopup();
});

function showChallengeModal(from) {
  currentChallengeId = from.challenge_id;
    challengerAvatar.innerHTML = avatarHTML(from.avatar_id, "lg", from.frame_color, from.is_premium);
  challengerName.innerHTML = `${from.username}${from.is_premium ? ' <span class="text-amber-400">👑</span>' : ''}`;
  challengeModal.classList.remove("hidden");
  challengeModal.classList.add("flex");
}

function hideChallengeModal() {
  challengeModal.classList.add("hidden");
  challengeModal.classList.remove("flex");
  currentChallengeId = null;
}

acceptBtn.addEventListener("click", () => {
  if (!currentChallengeId || !ws) return;
  ws.send(JSON.stringify({
    type: "challenge:respond",
    challenge_id: currentChallengeId,
    accept: true,
  }));
  hideChallengeModal();
});

declineBtn.addEventListener("click", () => {
  if (!currentChallengeId || !ws) return;
  ws.send(JSON.stringify({
    type: "challenge:respond",
    challenge_id: currentChallengeId,
    accept: false,
  }));
  hideChallengeModal();
});

// ---------- Keyboard ----------
const MOVE_KEYS = new Set(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright"]);
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.has(k)) { keys.add(k); e.preventDefault(); }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());

// ---------- Touch joystick (mobile) ----------
function ensureJoystick() {
  if (joystickEl) return joystickEl;
  joystickEl = document.createElement("div");
  joystickEl.style.cssText = `
    position: fixed; z-index: 60; pointer-events: none;
    width: 90px; height: 90px; border-radius: 50%;
    background: rgba(124,58,237,0.15);
    border: 2px solid rgba(124,58,237,0.5);
    transition: opacity 0.15s;
    opacity: 0;
  `;
  const knob = document.createElement("div");
  knob.style.cssText = `
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 40px; height: 40px; border-radius: 50%;
    background: rgba(124,58,237,0.7);
    box-shadow: 0 0 12px rgba(124,58,237,0.7);
  `;
  joystickEl.appendChild(knob);
  document.body.appendChild(joystickEl);
  joystickEl._knob = knob;
  return joystickEl;
}

// Detect an avatar tap via event delegation on touchstart
function getAvatarFromEvent(e) {
  const target = e.target.closest(".avatar-node");
  if (!target || target === meEl) return null;
  if (!target.dataset.playerJson) return null;
  try {
    return JSON.parse(target.dataset.playerJson);
  } catch {
    return null;
  }
}

worldEl.addEventListener("touchstart", (e) => {
  // If the user tapped an avatar → open popup IMMEDIATELY and don't start joystick
  const avatarData = getAvatarFromEvent(e);
  if (avatarData) {
    e.preventDefault();
    openPopup(avatarData);
    return;
  }

  // If they tapped something else interactive (button, link) → ignore
  if (e.target.closest("button") || e.target.closest("a")) return;

  const t = e.changedTouches[0];
  touchId = t.identifier;
  touchActive = true;
  touchStart = { x: t.clientX, y: t.clientY };
  touchCurrent = { x: t.clientX, y: t.clientY };
  touchStartTime = Date.now();

  const j = ensureJoystick();
  j.style.left = (t.clientX - 45) + "px";
  j.style.top = (t.clientY - 45) + "px";
  j.style.opacity = "0";  // Hide initially — only show if the user actually drags
  j._knob.style.transform = "translate(-50%, -50%)";

  e.preventDefault();
}, { passive: false });

worldEl.addEventListener("touchmove", (e) => {
  if (!touchActive) return;
  // Find the touch that started the joystick
  let t = null;
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === touchId) {
      t = e.changedTouches[i];
      break;
    }
  }
  if (!t) return;

  touchCurrent = { x: t.clientX, y: t.clientY };
  const dx = touchCurrent.x - touchStart.x;
  const dy = touchCurrent.y - touchStart.y;
  const dist = Math.hypot(dx, dy);

  // Only show the joystick once the user actually drags past the dead zone
  if (dist > TOUCH_DEAD_ZONE) {
    if (joystickEl) joystickEl.style.opacity = "1";
    const maxDist = 45;
    const scale = Math.min(dist, maxDist) / (dist || 1);
    if (joystickEl && joystickEl._knob) {
      joystickEl._knob.style.transform =
        `translate(calc(-50% + ${dx * scale}px), calc(-50% + ${dy * scale}px))`;
    }
  }

  e.preventDefault();
}, { passive: false });

function endTouch(e) {
  if (!touchActive) return;

  const duration = Date.now() - touchStartTime;
  const dist = touchStart && touchCurrent
    ? Math.hypot(touchCurrent.x - touchStart.x, touchCurrent.y - touchStart.y)
    : 0;

  // If it was a quick tap with minimal movement, treat as a tap (no move)
  // The popup logic already handled avatar taps in touchstart, so if we're
  // here it was a tap on empty space — do nothing.

  touchActive = false;
  touchId = null;
  touchStart = null;
  touchCurrent = null;
  if (joystickEl) joystickEl.style.opacity = "0";
}

worldEl.addEventListener("touchend", (e) => { endTouch(e); }, { passive: true });
worldEl.addEventListener("touchcancel", endTouch);

// Prevent the browser's native 300ms click delay on mobile
worldEl.addEventListener("click", (e) => {
  // On desktop this is the normal click-to-interact
  const target = e.target.closest(".avatar-node");
  if (target && target !== meEl && target.dataset.playerJson) {
    e.stopPropagation();
    try {
      openPopup(JSON.parse(target.dataset.playerJson));
    } catch {}
  }
});

// ---------- Game loop ----------
function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  let dx = 0, dy = 0;

  if (keys.has("w") || keys.has("arrowup")) dy -= 1;
  if (keys.has("s") || keys.has("arrowdown")) dy += 1;
  if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
  if (keys.has("d") || keys.has("arrowright")) dx += 1;

  if (touchActive && touchStart && touchCurrent) {
    const tdx = touchCurrent.x - touchStart.x;
    const tdy = touchCurrent.y - touchStart.y;
    const dist = Math.hypot(tdx, tdy);
    if (dist > TOUCH_DEAD_ZONE) {
      const nx = tdx / dist;
      const ny = tdy / dist;
      const mag = Math.min((dist - TOUCH_DEAD_ZONE) / 50, 1);
      dx += nx * mag;
      dy += ny * mag;
    }
  }

  if (dx || dy) {
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    myX = Math.max(60, Math.min(WORLD_W - 60, myX + dx * SPEED * dt));
    myY = Math.max(60, Math.min(WORLD_H - 60, myY + dy * SPEED * dt));
    if (meEl) {
      meEl.style.left = pct(myX, WORLD_W);
      meEl.style.top = pct(myY, WORLD_H);
    }
    maybeSendMove(now);
  }
  requestAnimationFrame(tick);
}

function maybeSendMove(now) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const moved = Math.hypot(myX - lastSentX, myY - lastSentY);
  if (moved < MOVE_THRESHOLD) return;
  if (now - lastSend < SEND_INTERVAL) return;
  lastSend = now;
  lastSentX = myX;
  lastSentY = myY;
  ws.send(JSON.stringify({ type: "lobby:move", x: myX, y: myY }));
}

// ---------- Boot ----------
async function boot() {
  const token = api.getToken();
  if (!token) { window.location.href = "/"; return; }

  try {
    me = await api.me();
  } catch {
    api.clearToken();
    window.location.href = "/";
    return;
  }

  mySmallEl.innerHTML = avatarHTML(me.profile.avatar_id, "sm", me.profile.frame_color);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/lobby?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    onlineCountEl.textContent = "● connected";
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case "lobby:init": {
        myId = msg.you;
        const mePlayer = msg.players.find((p) => p.id === myId);
        if (mePlayer) { myX = mePlayer.x; myY = mePlayer.y; }
        for (const p of msg.players) addPlayer(p, p.id === myId);
        lastSentX = myX;
        lastSentY = myY;
        break;
      }
      case "lobby:player_joined": addPlayer(msg.player, false); break;
      case "lobby:player_moved": moveOther(msg.id, msg.x, msg.y); break;
      case "lobby:player_left": removePlayer(msg.id); break;

      case "challenge:incoming":
        showChallengeModal({ challenge_id: msg.challenge_id, ...msg.from });
        break;
      case "challenge:accepted":
        showToast("Challenge accepted! Entering room…");
        setTimeout(() => { window.location.href = `/room?id=${msg.room_id}`; }, 600);
        break;
      case "challenge:declined": showToast("Challenge was declined"); break;
      case "challenge:error": showToast(msg.error || "Challenge error"); break;
    }
  });

  ws.addEventListener("close", () => {
    onlineCountEl.textContent = "● disconnected";
    setTimeout(boot, 2000);
  });

  requestAnimationFrame(tick);
}

boot();
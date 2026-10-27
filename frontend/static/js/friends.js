import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null, myId = null, activeTab = "friends", activeChatUserId = null;
let friends = [], requests = [], conversations = [], searchResults = [], statuses = [];
let pollTimer = null;
let dmSocket = null;
let reconnectTimeout = null;

// --- WebRTC Variables ---
let pc = null;
let localStream = null;
let remoteStream = null;
let currentCallTargetId = null;
let callTimeout = null;
let isVideoCall = false;
let currentFacingMode = "user";
const STUN_SERVER = "stun:stun.l.google.com:19302";

// --- Call Timer & Ringtone ---
let callTimerInterval = null;
let callSeconds = 0;
let ringtoneCtx = null;
let ringtoneInterval = null;

// --- Typing Timeout ---
let typingTimeout = null;

// ---------------------------------------------------------
// 1. WEBSOCKET CONNECTION
// ---------------------------------------------------------
function connectDMSocket() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  const token = api.getToken();
  if (!token) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/dm?token=${encodeURIComponent(token)}`;

  if (dmSocket) {
    dmSocket.onclose = null;
    dmSocket.close();
  }

  dmSocket = new WebSocket(url);

  dmSocket.addEventListener("open", () => {
    console.log("[DM WS] Connected");
    if (activeChatUserId) {
      dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
    }
  });

  dmSocket.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "dm:new") {
      if (activeChatUserId === msg.sender_id || activeChatUserId === msg.recipient_id) {
        addMessageToUI(msg);
        if (msg.recipient_id === myId) {
          dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: msg.sender_id }));
        }
      }
      refreshAll();
    } 
    else if (msg.type === "dm:typing") {
      if (activeChatUserId === msg.sender_id) {
        const indicator = $("typingIndicator");
        if (indicator) {
          indicator.textContent = msg.is_typing ? "typing..." : "";
          indicator.classList.toggle("hidden", !msg.is_typing);
        }
      }
    } 
    else if (msg.type === "dm:seen") {
      if (activeChatUserId === msg.reader_id) {
        document.querySelectorAll(".msg-status.mine").forEach(el => {
          el.textContent = "✓✓";
          el.classList.add("text-cyan-400");
        });
      }
    }
    else if (msg.type === "call:offer") showIncomingCall(msg.sender_id, msg.offer, msg.is_video);
    else if (msg.type === "call:answer") { 
        if (pc) {
            clearTimeout(callTimeout);
            pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        }
    }
    else if (msg.type === "call:ice-candidate") { if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
    else if (msg.type === "call:end") endCall();
  });

  dmSocket.addEventListener("close", () => {
    console.log("[DM WS] Disconnected. Reconnecting...");
    dmSocket = null;
    reconnectTimeout = setTimeout(connectDMSocket, 3000);
  });
}

// ---------------------------------------------------------
// 2. UI RENDERING
// ---------------------------------------------------------
function timeAgo(iso) {
  if (!iso) return "";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function crownMark(isPremium) { return isPremium ? ' <span class="text-amber-400 text-xs">👑</span>' : ""; }

function openChatPanel() { document.body.classList.add("chat-open"); }
function closeChatPanel() {
  document.body.classList.remove("chat-open");
  activeChatUserId = null;
  $("chatMessages").innerHTML = "";
  $("chatHeaderContent").innerHTML = `<div class="text-sm text-slate-400">Select a conversation</div>`;
  $("chatForm").classList.add("hidden");
  renderList();
}

$("mobileBack").addEventListener("click", closeChatPanel);

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.className = b.dataset.tab === activeTab ? "tab-btn flex-1 py-3 text-brand-400 border-b-2 border-brand-500" : "tab-btn flex-1 py-3 text-slate-400 hover:text-slate-200";
    });
    renderList();
  });
});

let searchTimeout = null;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (!q) { searchResults = []; renderList(); return; }
  searchTimeout = setTimeout(async () => {
    try { searchResults = await api.searchUsers(q); renderList(); } catch (err) { console.error(err); }
  }, 300);
});

function renderList() {
  const list = $("listArea");

  if (searchResults.length > 0 && $("searchInput").value.trim()) {
    list.innerHTML = searchResults.map((u) => {
      const rel = u.relationship;
      let action = "";
      if (rel === "self") action = `<span class="text-xs text-slate-500">You</span>`;
      else if (rel === "friends") action = `<button data-act="chat" data-id="${u.id}" data-username="${escapeHTML(u.username)}" data-avatar="${u.avatar_id}" data-premium="${u.is_premium ? '1' : '0'}" class="text-xs px-2.5 py-1.5 rounded bg-brand-600 hover:bg-brand-700">Message</button>`;
      else if (rel === "pending_out") action = `<span class="text-xs text-amber-400">Sent</span>`;
      else if (rel === "pending_in") action = `<button data-act="accept" data-id="${u.id}" class="text-xs px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700">Accept</button>`;
      else action = `<button data-act="add" data-id="${u.id}" class="text-xs px-2.5 py-1.5 rounded bg-brand-600 hover:bg-brand-700">+ Add</button>`;
      return `
        <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50">
          <div class="flex-shrink-0">${avatarHTML(u.avatar_id, "sm", u.frame_color, u.is_premium)}</div>
          <div class="flex-1 min-w-0"><div class="text-sm font-semibold truncate">${escapeHTML(u.username)}${crownMark(u.is_premium)}</div><div class="text-xs text-slate-500">Level ${u.level}</div></div>
          ${action}
        </div>`;
    }).join("");
    wireRowButtons(); return;
  }

  if (activeTab === "friends") {
    if (friends.length === 0) { list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No friends yet.</div>`; return; }
    list.innerHTML = friends.map((f) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50">
        <div class="flex-shrink-0 cursor-pointer" data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}">${avatarHTML(f.avatar_id, "sm", f.frame_color, f.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold truncate flex items-center gap-1">${escapeHTML(f.username)}${crownMark(f.is_premium)} ${f.streak_count > 0 ? `<span class="text-orange-500 font-bold text-[10px]">🔥 ${f.streak_count}</span>` : ""}</div>
          <div class="text-xs text-slate-500">Level ${f.level}</div>
        </div>
        <button data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}" class="text-xs px-2 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white font-bold transition">Chat</button>
      </div>`).join("");
    wireFriendRows(); return;
  }

  if (activeTab === "requests") {
    if (requests.length === 0) { list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No pending requests.</div>`; return; }
    list.innerHTML = requests.map((r) => `
      <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50">
        <div class="flex-shrink-0">${avatarHTML(r.avatar_id, "sm", r.frame_color, r.is_premium)}</div>
        <div class="flex-1 min-w-0"><div class="text-sm font-semibold truncate">${escapeHTML(r.username)}${crownMark(r.is_premium)}</div><div class="text-xs text-slate-500">Level ${r.level}</div></div>
        <div class="flex gap-1">
          <button data-act="accept" data-id="${r.user_id}" class="text-xs px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700">✓</button>
          <button data-act="decline" data-id="${r.user_id}" class="text-xs px-2.5 py-1.5 rounded bg-slate-700 hover:bg-slate-600">✕</button>
        </div>
      </div>`).join("");
    wireRowButtons(); return;
  }

  if (activeTab === "chats") {
    if (conversations.length === 0) { list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No conversations yet.</div>`; return; }
    list.innerHTML = conversations.map((c) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50 cursor-pointer" data-chat="${c.user_id}" data-username="${escapeHTML(c.username)}" data-avatar="${c.avatar_id}" data-premium="${c.is_premium ? '1' : '0'}">
        <div class="flex-shrink-0">${avatarHTML(c.avatar_id, "sm", c.frame_color, c.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <div class="text-sm font-semibold truncate flex items-center gap-1">${escapeHTML(c.username)}${crownMark(c.is_premium)} ${c.streak > 0 ? `<span class="text-orange-500 font-bold text-[10px]">🔥 ${c.streak}</span>` : ""}</div>
            <div class="text-[10px] text-slate-500">${timeAgo(c.last_at)}</div>
          </div>
          <div class="flex items-center justify-between mt-0.5">
            <div class="text-xs text-slate-500 truncate">${escapeHTML(c.last_message)}</div>
            ${c.unread_count > 0 ? `<span class="ml-2 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold">${c.unread_count}</span>` : ""}
          </div>
        </div>
      </div>`).join("");
    wireFriendRows(); return;
  }
}

function wireRowButtons() {
  document.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id, act = btn.dataset.act;
      try {
        if (act === "add") await api.sendFriendRequest(id);
        else if (act === "accept") await api.acceptFriend(id);
        else if (act === "decline") await api.declineFriend(id);
        else if (act === "chat") { openChat(id, btn.dataset.username, btn.dataset.avatar, btn.dataset.premium === "1"); return; }
        await refreshAll();
        const q = $("searchInput").value.trim();
        if (q) searchResults = await api.searchUsers(q);
        renderList();
      } catch (err) { alert(err.message); }
    });
  });
}

function wireFriendRows() {
  document.querySelectorAll("[data-chat]").forEach((row) => {
    row.addEventListener("click", () => openChat(row.dataset.chat, row.dataset.username, row.dataset.avatar, row.dataset.premium === "1"));
  });
}

// ---------------------------------------------------------
// 3. CHAT ROOM LOGIC
// ---------------------------------------------------------
async function openChat(userId, username, avatarId, isPremium) {
  activeChatUserId = userId;
  openChatPanel();
  
  $("chatHeaderContent").innerHTML = `
    <div class="flex items-center justify-between w-full">
      <div class="flex items-center gap-3">
        ${avatarHTML(avatarId, "sm", null, isPremium)}
        <div>
          <div class="text-sm font-bold text-slate-100 flex items-center gap-1">${escapeHTML(username)}${crownMark(isPremium)}</div>
          <div id="typingIndicator" class="text-[10px] text-brand-400 hidden"></div>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button id="startAudioCallBtn" class="p-2 hover:bg-slate-800 rounded-full text-slate-400 transition" title="Audio Call">📞</button>
        <button id="startVideoCallBtn" class="p-2 hover:bg-slate-800 rounded-full text-slate-400 transition" title="Video Call">📹</button>
        <button id="inviteGameBtn" class="p-2 hover:bg-slate-800 rounded-full text-slate-400 transition" title="Challenge">⚔️</button>
      </div>
    </div>`;

  $("chatForm").classList.remove("hidden");
  await loadMessages();

  if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
    dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
  }

  $("chatInput").focus();
  
  $("startAudioCallBtn").onclick = () => initiateCall(userId, false, username, avatarId, isPremium);
  $("startVideoCallBtn").onclick = () => initiateCall(userId, true, username, avatarId, isPremium);
}

async function loadMessages() {
  if (!activeChatUserId) return;
  try {
    const msgs = await api.getConversation(activeChatUserId);
    const el = $("chatMessages");
    el.innerHTML = "";
    for (const m of msgs) {
      addMessageToUI(m);
    }
    el.scrollTop = el.scrollHeight;
  } catch (err) { console.error(err); }
}

function addMessageToUI(m) {
  const el = $("chatMessages");
  const mine = m.sender_id === myId;

  const wrap = document.createElement("div");
  wrap.className = mine ? "flex flex-col items-end mb-2" : "flex flex-col items-start mb-2";
  
  let replyHtml = "";
  if (m.reply_to_status_id) {
      replyHtml = `<div class="text-[10px] text-brand-400 mb-1 px-2 border-l-2 border-brand-500">Replied to a status</div>`;
  }

  let contentHtml = m.content ? `<div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"}">${escapeHTML(m.content)}</div>` : "";
  let mediaHtml = m.media_url ? `<img src="${m.media_url}" class="max-w-[200px] rounded-xl mt-1 border border-slate-700" />` : "";
  let statusHtml = mine ? `<div class="text-[10px] text-slate-500 mt-0.5"><span class="msg-status mine">${m.read ? "✓✓" : "✓"}</span> · ${timeAgo(m.created_at)}</div>` : `<div class="text-[10px] text-slate-500 mt-0.5">${timeAgo(m.created_at)}</div>`;
  
  if (m.read && mine) {
    setTimeout(() => {
        const statusEl = wrap.querySelector('.msg-status');
        if (statusEl) statusEl.classList.add("text-cyan-400");
    }, 10);
  }

  wrap.innerHTML = `${replyHtml}${contentHtml}${mediaHtml}${statusHtml}`;
  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
}

$("chatInput").addEventListener("input", () => {
  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN || !activeChatUserId) return;
  dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: true }));
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
      dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: false }));
    }
  }, 2000);
});

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || !activeChatUserId) return;
  
  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN) {
    alert("Connecting to chat server... Please wait a second.");
    return;
  }

  $("chatInput").value = "";
  dmSocket.send(JSON.stringify({ type: "dm:send", target_id: activeChatUserId, content: text }));
  dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: false }));
});

// ---------------------------------------------------------
// 4. WEBRTC CALLING SYSTEM
// ---------------------------------------------------------
function playRingtone() {
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const playBeep = () => {
      const osc = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ringtoneCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ringtoneCtx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.5, ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ringtoneCtx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ringtoneCtx.destination);
      osc.start();
      osc.stop(ringtoneCtx.currentTime + 0.5);
    };
    playBeep();
    ringtoneInterval = setInterval(playBeep, 1500);
  } catch (e) { console.log("Audio error", e); }
}

function stopRingtone() {
  if (ringtoneInterval) clearInterval(ringtoneInterval);
  if (ringtoneCtx) ringtoneCtx.close();
  ringtoneInterval = null;
  ringtoneCtx = null;
}

function startCallTimer() {
  clearInterval(callTimerInterval);
  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    const timerEl = $("callTimer");
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
}

function createVideoOverlay(isVideo) {
  if ($("videoCallOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "videoCallOverlay";
  overlay.className = "fixed inset-0 z-[999] bg-[#0b141a] flex flex-col items-center justify-between hidden";
  
  if (isVideo) {
    overlay.innerHTML = `
      <video id="remoteVideo" autoplay playsinline class="absolute inset-0 w-full h-full object-cover z-0"></video>
      
      <div class="relative z-10 w-full p-6 flex justify-between items-center bg-gradient-to-b from-black/60 to-transparent">
        <button class="bg-slate-800/80 p-3 rounded-full text-white backdrop-blur-md"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg></button>
        <div class="text-center">
          <div id="callName" class="text-white font-bold text-lg"></div>
          <div id="callTimer" class="text-slate-300 text-sm">Calling...</div>
        </div>
        <button id="btnSwitchCam" class="bg-slate-800/80 p-3 rounded-full text-white backdrop-blur-md"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button>
      </div>

      <video id="localVideo" autoplay playsinline muted class="absolute top-20 right-4 w-28 h-40 object-cover rounded-2xl border-2 border-slate-700 shadow-2xl z-20"></video>

      <div class="relative z-10 mb-8 bg-[#1f2c33]/80 backdrop-blur-xl px-6 py-4 rounded-full flex items-center gap-6 shadow-2xl border border-white/10">
        <button id="btnShareScreen" class="flex flex-col items-center text-white/80 hover:text-white">
          <svg class="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg>
          <span class="text-[10px]">Share</span>
        </button>
        <button id="btnMute" class="flex flex-col items-center text-white/80 hover:text-white">
          <svg class="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
          <span class="text-[10px]">Mute</span>
        </button>
        <button id="btnEnd" class="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow-lg shadow-red-500/50 transform hover:scale-105 transition">
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M21 15.46l-5.27-.61-2.07 2.08a15.09 15.09 0 01-5.5-5.5l2.08-2.07-.61-5.27A15.85 15.85 0 004.25 2.22a15.7 15.7 0 00-3.1 1.18A15.78 15.78 0 007.22 21.78a15.7 15.7 0 001.18-3.1 15.85 15.85 0 003.11-5.38z"></path></svg>
        </button>
      </div>
    `;
  } else {
    // Sleek Audio Call UI
    overlay.innerHTML = `
      <audio id="remoteAudio" autoplay playsinline class="hidden"></audio>
      <div class="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
      
      <div class="relative z-10 w-full p-6 flex justify-between items-center">
        <button class="bg-slate-800/80 p-3 rounded-full text-white backdrop-blur-md"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"></path></svg></button>
        <div class="text-center">
          <div id="callName" class="text-white font-bold text-2xl flex items-center justify-center gap-2"></div>
          <div id="callTimer" class="text-slate-400 text-sm mt-1">End-to-end encrypted</div>
        </div>
        <button class="opacity-0 w-12 h-12"></button>
      </div>

      <div class="relative z-10 flex-1 flex flex-col items-center justify-center">
        <!-- Glowing Avatar -->
        <div class="w-40 h-40 rounded-full border-4 border-slate-700 overflow-hidden shadow-[0_0_80px_rgba(124,58,237,0.3)] animate-pulse" id="callAvatar"></div>
      </div>

      <div class="relative z-10 mb-12 bg-[#1f2c33]/80 backdrop-blur-xl w-11/12 max-w-sm px-6 py-6 rounded-3xl grid grid-cols-3 gap-6 shadow-2xl border border-white/10">
        <div class="flex flex-col items-center gap-2">
          <button id="btnSpeaker" class="w-14 h-14 rounded-full bg-slate-700/80 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path></svg>
          </button>
          <span class="text-[10px] text-slate-300">Speaker</span>
        </div>
        <div class="flex flex-col items-center gap-2">
          <button class="w-14 h-14 rounded-full bg-slate-700/80 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
          </button>
          <span class="text-[10px] text-slate-300">Video</span>
        </div>
        <div class="flex flex-col items-center gap-2">
          <button id="btnMute" class="w-14 h-14 rounded-full bg-slate-700/80 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
          </button>
          <span class="text-[10px] text-slate-300">Mute</span>
        </div>
        <div class="flex flex-col items-center gap-2 mt-2">
          <button id="btnMore" class="w-14 h-14 rounded-full bg-slate-700/80 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">
             <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z"></path></svg>
          </button>
          <span class="text-[10px] text-slate-300">More</span>
        </div>
        <div class="flex flex-col items-center gap-2 mt-2">
          <button id="btnShareScreen" class="w-14 h-14 rounded-full bg-slate-700/80 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg>
          </button>
          <span class="text-[10px] text-slate-300">Share</span>
        </div>
        <div class="flex flex-col items-center gap-2 mt-2">
          <button id="btnEnd" class="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow-lg shadow-red-500/50 transform hover:scale-105 transition">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M21 15.46l-5.27-.61-2.07 2.08a15.09 15.09 0 01-5.5-5.5l2.08-2.07-.61-5.27A15.85 15.85 0 004.25 2.22a15.7 15.7 0 00-3.1 1.18A15.78 15.78 0 007.22 21.78a15.7 15.7 0 001.18-3.1 15.85 15.85 0 003.11-5.38z"></path></svg>
          </button>
          <span class="text-[10px] text-red-500 font-bold">End</span>
        </div>
      </div>
    `;
  }

  document.body.appendChild(overlay);
  
  // --- Wire up all buttons ---
  $("btnEnd").onclick = endCall;
  
  let isMuted = false;
  $("btnMute").onclick = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        isMuted = !audioTrack.enabled;
        $("btnMute").classList.toggle("bg-white", isMuted);
        $("btnMute").classList.toggle("text-black", isMuted);
      }
    }
  };

  const switchBtn = $("btnSwitchCam");
  if (switchBtn) {
    switchBtn.onclick = async () => {
        if (!localStream) return;
        const videoTrack = localStream.getVideoTracks()[0];
        if (!videoTrack) return;
        
        currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
        const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
        const newTrack = newStream.getVideoTracks()[0];
        
        if (pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(newTrack);
        }
        
        $("localVideo").srcObject = newStream;
        localStream.removeTrack(videoTrack);
        videoTrack.stop();
        localStream.addTrack(newTrack);
    };
  }

  const shareBtn = $("btnShareScreen");
  if (shareBtn) {
    shareBtn.onclick = async () => {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) await sender.replaceTrack(screenTrack);
            }
            
            if ($("localVideo")) $("localVideo").srcObject = screenStream;
            
            screenTrack.onended = () => {
                // Revert back to camera if screen share stops
                switchBtn.click();
            };
        } catch (err) {
            console.log("Screen share cancelled", err);
        }
    };
  }
}

async function initiateCall(targetId, isVideo, targetName, targetAvatar, isPremium) {
  try {
    isVideoCall = isVideo;
    createVideoOverlay(isVideo);
    $("videoCallOverlay").classList.remove("hidden");
    $("videoCallOverlay").classList.add("flex");
    
    $("callName").innerHTML = `${targetName} ${isPremium ? "👑" : ""}`;
    if (!isVideo) $("callAvatar").innerHTML = avatarHTML(targetAvatar, "xl");
    
    $("callTimer").textContent = "Calling...";
    currentCallTargetId = targetId;

    clearTimeout(callTimeout);
    callTimeout = setTimeout(() => {
        if (currentCallTargetId && $("callTimer") && $("callTimer").textContent === "Calling...") {
            alert("User is offline or didn't answer.");
            endCall();
        }
    }, 30000);

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    if ($("localVideo")) $("localVideo").srcObject = localStream;

    pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    
    pc.ontrack = (event) => {
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(event.track);
      
      if ($("remoteVideo")) $("remoteVideo").srcObject = remoteStream;
      
      // Force Audio Playback (Crucial for mobile)
      const audioEl = $("remoteAudio");
      if (audioEl) {
          audioEl.srcObject = remoteStream;
          audioEl.play().catch(e => console.log("Audio play blocked", e));
      }

      $("callTimer").textContent = "Connected";
      stopRingtone();
      startCallTimer();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && dmSocket && dmSocket.readyState === WebSocket.OPEN) {
        dmSocket.send(JSON.stringify({ type: "call:ice-candidate", target_id: targetId, candidate: event.candidate }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
        dmSocket.send(JSON.stringify({ type: "call:offer", target_id: targetId, offer: offer, is_video: isVideo }));
    } else {
        alert("Could not connect to chat server.");
        endCall();
    }
  } catch (err) {
    alert("Could not access camera/microphone. Please allow permissions.");
    endCall();
  }
}

function showIncomingCall(senderId, offer, isVideo) {
  playRingtone();

  const modal = document.createElement("div");
  modal.className = "fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-slate-800/90 backdrop-blur-md border border-slate-700 p-4 rounded-3xl shadow-2xl flex items-center gap-4 animate-bounce";
  
  const caller = friends.find(f => f.id === senderId) || {username: "Unknown", avatar_id: "fox", is_premium: false};
  
  modal.innerHTML = `
    <div>${avatarHTML(caller.avatar_id, "md", null, caller.is_premium)}</div>
    <div>
      <div class="text-white font-bold text-lg">${caller.username}</div>
      <div class="text-slate-400 text-xs">Incoming ${isVideo ? 'Video' : 'Audio'} Call...</div>
    </div>
    <button id="acceptCallBtn" class="bg-emerald-500 hover:bg-emerald-600 w-12 h-12 rounded-full text-white text-xl ml-4 flex items-center justify-center shadow-lg shadow-emerald-500/30">
        <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M21 15.46l-5.27-.61-2.07 2.08a15.09 15.09 0 01-5.5-5.5l2.08-2.07-.61-5.27A15.85 15.85 0 004.25 2.22a15.7 15.7 0 00-3.1 1.18A15.78 15.78 0 007.22 21.78a15.7 15.7 0 001.18-3.1 15.85 15.85 0 003.11-5.38z"></path></svg>
    </button>
    <button id="rejectCallBtn" class="bg-red-500 hover:bg-red-600 w-12 h-12 rounded-full text-white text-xl flex items-center justify-center shadow-lg shadow-red-500/30">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
    </button>
  `;
  document.body.appendChild(modal);

  $("rejectCallBtn").onclick = () => {
    stopRingtone();
    if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "call:end", target_id: senderId }));
    modal.remove();
  };

  $("acceptCallBtn").onclick = async () => {
    stopRingtone();
    modal.remove();
    currentCallTargetId = senderId;
    isVideoCall = isVideo;
    
    createVideoOverlay(isVideo);
    $("videoCallOverlay").classList.remove("hidden");
    $("videoCallOverlay").classList.add("flex");
    $("callName").innerHTML = `${caller.username} ${caller.is_premium ? "👑" : ""}`;
    if (!isVideo) $("callAvatar").innerHTML = avatarHTML(caller.avatar_id, "xl");

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
      if ($("localVideo")) $("localVideo").srcObject = localStream;

      pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
        
        if ($("remoteVideo")) $("remoteVideo").srcObject = remoteStream;
        
        // Force Audio Playback
        const audioEl = $("remoteAudio");
        if (audioEl) {
            audioEl.srcObject = remoteStream;
            audioEl.play().catch(e => console.log("Audio play blocked", e));
        }

        $("callTimer").textContent = "Connected";
        startCallTimer();
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && dmSocket && dmSocket.readyState === WebSocket.OPEN) {
          dmSocket.send(JSON.stringify({ type: "call:ice-candidate", target_id: senderId, candidate: event.candidate }));
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
        dmSocket.send(JSON.stringify({ type: "call:answer", target_id: senderId, answer: answer }));
      }
    } catch (err) {
       alert("Camera access denied.");
       endCall();
    }
  };
}

function endCall() {
  stopRingtone();
  stopCallTimer();
  clearTimeout(callTimeout);
  
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteStream) { remoteStream = null; }
  
  if (currentCallTargetId && dmSocket && dmSocket.readyState === WebSocket.OPEN) {
    try { dmSocket.send(JSON.stringify({ type: "call:end", target_id: currentCallTargetId })); } catch (e) {}
  }
  
  const overlay = $("videoCallOverlay");
  if (overlay) overlay.remove();
  currentCallTargetId = null;
}

// ---------------------------------------------------------
// 5. STATUS / STORIES
// ---------------------------------------------------------
async function renderStories() {
  let bar = $("storyBar");
  if (!bar) {
    const listPanel = $("listPanel");
    const searchDiv = listPanel.querySelector(".p-3.border-b");
    if (searchDiv) {
      bar = document.createElement("div");
      bar.id = "storyBar";
      bar.className = "flex gap-3 overflow-x-auto p-3 border-b border-slate-800 scrollbar-hide";
      searchDiv.after(bar);
    }
  }
  if (!bar) return;

  try { statuses = await api.request("/api/v1/friends/status/feed"); } catch (e) { statuses = []; }

  const grouped = {};
  statuses.forEach(s => {
    if (!grouped[s.user_id]) grouped[s.user_id] = { ...s, items: [] };
    grouped[s.user_id].items.push(s);
  });

  let html = `
    <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer" id="addStatusBtn">
      <div class="w-14 h-14 rounded-full border-2 border-slate-700 bg-slate-800 flex items-center justify-center text-xl text-slate-400 hover:border-brand-500 transition">+</div>
      <div class="text-[10px] text-slate-400 font-bold">Add</div>
    </div>
  `;

  Object.values(grouped).forEach(group => {
    const isSelf = group.relation === "self";
    const ringClass = isSelf ? "border-slate-500" : "border-brand-500";
    html += `
      <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer view-status-btn" data-group='${JSON.stringify(group)}'>
        <div class="w-14 h-14 rounded-full border-2 ${ringClass} p-0.5">${avatarHTML(group.avatar_id, "md")}</div>
        <div class="text-[10px] text-slate-300 font-bold truncate w-14 text-center">${isSelf ? "You" : escapeHTML(group.username)}</div>
      </div>
    `;
  });

  bar.innerHTML = html;

  bar.querySelectorAll(".view-status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = JSON.parse(btn.dataset.group);
      showStatusSlideshow(group.items);
    });
  });

  $("addStatusBtn").addEventListener("click", showCreateStatusModal);
}

function showStatusSlideshow(items) {
  let currentIndex = 0;
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center";
  
  function renderSlide() {
    const status = items[currentIndex];
    
    api.request(`/api/v1/friends/status/${status.id}/view`, { method: "POST" }).catch(() => {});

    let mediaHTML = "";
    if (status.media_url) {
      if (status.media_url.match(/\.(mp4|webm|ogg|mov)$/i)) {
        mediaHTML = `<video src="${status.media_url}" controls autoplay class="w-full h-full object-contain"></video>`;
      } else {
        mediaHTML = `<img src="${status.media_url}" class="w-full h-full object-contain" />`;
      }
    }

    let viewCountHtml = "";
    if (status.relation === "self" && status.viewers) {
        viewCountHtml = `<div class="text-xs text-slate-300 mt-1">👁️ ${status.viewers.length} views</div>`;
    }

    let replyBoxHtml = "";
    if (status.relation !== "self") {
        replyBoxHtml = `
        <div class="absolute bottom-4 left-4 right-4 z-20">
            <input type="text" id="statusReplyInput" placeholder="Reply to story..." class="w-full bg-white/10 backdrop-blur-md border border-white/20 text-white rounded-full px-4 py-2 text-sm focus:outline-none" />
        </div>
        `;
    }

    overlay.innerHTML = `
      <div class="w-full max-w-sm h-full sm:h-[80vh] sm:rounded-2xl bg-slate-900 relative overflow-hidden flex flex-col">
        <div class="absolute top-4 left-4 right-4 flex gap-1 z-20">
          ${items.map((_, i) => `<div class="h-1 flex-1 bg-white/30 rounded-full overflow-hidden"><div class="h-full bg-white transition-all duration-3000 ${i === currentIndex ? 'w-full' : i < currentIndex ? 'w-full' : 'w-0'}"></div></div>`).join("")}
        </div>
        <div class="p-4 pt-10 flex items-center gap-2 z-20 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 right-0">
          ${avatarHTML(status.avatar_id, "sm")}
          <div class="text-sm font-bold text-white">${status.relation === "self" ? "Your Story" : escapeHTML(status.username)}</div>
          <div class="ml-auto text-xs text-slate-300">${timeAgo(status.created_at)}</div>
          <button id="closeStoryBtn" class="ml-2 text-white text-xl">✕</button>
        </div>
        <div class="flex-1 relative flex items-center justify-center bg-black">
          ${mediaHTML}
          ${status.content ? `<div class="absolute bottom-10 left-4 right-4 text-center text-white text-lg font-bold p-4 bg-black/50 rounded-xl backdrop-blur">${escapeHTML(status.content)}</div>` : ""}
          ${viewCountHtml}
        </div>
        <div id="tapLeft" class="absolute top-0 bottom-0 left-0 w-1/3 z-10 cursor-pointer"></div>
        <div id="tapRight" class="absolute top-0 bottom-0 right-0 w-2/3 z-10 cursor-pointer"></div>
        
        ${replyBoxHtml}
      </div>
    `;

    overlay.querySelector("#closeStoryBtn").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#tapLeft").addEventListener("click", () => { if (currentIndex > 0) { currentIndex--; renderSlide(); } });
    overlay.querySelector("#tapRight").addEventListener("click", () => {
      if (currentIndex < items.length - 1) { currentIndex++; renderSlide(); }
      else { overlay.remove(); }
    });

    const replyInput = overlay.querySelector("#statusReplyInput");
    if (replyInput) {
        replyInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const val = replyInput.value.trim();
                if (!val) return;
                if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
                    dmSocket.send(JSON.stringify({ 
                        type: "dm:send", 
                        target_id: status.user_id, 
                        content: val,
                        reply_to_status_id: status.id
                    }));
                    alert("Reply sent!");
                    replyInput.value = "";
                    overlay.remove();
                }
            }
        });
    }

    if (overlay._timeout) clearTimeout(overlay._timeout);
    overlay._timeout = setTimeout(() => {
       if (currentIndex < items.length - 1) { currentIndex++; renderSlide(); }
       else { overlay.remove(); }
    }, 5000);
  }

  renderSlide();
  document.body.appendChild(overlay);
}

function showCreateStatusModal() {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="w-full max-w-sm bg-slate-900 rounded-2xl p-5 border border-slate-700 shadow-2xl">
      <h3 class="text-white font-bold text-lg mb-4">Create Status</h3>
      <textarea id="statusText" rows="3" placeholder="What's on your mind?" class="w-full bg-slate-800 text-white rounded-lg p-3 text-sm focus:outline-none border border-slate-700 mb-3"></textarea>
      <label class="flex items-center gap-2 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg p-3 cursor-pointer hover:bg-slate-700 mb-4">
        <span class="text-xl">📸</span><span class="text-sm font-bold" id="fileLabel">Add Image/Video</span>
        <input type="file" id="statusMedia" accept="image/*,video/*" class="hidden" />
      </label>
      <div class="flex gap-2">
        <button id="cancelStatusBtn" class="flex-1 py-2.5 rounded-lg bg-slate-800 text-slate-300 font-bold text-sm">Cancel</button>
        <button id="postStatusBtn" class="flex-1 py-2.5 rounded-lg bg-brand-600 text-white font-bold text-sm">Post</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fileInput = overlay.querySelector("#statusMedia");
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      overlay.querySelector("#fileLabel").textContent = fileInput.files[0].name;
      overlay.querySelector("#fileLabel").classList.add("text-brand-400");
    }
  });

  overlay.querySelector("#cancelStatusBtn").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#postStatusBtn").addEventListener("click", async () => {
    const text = overlay.querySelector("#statusText").value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return alert("Add text or media");
    const formData = new FormData();
    if (text) formData.append("content", text);
    if (file) formData.append("media", file);
    try {
      const token = localStorage.getItem("ps_token");
      const res = await fetch("/api/v1/friends/status", { method: "POST", headers: { "Authorization": "Bearer " + token }, body: formData });
      if (!res.ok) throw new Error("Failed to post");
      overlay.remove();
      await renderStories();
    } catch (e) { alert("Error posting status"); }
  });
}

// ---------------------------------------------------------
// 6. BOOT
// ---------------------------------------------------------
async function refreshAll() {
  try {
    [friends, requests, conversations] = await Promise.all([api.listFriends(), api.listFriendRequests(), api.listConversations()]);
    const badge = $("reqBadge");
    if (requests.length > 0) { badge.textContent = String(requests.length); badge.classList.remove("hidden"); }
    else { badge.classList.add("hidden"); }
  } catch (err) { console.error(err); }
}

async function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }
  try { me = await api.me(); myId = me.id; } catch { api.clearToken(); window.location.href = "/"; return; }

  connectDMSocket();

  await refreshAll();
  renderList();
  await renderStories();

  pollTimer = setInterval(async () => {
    await refreshAll();
    await renderStories();
    if (!$("searchInput").value.trim()) renderList();
  }, 10000);
}

boot();

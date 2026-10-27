import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null, myId = null, activeTab = "friends", activeChatUserId = null;
let friends = [], requests = [], conversations = [], searchResults = [], statuses = [];
let pollTimer = null;
let dmSocket = null;
let reconnectTimeout = null;

// --- WebRTC & Media Variables ---
let pc = null;
let localStream = null;
let remoteStream = null;
let currentCallTargetId = null;
let isVideoCall = false;
let isMuted = false;
const STUN_SERVER = "stun:stun.l.google.com:19302";

// --- Voice Note Variables ---
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

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

  if (dmSocket) { dmSocket.onclose = null; dmSocket.close(); }
  dmSocket = new WebSocket(url);

  dmSocket.addEventListener("open", () => {
    if (activeChatUserId) dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
  });

  dmSocket.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "dm:new") {
      if (activeChatUserId === msg.sender_id || activeChatUserId === msg.recipient_id) {
        addMessageToUI(msg);
        if (msg.recipient_id === myId) dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: msg.sender_id }));
      }
      refreshAll();
    } 
    else if (msg.type === "dm:typing") {
      if (activeChatUserId === msg.sender_id) {
        const ind = $("typingIndicator");
        if (ind) { ind.textContent = msg.is_typing ? "typing..." : ""; ind.classList.toggle("hidden", !msg.is_typing); }
      }
    } 
    else if (msg.type === "dm:seen") {
      if (activeChatUserId === msg.reader_id) {
        document.querySelectorAll(".msg-status.mine").forEach(el => { el.textContent = "✓✓"; el.classList.add("text-cyber-cyan"); });
      }
    }
    else if (msg.type === "call:offer") showIncomingCall(msg.sender_id, msg.offer);
    else if (msg.type === "call:answer") { if (pc) { clearTimeout(callTimeout); pc.setRemoteDescription(new RTCSessionDescription(msg.answer)); } }
    else if (msg.type === "call:ice-candidate") { if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
    else if (msg.type === "call:end") endCall();
    else if (msg.type === "call:reject") {
        if (currentCallTargetId) alert("Call was declined.");
        endCall();
    }
  });

  dmSocket.addEventListener("close", () => {
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
  if (diff < 60) return "now"; if (diff < 3600) return `${Math.floor(diff / 60)}m`; if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
function escapeHTML(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function crownMark(isPremium) { return isPremium ? ' <span class="text-amber-400 text-xs shadow-[0_0_10px_#fbbf24]">👑</span>' : ""; }

function openChatPanel() { document.body.classList.add("chat-open"); }
function closeChatPanel() {
  document.body.classList.remove("chat-open");
  activeChatUserId = null;
  $("chatMessages").innerHTML = "";
  $("chatHeaderContent").innerHTML = `<div class="text-sm text-slate-400 font-medium">Select a conversation to begin transmission</div>`;
  $("chatForm").classList.add("hidden");
  renderList();
}
$("mobileBack").addEventListener("click", closeChatPanel);

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => { 
        b.className = b.dataset.tab === activeTab ? "tab-btn flex-1 py-4 text-cyber-cyan border-b-2 border-cyber-cyan bg-cyber-cyan/5 transition" : "tab-btn flex-1 py-4 text-slate-500 hover:text-slate-300 transition"; 
    });
    renderList();
  });
});

let searchTimeout = null;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (!q) { searchResults = []; renderList(); return; }
  searchTimeout = setTimeout(async () => { try { searchResults = await api.searchUsers(q); renderList(); } catch (err) { console.error(err); } }, 300);
});

function renderList() {
  const list = $("listArea");
  if (searchResults.length > 0 && $("searchInput").value.trim()) {
    list.innerHTML = searchResults.map((u) => {
      const rel = u.relationship;
      let action = "";
      if (rel === "self") action = `<span class="text-xs text-slate-500">You</span>`;
      else if (rel === "friends") action = `<button data-act="chat" data-id="${u.id}" data-username="${escapeHTML(u.username)}" data-avatar="${u.avatar_id}" data-premium="${u.is_premium ? '1' : '0'}" class="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 shadow-lg shadow-brand-500/20">Message</button>`;
      else if (rel === "pending_out") action = `<span class="text-xs text-amber-400">Sent</span>`;
      else if (rel === "pending_in") action = `<button data-act="accept" data-id="${u.id}" class="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-500/20">Accept</button>`;
      else action = `<button data-act="add" data-id="${u.id}" class="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 shadow-lg shadow-brand-500/20">+ Add</button>`;
      return `
        <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40 border-b border-slate-800/50 transition cursor-pointer">
          <div class="flex-shrink-0">${avatarHTML(u.avatar_id, "sm", u.frame_color, u.is_premium)}</div>
          <div class="flex-1 min-w-0"><div class="text-sm font-bold text-slate-200 truncate">${escapeHTML(u.username)}${crownMark(u.is_premium)}</div><div class="text-xs text-slate-500">Level ${u.level}</div></div>
          ${action}
        </div>`;
    }).join("");
    wireRowButtons(); return;
  }

  if (activeTab === "friends") {
    if (friends.length === 0) { list.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm font-medium">No friends in the network yet.</div>`; return; }
    list.innerHTML = friends.map((f) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40 border-b border-slate-800/50 transition">
        <div class="flex-shrink-0 cursor-pointer" data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}">${avatarHTML(f.avatar_id, "sm", f.frame_color, f.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-bold text-slate-200 truncate flex items-center gap-1">${escapeHTML(f.username)}${crownMark(f.is_premium)} ${f.streak_count > 0 ? `<span class="text-orange-500 font-bold text-[10px]">🔥 ${f.streak_count}</span>` : ""}</div>
          <div class="text-xs text-slate-500">Level ${f.level}</div>
        </div>
        <button data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}" class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-brand-600 hover:border-brand-500 text-white font-bold transition shadow-lg">Chat</button>
      </div>`).join("");
    wireFriendRows(); return;
  }

  if (activeTab === "requests") {
    if (requests.length === 0) { list.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm font-medium">No incoming transmission requests.</div>`; return; }
    list.innerHTML = requests.map((r) => `
      <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50">
        <div class="flex-shrink-0">${avatarHTML(r.avatar_id, "sm", r.frame_color, r.is_premium)}</div>
        <div class="flex-1 min-w-0"><div class="text-sm font-bold text-slate-200 truncate">${escapeHTML(r.username)}${crownMark(r.is_premium)}</div><div class="text-xs text-slate-500">Level ${r.level}</div></div>
        <div class="flex gap-1">
          <button data-act="accept" data-id="${r.user_id}" class="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-500/20">✓</button>
          <button data-act="decline" data-id="${r.user_id}" class="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600">✕</button>
        </div>
      </div>`).join("");
    wireRowButtons(); return;
  }

  if (activeTab === "chats") {
    if (conversations.length === 0) { list.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm font-medium">No active comms channels.</div>`; return; }
    list.innerHTML = conversations.map((c) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40 border-b border-slate-800/50 cursor-pointer transition" data-chat="${c.user_id}" data-username="${escapeHTML(c.username)}" data-avatar="${c.avatar_id}" data-premium="${c.is_premium ? '1' : '0'}">
        <div class="flex-shrink-0">${avatarHTML(c.avatar_id, "sm", c.frame_color, c.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <div class="text-sm font-bold text-slate-200 truncate flex items-center gap-1">${escapeHTML(c.username)}${crownMark(c.is_premium)} ${c.streak > 0 ? `<span class="text-orange-500 font-bold text-[10px]">🔥 ${c.streak}</span>` : ""}</div>
            <div class="text-[10px] text-slate-500">${timeAgo(c.last_at)}</div>
          </div>
          <div class="flex items-center justify-between mt-0.5">
            <div class="text-xs text-slate-400 truncate">${escapeHTML(c.last_message)}</div>
            ${c.unread_count > 0 ? `<span class="ml-2 px-2 py-0.5 rounded-full bg-cyber-pink text-white text-[10px] font-bold shadow-[0_0_10px_#ec4899]">${c.unread_count}</span>` : ""}
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
          <div class="text-sm font-bold text-white flex items-center gap-1">${escapeHTML(username)}${crownMark(isPremium)}</div>
          <div id="typingIndicator" class="text-[10px] text-cyber-cyan font-bold hidden"></div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="startAudioCallBtn" class="p-2.5 bg-slate-800/80 rounded-full text-slate-300 hover:text-white transition pulse-glow" title="Audio Call">📞</button>
        <button id="startVideoCallBtn" class="p-2.5 bg-slate-800/80 rounded-full text-slate-300 hover:text-white transition pulse-glow" title="Video Call">📹</button>
        <button id="inviteGameBtn" class="p-2.5 bg-slate-800/80 rounded-full text-slate-300 hover:text-white transition pulse-glow" title="Challenge">⚔️</button>
      </div>
    </div>`;

  $("chatForm").classList.remove("hidden");
  await loadMessages();

  if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
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
    for (const m of msgs) { addMessageToUI(m); }
    el.scrollTop = el.scrollHeight;
  } catch (err) { console.error(err); }
}

function addMessageToUI(m) {
  const el = $("chatMessages");
  const mine = m.sender_id === myId;

  const wrap = document.createElement("div");
  wrap.className = mine ? "flex flex-col items-end mb-3 chat-bubble" : "flex flex-col items-start mb-3 chat-bubble";
  
  let replyHtml = m.reply_to_status_id ? `<div class="text-[10px] text-cyber-cyan mb-1 px-2 border-l-2 border-cyber-cyan">Replied to a status</div>` : "";

  let contentHtml = "";
  if (m.content && (m.content.includes("Missed audio call") || m.content.includes("Missed video call"))) {
      contentHtml = `<div class="text-sm font-bold text-red-400 flex items-center gap-2 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-xl"><span>📞</span> ${escapeHTML(m.content)}</div>`;
  } else if (m.content) {
      contentHtml = `<div class="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm break-words shadow-lg ${mine ? "bg-gradient-to-br from-brand-600 to-brand-700 text-white rounded-tr-sm" : "bg-slate-800/90 border border-slate-700 text-slate-100 rounded-tl-sm"}">${escapeHTML(m.content)}</div>`;
  }

  let mediaHtml = "";
  if (m.media_url) {
      if (m.media_url.match(/\.(mp4|webm|ogg|mov|mp3|wav|m4a)$/i)) {
          mediaHtml = `<div class="mt-2 bg-slate-900/80 p-2 rounded-xl border border-slate-700"><audio src="${m.media_url}" controls class="w-48 h-10"></audio></div>`;
      } else {
          mediaHtml = `<img src="${m.media_url}" class="max-w-[200px] rounded-xl mt-1 border border-slate-700 shadow-lg" />`;
      }
  }

  let statusHtml = mine ? `<div class="text-[10px] text-slate-500 mt-1 mr-1"><span class="msg-status mine">${m.read ? "✓✓" : "✓"}</span> · ${timeAgo(m.created_at)}</div>` : `<div class="text-[10px] text-slate-500 mt-1 ml-1">${timeAgo(m.created_at)}</div>`;
  
  if (m.read && mine) {
    setTimeout(() => { const s = wrap.querySelector('.msg-status'); if (s) s.classList.add("text-cyber-cyan", "drop-shadow-[0_0_5px_#06b6d4]"); }, 10);
  }

  wrap.innerHTML = `${replyHtml}${contentHtml}${mediaHtml}${statusHtml}`;
  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
}

$("chatInput").addEventListener("input", () => {
  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN || !activeChatUserId) return;
  dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: true }));
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: false })); }, 2000);
});

// --- SUBMIT TEXT ---
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

// --- UPLOAD IMAGE (Via WebSocket Media URL) ---
$("chatImageInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !activeChatUserId) return;
    
    // In a real app, you upload to S3/Cloudinary here. For now, we simulate a URL
    // We'll base64 encode it for local testing.
    const reader = new FileReader();
    reader.onload = (ev) => {
        const base64Url = ev.target.result;
        dmSocket.send(JSON.stringify({ type: "dm:send", target_id: activeChatUserId, content: "", media_url: base64Url }));
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // Reset
});

// --- VOICE NOTE LOGIC ---
$("voiceNoteBtn").addEventListener("click", async () => {
    if (!activeChatUserId) return;

    if (isRecording) {
        // Stop recording
        mediaRecorder.stop();
        isRecording = false;
        $("micIcon").textContent = "🎤";
        $("micIcon").classList.remove("text-red-500", "animate-pulse");
    } else {
        // Start recording
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const base64Audio = ev.target.result;
                    dmSocket.send(JSON.stringify({ type: "dm:send", target_id: activeChatUserId, content: "", media_url: base64Audio }));
                };
                reader.readAsDataURL(audioBlob);
            };

            mediaRecorder.start();
            isRecording = true;
            $("micIcon").textContent = "⏹️";
            $("micIcon").classList.add("text-red-500", "animate-pulse");
        } catch (err) {
            alert("Microphone access denied.");
        }
    }
});

// ---------------------------------------------------------
// 4. WEBRTC CALLING SYSTEM
// ---------------------------------------------------------
function createVideoOverlay(isVideo, targetName, targetAvatar, isPremium) {
  if ($("videoCallOverlay")) $("videoCallOverlay").remove();
  const overlay = document.createElement("div");
  overlay.id = "videoCallOverlay";
  overlay.className = "fixed inset-0 z-[999] bg-[#0b141a] flex flex-col items-center justify-between";
  
  const header = `
    <div class="relative z-10 w-full p-6 flex justify-between items-center">
      <button class="opacity-0 w-12 h-12"></button>
      <div class="text-center">
        <div class="text-white font-bold text-2xl font-display flex items-center justify-center gap-2">${targetName} ${isPremium ? "👑" : ""}</div>
        <div id="callTimer" class="text-cyber-cyan text-sm mt-1 font-mono tracking-widest">CONNECTING...</div>
      </div>
      <button class="opacity-0 w-12 h-12"></button>
    </div>
  `;

  if (isVideo) {
    overlay.innerHTML = `
      <video id="remoteVideo" autoplay playsinline class="absolute inset-0 w-full h-full object-cover z-0"></video>
      ${header}
      <video id="localVideo" autoplay playsinline muted class="absolute top-20 right-4 w-28 h-40 object-cover rounded-2xl border-2 border-cyber-cyan shadow-[0_0_20px_rgba(6,182,212,0.4)] z-20"></video>
      <div class="relative z-10 mb-8 bg-[#1f2c33]/90 backdrop-blur-md px-6 py-4 rounded-full flex items-center gap-6 shadow-2xl border border-slate-700">
        <button id="btnVideo" class="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">📹</button>
        <button id="btnMute" class="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl hover:bg-slate-600 transition">🎤</button>
        <button id="btnEnd" class="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white text-2xl shadow-lg shadow-red-500/50 hover:bg-red-600 transition">📞</button>
      </div>
    `;
  } else {
    overlay.innerHTML = `
      <audio id="remoteAudio" autoplay playsinline></audio>
      <div class="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
      ${header}
      <div class="relative z-10 flex-1 flex flex-col items-center justify-center">
        <div class="w-40 h-40 rounded-full border-4 border-cyber-cyan overflow-hidden shadow-[0_0_50px_rgba(6,182,212,0.3)]">${avatarHTML(targetAvatar, "xl")}</div>
      </div>
      <div class="relative z-10 mb-12 bg-[#1f2c33]/90 backdrop-blur-md w-11/12 max-w-sm px-6 py-6 rounded-3xl grid grid-cols-3 gap-6 shadow-2xl border border-slate-700">
        <div class="flex flex-col items-center gap-2"><button class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">🔊</button><span class="text-xs text-slate-300">Speaker</span></div>
        <div class="flex flex-col items-center gap-2"><button id="btnSwitchToVideo" class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">📹</button><span class="text-xs text-slate-300">Video</span></div>
        <div class="flex flex-col items-center gap-2"><button id="btnMute" class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">🎤</button><span class="text-xs text-slate-300">Mute</span></div>
        <div class="flex flex-col items-center gap-2 mt-2"><button class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">•••</button><span class="text-xs text-slate-300">More</span></div>
        <div class="flex flex-col items-center gap-2 mt-2"><button class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">↗</button><span class="text-xs text-slate-300">Share</span></div>
        <div class="flex flex-col items-center gap-2 mt-2"><button id="btnEnd" class="w-14 h-14 rounded-full bg-red-500 flex items-center justify-center text-white text-xl shadow-lg shadow-red-500/50">📞</button><span class="text-xs text-slate-300 text-red-500 font-bold">End</span></div>
      </div>
    `;
  }
  document.body.appendChild(overlay);
  
  $("btnEnd").onclick = endCall;
  
  isMuted = false;
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

  if (!isVideo) {
      $("btnSwitchToVideo").onclick = async () => {
          try {
              const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
              const videoTrack = videoStream.getVideoTracks()[0];
              if (pc) {
                  const senders = pc.getSenders();
                  const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                  if (videoSender) videoSender.replaceTrack(videoTrack);
                  else pc.addTrack(videoTrack, videoStream);
              }
              if (localStream) localStream.addTrack(videoTrack);
              
              const name = targetName, av = targetAvatar, pr = isPremium;
              $("videoCallOverlay").remove();
              createVideoOverlay(true, name, av, pr);
              $("remoteVideo").srcObject = remoteStream;
              $("localVideo").srcObject = localStream;
              startCallTimer();
          } catch (e) { alert("Camera access denied."); }
      };
  }
}

let callTimerInterval = null;
let callSeconds = 0;

function startCallTimer() {
  clearInterval(callTimerInterval);
  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    if ($("callTimer")) $("callTimer").textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() { clearInterval(callTimerInterval); }

async function initiateCall(targetId, isVideo, targetName, targetAvatar, isPremium) {
  try {
    isVideoCall = isVideo;
    createVideoOverlay(isVideo, targetName, targetAvatar, isPremium);
    currentCallTargetId = targetId;

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    if ($("localVideo")) $("localVideo").srcObject = localStream;

    pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    
    pc.ontrack = (event) => {
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(event.track);
      if ($("remoteVideo")) $("remoteVideo").srcObject = remoteStream;
      if ($("remoteAudio")) $("remoteAudio").srcObject = remoteStream;
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
    }
    
    callTimeout = setTimeout(() => {
      if (currentCallTargetId) { 
          alert("User is offline or didn't answer.");
          dmSocket.send(JSON.stringify({ type: "call:reject", target_id: targetId, call_type: isVideo ? 'video' : 'audio' })); 
          endCall(); 
      }
    }, 30000);

  } catch (err) {
    alert("Could not access camera/microphone.");
    endCall();
  }
}

function showIncomingCall(senderId, offer) {
  playRingtone();
  const modal = document.createElement("div");
  modal.className = "fixed inset-0 z-[9999] bg-[#0b141a] flex flex-col items-center justify-between p-8";
  const caller = friends.find(f => f.id === senderId) || {username: "Unknown", avatar_id: "fox", is_premium: false};
  
  modal.innerHTML = `
    <div class="text-center mt-12 w-full">
      <div class="text-cyber-cyan text-sm font-bold tracking-widest uppercase mb-2 animate-pulse">Incoming ${offer.is_video ? 'Video' : 'Audio'} Call</div>
      <div class="w-40 h-40 mx-auto rounded-full border-4 border-cyber-cyan overflow-hidden shadow-[0_0_30px_rgba(6,182,212,0.5)] animate-bounce">${avatarHTML(caller.avatar_id, "xl", null, caller.is_premium)}</div>
      <div class="text-white font-black text-3xl mt-6 font-display tracking-wider">${caller.username}</div>
    </div>
    <div class="w-full max-w-sm flex justify-between mb-12">
      <div class="flex flex-col items-center gap-2">
        <button id="rejectCallBtn" class="bg-red-500 w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl shadow-[0_0_20px_#ef4444] hover:scale-105 transition">✖</button>
        <span class="text-xs text-slate-400 font-bold uppercase">Decline</span>
      </div>
      <div class="flex flex-col items-center gap-2">
        <button id="acceptCallBtn" class="bg-emerald-500 w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl shadow-[0_0_20px_#10b981] animate-pulse hover:scale-105 transition">📞</button>
        <span class="text-xs text-slate-400 font-bold uppercase">Accept</span>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  $("rejectCallBtn").onclick = () => {
    stopRingtone();
    if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "call:reject", target_id: senderId, call_type: offer.is_video ? 'video' : 'audio' }));
    modal.remove();
  };

  $("acceptCallBtn").onclick = async () => {
    stopRingtone();
    modal.remove();
    currentCallTargetId = senderId;
    isVideoCall = offer.is_video;
    
    createVideoOverlay(offer.is_video || false, caller.username, caller.avatar_id, caller.is_premium);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: offer.is_video || false });
      if ($("localVideo")) $("localVideo").srcObject = localStream;

      pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
        if ($("remoteVideo")) $("remoteVideo").srcObject = remoteStream;
        if ($("remoteAudio")) $("remoteAudio").srcObject = remoteStream;
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
       alert("Camera/Microphone access denied.");
       endCall();
    }
  };
}

// --- RINGTONE ---
let ringtoneCtx = null;
let ringtoneInterval = null;

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
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      osc.start(); osc.stop(ringtoneCtx.currentTime + 0.5);
    };
    playBeep(); ringtoneInterval = setInterval(playBeep, 1500);
  } catch (e) { console.log("Audio error", e); }
}

function stopRingtone() {
  if (ringtoneInterval) clearInterval(ringtoneInterval);
  if (ringtoneCtx) ringtoneCtx.close();
  ringtoneInterval = null; ringtoneCtx = null;
}

function endCall() {
  stopRingtone(); stopCallTimer();
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
    const searchDiv = listPanel.querySelector(".p-4.border-b");
    if (searchDiv) {
      bar = document.createElement("div");
      bar.id = "storyBar";
      bar.className = "flex gap-3 overflow-x-auto p-4 border-b border-brand-500/20 scrollbar-hide";
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
      <div class="w-14 h-14 rounded-full border-2 border-dashed border-slate-600 bg-slate-800/50 flex items-center justify-center text-xl text-slate-400 hover:border-cyber-cyan hover:text-cyber-cyan transition">+</div>
      <div class="text-[10px] text-slate-400 font-bold mt-1">Add</div>
    </div>
  `;

  Object.values(grouped).forEach(group => {
    const isSelf = group.relation === "self";
    const ringClass = isSelf ? "border-slate-500" : "border-cyber-pink shadow-[0_0_10px_#ec4899]";
    html += `
      <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer view-status-btn" data-group='${JSON.stringify(group)}'>
        <div class="w-14 h-14 rounded-full border-2 ${ringClass} p-0.5">${avatarHTML(group.avatar_id, "md")}</div>
        <div class="text-[10px] text-slate-300 font-bold truncate w-14 text-center mt-1">${isSelf ? "You" : escapeHTML(group.username)}</div>
      </div>
    `;
  });

  bar.innerHTML = html;

  bar.querySelectorAll(".view-status-btn").forEach(btn => {
    btn.addEventListener("click", () => { const group = JSON.parse(btn.dataset.group); showStatusSlideshow(group.items); });
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
      if (status.media_url.match(/\.(mp4|webm|ogg|mov)$/i)) mediaHTML = `<video src="${status.media_url}" controls autoplay class="w-full h-full object-contain"></video>`;
      else mediaHTML = `<img src="${status.media_url}" class="w-full h-full object-contain" />`;
    }

    let viewCountHtml = status.relation === "self" && status.viewers ? `<div class="text-xs text-slate-300 mt-1">👁️ ${status.viewers.length} views</div>` : "";

    overlay.innerHTML = `
      <div class="w-full max-w-sm h-full sm:h-[80vh] sm:rounded-2xl bg-slate-900 relative overflow-hidden flex flex-col border border-brand-500/30 shadow-[0_0_50px_rgba(124,58,237,0.3)]">
        <div class="absolute top-4 left-4 right-4 flex gap-1 z-20">
          ${items.map((_, i) => `<div class="h-1 flex-1 bg-white/30 rounded-full overflow-hidden"><div class="h-full bg-cyber-cyan transition-all duration-3000 ${i === currentIndex ? 'w-full' : i < currentIndex ? 'w-full' : 'w-0'}"></div></div>`).join("")}
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

        ${!status.relation === "self" ? "" : `
        <div class="absolute bottom-4 left-4 right-4 z-20">
            <input type="text" id="statusReplyInput" placeholder="Reply to story..." class="w-full bg-white/10 backdrop-blur-md border border-cyber-cyan/50 text-white rounded-full px-4 py-3 text-sm focus:outline-none focus:border-cyber-cyan transition" />
        </div>
        `}
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
                    dmSocket.send(JSON.stringify({ type: "dm:send", target_id: status.user_id, content: val, reply_to_status_id: status.id }));
                    alert("Reply sent!");
                    replyInput.value = ""; overlay.remove();
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
  overlay.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 backdrop-blur-sm";
  overlay.innerHTML = `
    <div class="w-full max-w-sm bg-slate-900 rounded-2xl p-6 border border-brand-500/30 shadow-[0_0_30px_rgba(124,58,237,0.2)]">
      <h3 class="text-white font-bold text-lg mb-4 font-display">Create Status</h3>
      <textarea id="statusText" rows="3" placeholder="What's on your mind?" class="w-full bg-slate-800 text-white rounded-lg p-3 text-sm focus:outline-none border border-slate-700 mb-3 focus:border-cyber-cyan transition"></textarea>
      <label class="flex items-center gap-2 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg p-3 cursor-pointer hover:bg-slate-700 mb-6 transition">
        <span class="text-xl">📸</span><span class="text-sm font-bold" id="fileLabel">Add Image/Video</span>
        <input type="file" id="statusMedia" accept="image/*,video/*" class="hidden" />
      </label>
      <div class="flex gap-2">
        <button id="cancelStatusBtn" class="flex-1 py-3 rounded-lg bg-slate-800 text-slate-300 font-bold text-sm hover:bg-slate-700 transition">Cancel</button>
        <button id="postStatusBtn" class="flex-1 py-3 rounded-lg bg-gradient-to-r from-brand-600 to-cyber-pink text-white font-bold text-sm shadow-lg hover:opacity-90 transition">Post</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fileInput = overlay.querySelector("#statusMedia");
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      overlay.querySelector("#fileLabel").textContent = fileInput.files[0].name;
      overlay.querySelector("#fileLabel").classList.add("text-cyber-cyan");
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

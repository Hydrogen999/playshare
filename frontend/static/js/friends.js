import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null, myId = null, activeTab = "friends", activeChatUserId = null;
let friends = [], requests = [], conversations = [], searchResults = [], statuses = [];
let pollTimer = null;
let dmSocket = null;

// --- WebRTC Variables ---
let pc = null;
let localStream = null;
let remoteStream = null;
let currentCallTargetId = null;
const STUN_SERVER = "stun:stun.l.google.com:19302";

// --- Typing Timeout ---
let typingTimeout = null;

// ---------------------------------------------------------
// 1. WEBSOCKET CONNECTION FOR CHAT
// ---------------------------------------------------------
function connectDMSocket() {
  const token = api.getToken();
  if (!token) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws/dm?token=${encodeURIComponent(token)}`;
  dmSocket = new WebSocket(url);

  dmSocket.addEventListener("open", () => {
    console.log("[DM WS] Connected");
    // If we have an active chat open, mark messages as seen
    if (activeChatUserId) {
      dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
    }
  });

  dmSocket.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "dm:new") {
      // If we are currently looking at this chat, add it to the screen
      if (activeChatUserId === msg.sender_id || activeChatUserId === msg.recipient_id) {
        addMessageToUI(msg);
        if (msg.recipient_id === myId) {
          // Mark as seen immediately since chat is open
          dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: msg.sender_id }));
        }
      }
      refreshAll(); // update chat list preview
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
        // Change single checkmark to double blue checkmark
        document.querySelectorAll(".msg-status.mine").forEach(el => {
          el.textContent = "✓✓";
          el.classList.add("text-cyan-400");
        });
      }
    }
    // --- WebRTC Signaling ---
    else if (msg.type === "call:offer") {
      showIncomingCall(msg.sender_id, msg.offer);
    }
    else if (msg.type === "call:answer") {
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
    }
    else if (msg.type === "call:ice-candidate") {
      if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
    else if (msg.type === "call:end") {
      endCall();
    }
  });

  dmSocket.addEventListener("close", () => {
    console.log("[DM WS] Disconnected. Reconnecting...");
    setTimeout(connectDMSocket, 3000);
  });
}

// ---------------------------------------------------------
// 2. UI RENDERING & NAVIGATION
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

  // Mark messages as seen
  if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
    dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
  }

  $("chatInput").focus();
  
  // Wire Call Buttons
  $("startAudioCallBtn").onclick = () => initiateCall(userId, false);
  $("startVideoCallBtn").onclick = () => initiateCall(userId, true);
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
  
  let contentHtml = m.content ? `<div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"}">${escapeHTML(m.content)}</div>` : "";
  let mediaHtml = m.media_url ? `<img src="${m.media_url}" class="max-w-[200px] rounded-xl mt-1 border border-slate-700" />` : "";
  let statusHtml = mine ? `<div class="text-[10px] text-slate-500 mt-0.5"><span class="msg-status mine">${m.read ? "✓✓" : "✓"}</span> · ${timeAgo(m.created_at)}</div>` : `<div class="text-[10px] text-slate-500 mt-0.5">${timeAgo(m.created_at)}</div>`;
  
  if (m.read && mine) {
    // If already read, make it cyan immediately
    setTimeout(() => {
        const statusEl = wrap.querySelector('.msg-status');
        if (statusEl) statusEl.classList.add("text-cyan-400");
    }, 10);
  }

  wrap.innerHTML = `${contentHtml}${mediaHtml}${statusHtml}`;
  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
}

// Typing Indicator logic
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
  
  dmSocket.send(JSON.stringify({
    type: "dm:send",
    target_id: activeChatUserId,
    content: text
  }));

  // Stop typing indicator
  dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: false }));
});

// ---------------------------------------------------------
// 4. WEBRTC CALLING SYSTEM
// ---------------------------------------------------------
function createVideoOverlay() {
  if ($("videoCallOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "videoCallOverlay";
  overlay.className = "video-overlay";
  overlay.innerHTML = `
    <video id="remoteVideo" autoplay playsinline class="flex-1 object-cover"></video>
    <video id="localVideo" autoplay playsinline muted class="absolute bottom-4 right-4 w-32 h-48 object-cover rounded-xl border-2 border-slate-700 shadow-2xl z-10"></video>
    <div class="absolute top-4 left-4 text-white font-bold p-2 bg-black/50 rounded-lg z-10" id="callStatus">Connected</div>
    <button id="endCallBtn" class="absolute bottom-6 left-1/2 -translate-x-1/2 bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-full font-bold shadow-lg z-10">End Call</button>
  `;
  document.body.appendChild(overlay);
  $("endCallBtn").onclick = endCall;
}

async function initiateCall(targetId, isVideo) {
  try {
    createVideoOverlay();
    $("videoCallOverlay").classList.add("active");
    $("callStatus").textContent = "Calling...";
    currentCallTargetId = targetId;

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    $("localVideo").srcObject = localStream;

    pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
    
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    
    pc.ontrack = (event) => {
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(event.track);
      $("remoteVideo").srcObject = remoteStream;
      $("callStatus").textContent = "Connected";
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        dmSocket.send(JSON.stringify({ type: "call:ice-candidate", target_id: targetId, candidate: event.candidate }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    dmSocket.send(JSON.stringify({ type: "call:offer", target_id: targetId, offer: offer }));
  } catch (err) {
    alert("Could not access camera/microphone. Please allow permissions.");
    endCall();
  }
}

function showIncomingCall(senderId, offer) {
  const modal = document.createElement("div");
  modal.className = "incoming-call-modal bg-slate-800 border border-slate-700 p-4 rounded-2xl shadow-2xl flex items-center gap-4";
  modal.innerHTML = `
    <div class="text-white font-bold">Incoming Call...</div>
    <button id="acceptCallBtn" class="bg-emerald-600 px-4 py-2 rounded-lg text-white font-bold">Accept</button>
    <button id="rejectCallBtn" class="bg-red-600 px-4 py-2 rounded-lg text-white font-bold">Reject</button>
  `;
  document.body.appendChild(modal);

  $("rejectCallBtn").onclick = () => {
    dmSocket.send(JSON.stringify({ type: "call:end", target_id: senderId }));
    modal.remove();
  };

  $("acceptCallBtn").onclick = async () => {
    modal.remove();
    currentCallTargetId = senderId;
    createVideoOverlay();
    $("videoCallOverlay").classList.add("active");

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      $("localVideo").srcObject = localStream;

      pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
        $("remoteVideo").srcObject = remoteStream;
        $("callStatus").textContent = "Connected";
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          dmSocket.send(JSON.stringify({ type: "call:ice-candidate", target_id: senderId, candidate: event.candidate }));
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      dmSocket.send(JSON.stringify({ type: "call:answer", target_id: senderId, answer: answer }));
    } catch (err) {
       alert("Camera access denied.");
       endCall();
    }
  };
}

function endCall() {
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteStream) { remoteStream = null; }
  
  if (currentCallTargetId && dmSocket && dmSocket.readyState === WebSocket.OPEN) {
    dmSocket.send(JSON.stringify({ type: "call:end", target_id: currentCallTargetId }));
  }
  
  const overlay = $("videoCallOverlay");
  if (overlay) overlay.classList.remove("active");
  currentCallTargetId = null;
}

// ---------------------------------------------------------
// 5. BOOT
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

  pollTimer = setInterval(async () => {
    // We still poll the friend list/requests, but NOT the active chat messages anymore!
    await refreshAll();
    if (!$("searchInput").value.trim()) renderList();
  }, 10000); // Slower polling since WebSocket handles the chat!
}

boot();

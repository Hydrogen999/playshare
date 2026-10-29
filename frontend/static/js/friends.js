import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null, myId = null, activeTab = "friends", activeChatUserId = null;
let activeGroupId = null;
let friends = [], requests = [], conversations = [], groups = [], searchResults = [], statuses = [];
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
let callTimeout = null;
let incomingCallModal = null;

// 🟢 FREE STUN SERVERS (No account needed)
const ICE_SERVERS = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" } 
    ]
};

// --- Voice Note Variables ---
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingTarget = null;

// --- Typing Timeout ---
let typingTimeout = null;

// --- Emoji Reactions ---
const EMOJIS = ["❤️", "😂", "🔥", "👍", "😮", "😢"];

const TAB_ACTIVE = "tab-btn flex-shrink-0 px-4 py-4 text-cyber-cyan border-b-2 border-cyber-cyan bg-cyber-cyan/5 transition";
const TAB_IDLE = "tab-btn flex-shrink-0 px-4 py-4 text-slate-500 hover:text-slate-300 transition";

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => { b.className = b.dataset.tab === activeTab ? TAB_ACTIVE : TAB_IDLE; });
}

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

  dmSocket.addEventListener("message", async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "dm:new") {
      if (activeChatUserId === msg.sender_id || activeChatUserId === msg.recipient_id) {
        addMessageToUI(msg);
        if (msg.recipient_id === myId) dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: msg.sender_id }));
      }
      refreshAll();
    }
    else if (msg.type === "group:new") {
      if (activeGroupId && String(activeGroupId) === String(msg.group_id)) addMessageToUI(msg);
      refreshAll();
    }
    else if (msg.type === "group:created") {
      await refreshAll(); 
      if (activeTab === "groups") renderList();
      const toast = document.createElement("div");
      toast.className = "fixed top-4 left-1/2 -translate-x-1/2 z-[999] bg-brand-600 text-white px-6 py-3 rounded-full shadow-2xl font-bold animate-bounce cursor-pointer flex items-center gap-2";
      toast.innerHTML = `👥 You were added to "<b>${escapeHTML(msg.group.name)}</b>"`;
      toast.onclick = () => { setActiveTab("groups"); renderList(); toast.remove(); };
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 5000);
    }
    else if (msg.type === "dm:typing") {
      if (activeChatUserId === msg.sender_id) {
        const ind = $("typingIndicator");
        if (ind) { ind.textContent = msg.is_typing ? "typing..." : ""; ind.classList.toggle("hidden", !msg.is_typing); }
      }
    }
    else if (msg.type === "dm:seen") {
      if (activeChatUserId === msg.reader_id) {
        document.querySelectorAll(".msg-status.mine").forEach(el => { el.textContent = "✓✓"; el.classList.add("text-cyan-400"); });
      }
    }
    else if (msg.type === "dm:error") { alert(msg.error); }
    else if (msg.type === "balance:update") {
        const toast = document.createElement("div");
        toast.className = "fixed top-4 left-1/2 -translate-x-1/2 z-[999] bg-amber-500 text-slate-900 px-6 py-3 rounded-full shadow-2xl font-bold animate-bounce flex items-center gap-2";
        toast.innerHTML = `🪙 Balance updated: <b>${msg.new_balance} PC</b>`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
        const balanceEl = document.getElementById("tokens"); 
        if (balanceEl) balanceEl.textContent = msg.new_balance;
    }
    else if (msg.type === "dm:reaction") {
        const msgWrap = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
        if (msgWrap) {
            let reactBar = msgWrap.querySelector(".reaction-bar");
            if (!reactBar && msg.action === "add") {
                reactBar = document.createElement("div");
                reactBar.className = "reaction-bar flex flex-wrap gap-1 mt-1 absolute -bottom-3 right-0 bg-slate-900 border border-slate-700 rounded-full px-2 py-0.5 shadow-lg z-10";
                msgWrap.appendChild(reactBar);
            }
            
            if (reactBar) {
                if (msg.action === "add") {
                    const existing = reactBar.querySelector(`[data-user="${msg.user_id}"]`);
                    if (existing) existing.remove(); // Remove old emoji from same user
                    
                    const span = document.createElement("span");
                    span.className = "text-xs reaction-item";
                    span.dataset.user = msg.user_id;
                    span.dataset.emoji = msg.emoji;
                    span.textContent = msg.emoji;
                    reactBar.appendChild(span);
                } else {
                    const existing = reactBar.querySelector(`[data-user="${msg.user_id}"][data-emoji="${msg.emoji}"]`);
                    if (existing) existing.remove();
                }
                if (reactBar.children.length === 0) reactBar.remove();
            }
        }
    }
    else if (msg.type === "call:offer") showIncomingCall(msg.sender_id, msg.offer, !!msg.is_video);
    else if (msg.type === "call:answer") {
      if (pc) { clearTimeout(callTimeout); pc.setRemoteDescription(new RTCSessionDescription(msg.answer)); }
    }
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
function crownMark(isPremium) { return isPremium ? ' <span class="text-amber-400 text-xs">👑</span>' : ""; }

function openChatPanel() { document.body.classList.add("chat-open"); }
function closeChatPanel() {
  document.body.classList.remove("chat-open");
  activeChatUserId = null;
  activeGroupId = null;
  $("chatMessages").innerHTML = "";
  $("chatHeaderContent").innerHTML = `<div class="text-sm text-slate-400">Select a conversation</div>`;
  $("chatForm")?.classList.add("hidden");
  renderList();
}
$("mobileBack")?.addEventListener("click", closeChatPanel);

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setActiveTab(btn.dataset.tab);
    renderList();
  });
});

let searchTimeout = null;
$("searchInput")?.addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (!q) { searchResults = []; renderList(); return; }
  searchTimeout = setTimeout(async () => { try { searchResults = await api.searchUsers(q); renderList(); } catch (err) { console.error(err); } }, 300);
});

function renderList() {
  const list = $("listArea");
  if (!list) return;

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

  if (activeTab === "groups") {
    if (groups.length === 0) { list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No groups yet. Click + to create one.</div>`; return; }
    list.innerHTML = groups.map((g) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50 cursor-pointer" data-group-chat="${g.id}" data-group-name="${escapeHTML(g.name)}">
        <div class="h-10 w-10 rounded-full bg-slate-700 flex items-center justify-center text-lg">👥</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-slate-200 truncate">${escapeHTML(g.name)}</div>
          <div class="text-xs text-slate-500">${g.member_count} members</div>
        </div>
        <button class="text-xs px-2 py-1.5 rounded bg-slate-800 border border-slate-700 hover:bg-brand-600 text-white font-bold transition">Open</button>
      </div>`).join("");
    wireGroupRows(); return;
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

function wireGroupRows() {
  document.querySelectorAll("[data-group-chat]").forEach((row) => {
    row.addEventListener("click", () => openGroupChat(row.dataset.groupChat, row.dataset.groupName));
  });
}

// ---------------------------------------------------------
// 3. CHAT ROOM LOGIC
// ---------------------------------------------------------
async function openChat(userId, username, avatarId, isPremium) {
  activeChatUserId = userId;
  activeGroupId = null;
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

  $("chatForm")?.classList.remove("hidden");
  await loadMessages();

  if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
  $("chatInput")?.focus();

  if ($("startAudioCallBtn")) $("startAudioCallBtn").onclick = () => initiateCall(userId, false, username, avatarId, isPremium);
  if ($("startVideoCallBtn")) $("startVideoCallBtn").onclick = () => initiateCall(userId, true, username, avatarId, isPremium);
  if ($("inviteGameBtn")) $("inviteGameBtn").onclick = () => showChallengeModal(userId, username);
}

async function openGroupChat(groupId, groupName) {
  activeGroupId = groupId;
  activeChatUserId = null;
  openChatPanel();

  $("chatHeaderContent").innerHTML = `
    <div class="flex items-center gap-3">
      <div class="h-10 w-10 rounded-full bg-slate-700 flex items-center justify-center text-lg">👥</div>
      <div class="text-sm font-bold text-slate-100">${escapeHTML(groupName)}</div>
    </div>`;

  $("chatForm")?.classList.remove("hidden");

  try {
    const msgs = await api.request(`/api/v1/groups/${groupId}/messages`);
    const el = $("chatMessages");
    el.innerHTML = "";
    for (const m of msgs) addMessageToUI(m);
    el.scrollTop = el.scrollHeight;
  } catch (err) { console.error(err); }

  $("chatInput")?.focus();
}

async function loadMessages() {
  if (!activeChatUserId) return;
  try {
    const msgs = await api.getConversation(activeChatUserId);
    const el = $("chatMessages");
    el.innerHTML = "";
    for (const m of msgs) addMessageToUI(m);
    el.scrollTop = el.scrollHeight;
  } catch (err) { console.error(err); }
}

function addMessageToUI(m) {
  const el = $("chatMessages");
  if (!el) return;
  
  const mine = m.sender_id === myId;

  const wrap = document.createElement("div");
  wrap.className = `relative flex flex-col ${mine ? "items-end" : "items-start"} mb-2 chat-bubble`;
  wrap.dataset.msgId = m.id;

  let senderHtml = "";
  if (m.group_id && !mine) {
    const name = m.sender_username || friends.find(f => String(f.id) === String(m.sender_id))?.username || "Member";
    senderHtml = `<div class="text-[10px] text-cyber-cyan font-bold mb-0.5 px-1">${escapeHTML(name)}</div>`;
  }

  let replyHtml = m.reply_to_status_id ? `<div class="text-[10px] text-brand-400 mb-1 px-2 border-l-2 border-brand-500">Replied to a status</div>` : "";

  let contentHtml = "";
  if (m.media_url && m.media_url.startsWith("challenge:")) {
      const parts = m.media_url.split(":");
      const roomCode = parts[2];
      contentHtml = `
        <div class="rounded-xl border-2 border-cyber-pink bg-slate-900 p-4 min-w-[220px] shadow-[0_0_20px_rgba(236,72,153,0.3)]">
            <div class="text-center mb-3">
                <span class="text-3xl">⚔️</span>
                <div class="text-white font-bold text-sm mt-1">${escapeHTML(m.content)}</div>
            </div>
            <button onclick="window.location.href='/room?id=${roomCode}'" class="w-full bg-cyber-pink hover:bg-pink-500 text-white font-bold py-2 rounded-lg transition shadow-lg">Join Match</button>
        </div>
      `;
  } 
  else if (m.media_url && m.media_url.startsWith("gift:")) {
      const amount = m.media_url.split(":")[1];
      contentHtml = `
        <div class="rounded-2xl border-2 border-amber-400 bg-gradient-to-br from-amber-500/20 to-slate-900 p-4 min-w-[200px] shadow-[0_0_20px_rgba(245,158,11,0.3)]">
            <div class="text-center">
                <span class="text-4xl drop-shadow-[0_0_10px_rgba(245,158,11,0.8)]">🎁</span>
                <div class="text-amber-400 font-black text-2xl mt-1">${amount} PC</div>
                <div class="text-[10px] text-slate-300 uppercase tracking-widest mt-1">${mine ? "Gift Sent" : "Gift Received"}</div>
            </div>
        </div>
      `;
  }
  else if (m.content && (m.content.includes("Missed audio call") || m.content.includes("Missed video call"))) {
    contentHtml = `<div class="text-sm font-bold text-red-400 flex items-center gap-2"><span>📞</span> ${escapeHTML(m.content)}</div>`;
  } 
  else if (m.content) {
    contentHtml = `<div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"}">${escapeHTML(m.content)}</div>`;
  }

  let mediaHtml = "";
  if (m.media_url && !m.media_url.startsWith("challenge:") && !m.media_url.startsWith("gift:")) {
    const safeUrl = escapeHTML(m.media_url);
    if (m.media_url.match(/\.(mp4|webm|ogg|mov|mp3|wav|m4a)$/i)) {
      mediaHtml = `<audio src="${safeUrl}" controls class="mt-2 w-48"></audio>`;
    } else {
      mediaHtml = `<img src="${safeUrl}" class="max-w-[200px] rounded-xl mt-1 border border-slate-700" />`;
    }
  }

  let statusHtml = mine ? `<div class="text-[10px] text-slate-500 mt-0.5"><span class="msg-status mine">${m.read ? "✓✓" : "✓"}</span> · ${timeAgo(m.created_at)}</div>` : `<div class="text-[10px] text-slate-500 mt-0.5">${timeAgo(m.created_at)}</div>`;

  if (m.read && mine) {
    setTimeout(() => { const s = wrap.querySelector('.msg-status'); if (s) s.classList.add("text-cyan-400"); }, 10);
  }

  wrap.innerHTML = `${senderHtml}${replyHtml}${contentHtml}${mediaHtml}${statusHtml}`;

  // --- RENDER REACTIONS ---
  if (m.reactions && m.reactions.length > 0) {
      const reactBar = document.createElement("div");
      reactBar.className = "reaction-bar flex flex-wrap gap-1 mt-1 absolute -bottom-3 right-0 bg-slate-900 border border-slate-700 rounded-full px-2 py-0.5 shadow-lg z-10";
      m.reactions.forEach(r => {
          const span = document.createElement("span");
          span.className = "text-xs reaction-item";
          span.dataset.user = r.user_id;
          span.dataset.emoji = r.emoji;
          span.textContent = r.emoji;
          reactBar.appendChild(span);
      });
      wrap.appendChild(reactBar);
  }
  
  wrap.addEventListener("dblclick", (e) => showEmojiPicker(e, m.id));
  
  let pressTimer;
  wrap.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => showEmojiPicker(e, m.id), 500);
  }, { passive: true });
  wrap.addEventListener("touchend", () => clearTimeout(pressTimer));
  wrap.addEventListener("touchmove", () => clearTimeout(pressTimer));

  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
}

// --- EMOJI PICKER LOGIC ---
function showEmojiPicker(e, messageId) {
    e.preventDefault();
    e.stopPropagation();
    
    document.querySelectorAll(".emoji-picker").forEach(el => el.remove());

    const picker = document.createElement("div");
    picker.className = "emoji-picker fixed z-[999] bg-slate-800 border border-slate-700 rounded-full shadow-2xl flex gap-1 p-1 animate-[pop_0.2s_ease-out]";
    
    const x = e.clientX || (e.touches && e.touches[0].clientX) || e.pageX;
    const y = e.clientY || (e.touches && e.touches[0].clientY) || e.pageY;
    picker.style.left = `${x - 100}px`;
    picker.style.top = `${y - 50}px`;

    EMOJIS.forEach(emoji => {
        const btn = document.createElement("button");
        btn.className = "text-2xl hover:scale-125 transition p-1";
        btn.textContent = emoji;
        btn.onclick = (ev) => {
            ev.stopPropagation();
            if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
                dmSocket.send(JSON.stringify({ type: "dm:react", message_id: messageId, emoji }));
            }
            picker.remove();
        };
        picker.appendChild(btn);
    });

    document.body.appendChild(picker);

    setTimeout(() => {
        const closePicker = () => { picker.remove(); document.removeEventListener("click", closePicker); };
        document.addEventListener("click", closePicker);
    }, 10);
}

$("chatInput")?.addEventListener("input", () => {
  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN || !activeChatUserId) return;
  const target = activeChatUserId;
  dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: target, is_typing: true }));
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: target, is_typing: false })); }, 2000);
});

function currentTarget() { return { groupId: activeGroupId, userId: activeChatUserId }; }

function sendToTarget(target, { content = "", media_url = null }) {
  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN) throw new Error("Not connected");
  if (target.groupId) {
    dmSocket.send(JSON.stringify({ type: "group:send", group_id: target.groupId, content, media_url }));
  } else if (target.userId) {
    dmSocket.send(JSON.stringify({ type: "dm:send", target_id: target.userId, content, media_url }));
  }
}

async function uploadMedia(file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/v1/dm/upload", {
    method: "POST",
    headers: { "Authorization": "Bearer " + api.getToken() },
    body: formData
  });
  if (!res.ok) throw new Error("Upload failed");
  const data = await res.json();
  return data.url;
}

$("chatForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || (!activeChatUserId && !activeGroupId)) return;

  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN) {
    alert("Connecting to chat server... Please wait a second.");
    return;
  }

  $("chatInput").value = "";
  const target = currentTarget();
  sendToTarget(target, { content: text });
  if (target.userId) {
    dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: target.userId, is_typing: false }));
  }
});

$("chatImageInput")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const target = currentTarget();
  e.target.value = "";
  if (!file || (!target.userId && !target.groupId)) return;

  try {
    const url = await uploadMedia(file);
    sendToTarget(target, { media_url: url });
  } catch (err) {
    alert("Could not upload image.");
  }
});

// --- COIN GIFT MODAL LOGIC ---
$("giftBtn")?.addEventListener("click", () => {
    if (!activeChatUserId) return; 
    
    const modal = document.createElement("div");
    modal.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
    modal.innerHTML = `
      <div class="w-full max-w-xs bg-slate-900 rounded-2xl p-5 border border-slate-700 shadow-2xl text-center">
        <h3 class="text-white font-bold text-lg mb-2">Send PlayCoins 🪙</h3>
        <p class="text-slate-400 text-xs mb-4">Support your friend with a gift!</p>
        
        <input type="number" id="giftAmountInput" min="1" placeholder="Amount (e.g. 50)" class="w-full bg-slate-800 text-white text-center text-xl font-bold rounded-lg p-3 mb-4 focus:outline-none border border-slate-700 focus:border-amber-400" />
        
        <div class="flex gap-2">
          <button id="cancelGiftBtn" class="flex-1 py-2.5 rounded-lg bg-slate-800 text-slate-300 font-bold text-sm">Cancel</button>
          <button id="sendGiftBtn" class="flex-1 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold text-sm shadow-[0_0_15px_rgba(245,158,11,0.4)]">Send Gift</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector("#cancelGiftBtn").onclick = () => modal.remove();
    modal.querySelector("#sendGiftBtn").onclick = () => {
        const amount = parseInt(modal.querySelector("#giftAmountInput").value, 10);
        if (isNaN(amount) || amount <= 0) return alert("Enter a valid amount");
        
        if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
            dmSocket.send(JSON.stringify({ type: "dm:gift", target_id: activeChatUserId, amount }));
            modal.remove();
        }
    };
});

// --- CREATE GROUP MODAL LOGIC ---
$("createGroupBtn")?.addEventListener("click", () => {
  if (friends.length === 0) return alert("Add friends first to create a group.");

  const modal = document.createElement("div");
  modal.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
  modal.innerHTML = `
    <div class="w-full max-w-sm bg-slate-900 rounded-2xl p-5 border border-slate-700 shadow-2xl">
      <h3 class="text-white font-bold text-lg mb-4">Create Group</h3>
      <input type="text" id="groupNameInput" placeholder="Group Name" maxlength="50" class="w-full bg-slate-800 text-white rounded-lg p-3 text-sm focus:outline-none border border-slate-700 mb-4" />
      <div class="max-h-48 overflow-y-auto mb-4 space-y-2">
        ${friends.map(f => `
          <label class="flex items-center gap-3 p-2 rounded bg-slate-800/50 cursor-pointer hover:bg-slate-800">
            <input type="checkbox" value="${f.id}" class="group-member-cb w-4 h-4 accent-brand-500">
            ${avatarHTML(f.avatar_id, "sm")}
            <span class="text-sm text-white">${escapeHTML(f.username)}</span>
          </label>
        `).join("")}
      </div>
      <div class="flex gap-2">
        <button id="cancelGroupBtn" class="flex-1 py-2.5 rounded-lg bg-slate-800 text-slate-300 font-bold text-sm">Cancel</button>
        <button id="createGroupSubmit" class="flex-1 py-2.5 rounded-lg bg-brand-600 text-white font-bold text-sm">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("#cancelGroupBtn").onclick = () => modal.remove();
  modal.querySelector("#createGroupSubmit").onclick = async () => {
    const name = modal.querySelector("#groupNameInput").value.trim();
    const selected = Array.from(modal.querySelectorAll(".group-member-cb:checked")).map(cb => cb.value);

    if (!name || selected.length === 0) return alert("Enter name and select members.");

    try {
      await api.request("/api/v1/groups", { method: "POST", body: { name, member_ids: selected } });
      modal.remove();
      setActiveTab("groups");
      await refreshAll();
      renderList();
    } catch (err) {
      alert("Failed to create group: " + err.message);
    }
  };
});

// --- GAME CHALLENGE MODAL ---
async function showChallengeModal(userId, username) {
  const games = [
    { slug: "ludo",  name: "Ludo",  icon: "🎲", max: 2 },
    { slug: "chess", name: "Chess", icon: "♟️", max: 2 },
    { slug: "whot",  name: "Whot",  icon: "🃏", max: 2 },
  ];

  const modal = document.createElement("div");
  modal.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
  modal.innerHTML = `
    <div class="w-full max-w-sm bg-slate-900 rounded-2xl p-5 border border-cyber-pink/50 shadow-[0_0_40px_rgba(236,72,153,0.3)]">
      <h3 class="text-white font-bold text-lg mb-1">Challenge ${escapeHTML(username)} ⚔️</h3>
      <p class="text-slate-400 text-xs mb-4">Pick a game — we'll create a private room and send the invite.</p>

      <div class="grid grid-cols-3 gap-2 mb-4">
        ${games.map(g => `
          <button data-game="${g.slug}" data-name="${g.name}" data-max="${g.max}"
            class="game-pick-btn flex flex-col items-center gap-1 p-3 rounded-xl bg-slate-800 border-2 border-slate-700 hover:border-cyber-pink transition">
            <span class="text-2xl">${g.icon}</span>
            <span class="text-[10px] text-white font-bold">${escapeHTML(g.name)}</span>
          </button>
        `).join("")}
      </div>

      <label class="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Wager (optional, PlayCoins)</label>
      <input type="number" id="challengeWager" min="0" max="10000" value="0" placeholder="0"
        class="w-full bg-slate-800 text-white text-center text-sm font-bold rounded-lg p-2.5 mb-4 focus:outline-none border border-slate-700 focus:border-cyber-pink" />

      <button id="cancelChallengeBtn" class="w-full py-2.5 rounded-lg bg-slate-800 text-slate-300 font-bold text-sm">Cancel</button>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector("#cancelChallengeBtn").onclick = () => modal.remove();

  modal.querySelectorAll(".game-pick-btn").forEach(btn => {
    btn.onclick = async () => {
      const gameSlug = btn.dataset.game;
      const gameName = btn.dataset.name;
      const maxPlayers = parseInt(btn.dataset.max, 10) || 2;
      const wagerInput = modal.querySelector("#challengeWager");
      let wager = parseInt(wagerInput.value, 10);
      if (isNaN(wager) || wager < 0) wager = 0;
      if (wager > 10000) wager = 10000;

      btn.disabled = true;
      btn.classList.add("opacity-50");

      try {
        // 1. Create a private room
        const room = await api.request("/api/v1/rooms", {
          method: "POST",
          body: { game_slug: gameSlug, max_players: maxPlayers, wager, is_public: false }
        });
        const roomCode = room.code;
        if (!roomCode) throw new Error("No room code returned from server");

        // 2. Send the challenge over the DM socket
        if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN) {
          throw new Error("Chat socket not connected — wait a second and try again");
        }
        dmSocket.send(JSON.stringify({
          type: "dm:challenge",
          target_id: userId,
          content: `invited you to play ${gameName}${wager > 0 ? ` for ${wager} PC` : ""}!`,
          game_slug: gameSlug,
          room_code: roomCode
        }));

        modal.remove();

        const toast = document.createElement("div");
        toast.className = "fixed top-4 left-1/2 -translate-x-1/2 z-[999] bg-cyber-pink text-white px-6 py-3 rounded-full shadow-2xl font-bold animate-bounce";
        toast.textContent = `⚔️ Challenge sent to ${username}!`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      } catch (err) {
        alert("Could not send challenge: " + err.message);
        btn.disabled = false;
        btn.classList.remove("opacity-50");
      }
    };
  });
}

// --- VOICE NOTE LOGIC ---
$("voiceNoteBtn")?.addEventListener("click", async () => {
  if (!activeChatUserId && !activeGroupId && !isRecording) return;

  if (isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    $("micIcon").textContent = "🎤";
    $("micIcon").classList.remove("text-red-500", "animate-pulse");
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      recordingTarget = currentTarget();

      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const target = recordingTarget;
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const file = new File([audioBlob], "voice_note.webm", { type: "audio/webm" });

        try {
          const url = await uploadMedia(file);
          sendToTarget(target, { media_url: url });
        } catch (err) {
          alert("Could not upload voice note.");
        }
      };

      mediaRecorder.start();
      isRecording = true;
      $("micIcon").textContent = "⏹️";
      $("micIcon").classList.add("text-red-500", "animate-pulse");
    } catch (err) {
      alert("Microphone access denied. Check browser permissions.");
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
        <div class="text-white font-bold text-2xl flex items-center justify-center gap-2">${escapeHTML(targetName)} ${isPremium ? "👑" : ""}</div>
        <div id="callTimer" class="text-slate-400 text-sm mt-1">Connecting...</div>
      </div>
      <button class="opacity-0 w-12 h-12"></button>
    </div>
  `;

  let audioHtml = `<audio id="remoteAudio" autoplay playsinline></audio>`;

  if (isVideo) {
    overlay.innerHTML = `
      ${audioHtml}
      <video id="remoteVideo" autoplay playsinline class="absolute inset-0 w-full h-full object-cover z-0"></video>
      ${header}
      <video id="localVideo" autoplay playsinline muted class="absolute top-20 right-4 w-28 h-40 object-cover rounded-2xl border-2 border-slate-700 shadow-2xl z-20 transition-all"></video>
      <div class="relative z-10 mb-8 bg-[#1f2c33]/90 backdrop-blur-md px-6 py-4 rounded-full flex items-center gap-6 shadow-2xl">
        <button id="btnToggleVideo" class="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">📹</button>
        <button id="btnMute" class="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">🎤</button>
        <button id="btnEnd" class="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white text-2xl shadow-lg shadow-red-500/50">📞</button>
      </div>
    `;
  } else {
    overlay.innerHTML = `
      ${audioHtml}
      <div class="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
      ${header}
      <div class="relative z-10 flex-1 flex flex-col items-center justify-center">
        <div class="w-40 h-40 rounded-full border-4 border-slate-700 overflow-hidden shadow-[0_0_50px_rgba(255,255,255,0.1)]">${avatarHTML(targetAvatar, "xl")}</div>
      </div>
      <div class="relative z-10 mb-12 bg-[#1f2c33]/90 backdrop-blur-md w-11/12 max-w-sm px-6 py-6 rounded-3xl grid grid-cols-3 gap-6 shadow-2xl">
        <div class="flex flex-col items-center gap-2"><button class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">🔊</button><span class="text-xs text-slate-300">Speaker</span></div>
        <div class="flex flex-col items-center gap-2"><button id="btnToggleVideo" class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">📹</button><span class="text-xs text-slate-300">Video</span></div>
        <div class="flex flex-col items-center gap-2"><button id="btnMute" class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">🎤</button><span class="text-xs text-slate-300">Mute</span></div>
        <div class="flex flex-col items-center gap-2 mt-2"><button class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">•••</button><span class="text-xs text-slate-300">More</span></div>
        <div class="flex flex-col items-center gap-2 mt-2"><button class="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-white text-xl">↗</button><span class="text-xs text-slate-300">Share</span></div>
        <div class="flex flex-col items-center gap-2 mt-2"><button id="btnEnd" class="w-14 h-14 rounded-full bg-red-500 flex items-center justify-center text-white text-xl shadow-lg shadow-red-500/50">📞</button><span class="text-xs text-slate-300 text-red-500 font-bold">End</span></div>
      </div>
    `;
  }
  document.body.appendChild(overlay);

  setTimeout(() => {
      const audioEl = $("remoteAudio");
      if (audioEl && remoteStream) {
          audioEl.srcObject = remoteStream;
          audioEl.play().catch(e => {
              const prompt = document.createElement("div");
              prompt.className = "absolute inset-0 z-[9999] bg-black/80 flex items-center justify-center text-white font-bold text-lg cursor-pointer";
              prompt.textContent = "Tap to unmute";
              prompt.onclick = () => { audioEl.play(); prompt.remove(); };
              overlay.appendChild(prompt);
          });
      }
  }, 500);

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

  $("btnToggleVideo").onclick = async () => {
      if (!localStream) return;
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
          videoTrack.enabled = false;
          if ($("localVideo")) $("localVideo").style.display = "none";
          if ($("remoteVideo")) $("remoteVideo").style.display = "none";
          $("btnToggleVideo").textContent = "📹";
      } else {
          try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: true });
              const newVideoTrack = stream.getVideoTracks()[0];
              localStream.addTrack(newVideoTrack);
              if (pc) {
                  const senders = pc.getSenders();
                  const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                  if (videoSender) videoSender.replaceTrack(newVideoTrack);
                  else pc.addTrack(newVideoTrack, localStream);
              }
              if ($("localVideo")) { $("localVideo").style.display = "block"; $("localVideo").srcObject = localStream; }
              if ($("remoteVideo")) $("remoteVideo").style.display = "block";
              $("btnToggleVideo").textContent = "📵";
          } catch (e) { alert("Camera access denied."); }
      }
  };
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

    pc = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(event.track);
      if ($("remoteVideo")) $("remoteVideo").srcObject = remoteStream;
      
      const audioEl = $("remoteAudio");
      if (audioEl) { 
          audioEl.srcObject = remoteStream; 
          audioEl.play().catch(e => console.log("Autoplay blocked", e)); 
      }
      
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
        if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
          dmSocket.send(JSON.stringify({ type: "call:end", target_id: targetId, call_type: isVideo ? 'video' : 'audio', is_missed: true }));
        }
        endCall();
      }
    }, 30000);

  } catch (err) {
    console.error("WEBCAM ERROR:", err);
    if (err.name === 'NotAllowedError') {
      alert("You blocked the camera/microphone. Click the Lock icon in the URL bar and allow them.");
    } else {
      alert("Could not access camera/microphone: " + err.message);
    }
    endCall();
  }
}

function showIncomingCall(senderId, offer, isVideo) {
  playRingtone();
  const modal = document.createElement("div");
  incomingCallModal = modal;
  modal.className = "fixed inset-0 z-[9999] bg-[#0b141a] flex flex-col items-center justify-between p-8";
  const caller = friends.find(f => String(f.id) === String(senderId)) || { username: "Unknown", avatar_id: "fox", is_premium: false };

  modal.innerHTML = `
    <div class="text-center mt-12 w-full">
      <div class="text-slate-400 text-sm mb-2">Incoming ${isVideo ? 'Video' : 'Audio'} Call...</div>
      <div class="w-40 h-40 mx-auto rounded-full border-4 border-slate-700 overflow-hidden shadow-2xl animate-pulse">${avatarHTML(caller.avatar_id, "xl", null, caller.is_premium)}</div>
      <div class="text-white font-bold text-3xl mt-6">${escapeHTML(caller.username)}</div>
    </div>
    <div class="w-full max-w-sm flex justify-between mb-12">
      <div class="flex flex-col items-center gap-2">
        <button id="rejectCallBtn" class="bg-red-500 w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl shadow-xl hover:scale-105 transition">✖</button>
        <span class="text-xs text-slate-400 font-bold">Decline</span>
      </div>
      <div class="flex flex-col items-center gap-2">
        <button id="acceptCallBtn" class="bg-emerald-500 w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl shadow-xl animate-bounce hover:scale-105 transition">📞</button>
        <span class="text-xs text-slate-400 font-bold">Accept</span>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  $("rejectCallBtn").onclick = () => {
    stopRingtone();
    if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "call:reject", target_id: senderId, call_type: isVideo ? 'video' : 'audio' }));
    modal.remove();
    incomingCallModal = null;
  };

  $("acceptCallBtn").onclick = async () => {
    stopRingtone();
    modal.remove();
    incomingCallModal = null;
    currentCallTargetId = senderId;
    isVideoCall = isVideo;

    createVideoOverlay(isVideo, caller.username, caller.avatar_id, caller.is_premium);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
      if ($("localVideo")) $("localVideo").srcObject = localStream;

      pc = new RTCPeerConnection(ICE_SERVERS);
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = (event) => {
        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
        if ($("remoteVideo")) $("remoteVideo").srcObject = remoteStream;
        
        const audioEl = $("remoteAudio");
        if (audioEl) { 
            audioEl.srcObject = remoteStream; 
            audioEl.play().catch(e => console.log("Autoplay blocked", e)); 
        }
        
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
      alert("Camera/Microphone access denied. Check browser permissions.");
      endCall();
    }
  };
}

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
  clearTimeout(callTimeout); callTimeout = null;
  stopRingtone(); stopCallTimer();
  if (incomingCallModal) { incomingCallModal.remove(); incomingCallModal = null; }
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
let groupedStories = {};

async function renderStories() {
  let bar = $("storyBar");
  if (!bar) {
    const listPanel = $("listPanel");
    const searchDiv = listPanel?.querySelector(".p-4.border-b");
    if (searchDiv) {
      bar = document.createElement("div");
      bar.id = "storyBar";
      bar.className = "flex gap-3 overflow-x-auto p-3 border-b border-slate-800 scrollbar-hide";
      searchDiv.after(bar);
    }
  }
  if (!bar) return;

  try { statuses = await api.request("/api/v1/friends/status/feed"); } catch (e) { statuses = []; }

  groupedStories = {};
  statuses.forEach(s => {
    if (!groupedStories[s.user_id]) groupedStories[s.user_id] = { ...s, items: [] };
    groupedStories[s.user_id].items.push(s);
  });

  let html = `
    <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer" id="addStatusBtn">
      <div class="w-14 h-14 rounded-full border-2 border-slate-700 bg-slate-800 flex items-center justify-center text-xl text-slate-400 hover:border-brand-500 transition">+</div>
      <div class="text-[10px] text-slate-400 font-bold">Add</div>
    </div>
  `;

  Object.entries(groupedStories).forEach(([uid, group]) => {
    const isSelf = group.relation === "self";
    const ringClass = isSelf ? "border-slate-500" : "border-brand-500";
    html += `
      <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer view-status-btn" data-uid="${escapeHTML(uid)}">
        <div class="w-14 h-14 rounded-full border-2 ${ringClass} p-0.5">${avatarHTML(group.avatar_id, "md")}</div>
        <div class="text-[10px] text-slate-300 font-bold truncate w-14 text-center">${isSelf ? "You" : escapeHTML(group.username)}</div>
      </div>
    `;
  });

  bar.innerHTML = html;

  bar.querySelectorAll(".view-status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = groupedStories[btn.dataset.uid];
      if (group) showStatusSlideshow(group.items);
    });
  });

  $("addStatusBtn")?.addEventListener("click", showCreateStatusModal);
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
      const safeUrl = escapeHTML(status.media_url);
      if (status.media_url.match(/\.(mp4|webm|ogg|mov)$/i)) mediaHTML = `<video src="${safeUrl}" controls autoplay class="w-full h-full object-contain"></video>`;
      else mediaHTML = `<img src="${safeUrl}" class="w-full h-full object-contain" />`;
    }

    let viewCountHtml = status.relation === "self" && status.viewers ? `<div class="text-xs text-slate-300 mt-1">👁️ ${status.viewers.length} views</div>` : "";

    overlay.innerHTML = `
      <div class="w-full max-w-sm h-full sm:h-[80vh] sm:rounded-2xl bg-slate-900 relative overflow-hidden flex flex-col">
        <div class="absolute top-4 left-4 right-4 flex gap-1 z-20">
          ${items.map((_, i) => `<div class="h-1 flex-1 bg-white/30 rounded-full overflow-hidden"><div class="h-full bg-white transition-all duration-3000 ${i <= currentIndex ? 'w-full' : 'w-0'}"></div></div>`).join("")}
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

        ${status.relation === "self" ? "" : `
        <div class="absolute bottom-4 left-4 right-4 z-20">
          <input type="text" id="statusReplyInput" placeholder="Reply to story..." class="w-full bg-white/10 backdrop-blur-md border border-white/20 text-white rounded-full px-4 py-2 text-sm focus:outline-none" />
        </div>
        `}
      </div>
    `;

    overlay.querySelector("#closeStoryBtn").addEventListener("click", () => { clearTimeout(overlay._timeout); overlay.remove(); });
    overlay.querySelector("#tapLeft").addEventListener("click", () => { if (currentIndex > 0) { currentIndex--; renderSlide(); } });
    overlay.querySelector("#tapRight").addEventListener("click", () => {
      if (currentIndex < items.length - 1) { currentIndex++; renderSlide(); }
      else { clearTimeout(overlay._timeout); overlay.remove(); }
    });

    const replyInput = overlay.querySelector("#statusReplyInput");
    if (replyInput) {
      replyInput.addEventListener("focus", () => clearTimeout(overlay._timeout));
      replyInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = replyInput.value.trim();
          if (!val) return;
          if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
            dmSocket.send(JSON.stringify({ type: "dm:send", target_id: status.user_id, content: val, reply_to_status_id: status.id }));
            alert("Reply sent!");
            replyInput.value = ""; clearTimeout(overlay._timeout); overlay.remove();
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
      const res = await fetch("/api/v1/friends/status", { method: "POST", headers: { "Authorization": "Bearer " + api.getToken() }, body: formData });
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
  const [f, r, c, g] = await Promise.allSettled([
    api.listFriends(),
    api.listFriendRequests(),
    api.listConversations(),
    api.request("/api/v1/groups")
  ]);
  if (f.status === "fulfilled") friends = f.value; else console.error("friends:", f.reason);
  if (r.status === "fulfilled") requests = r.value; else console.error("requests:", r.reason);
  if (c.status === "fulfilled") conversations = c.value; else console.error("conversations:", c.reason);
  if (g.status === "fulfilled") groups = g.value; else { groups = []; console.warn("groups:", g.reason); }

  const badge = $("reqBadge");
  if (badge) {
    if (requests.length > 0) { badge.textContent = String(requests.length); badge.classList.remove("hidden"); }
    else { badge.classList.add("hidden"); }
  }
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

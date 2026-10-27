import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null, myId = null, activeTab = "friends", activeChatUserId = null;
let activeGroupId = null; // <-- NEW
let friends = [], requests = [], conversations = [], groups = [], searchResults = [], statuses = []; // <-- Added groups
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
    else if (msg.type === "group:new") {
      if (activeGroupId === msg.group_id) {
        addMessageToUI(msg);
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
        document.querySelectorAll(".msg-status.mine").forEach(el => { el.textContent = "✓✓"; el.classList.add("text-cyan-400"); });
      }
    }
    else if (msg.type === "call:offer") showIncomingCall(msg.sender_id, msg.offer);
    else if (msg.type === "call:answer") { 
        if (pc) {
            clearTimeout(callTimeout); 
            pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        }
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
  activeGroupId = null; // <-- Reset group
  $("chatMessages").innerHTML = "";
  $("chatHeaderContent").innerHTML = `<div class="text-sm text-slate-400">Select a conversation</div>`;
  $("chatForm").classList.add("hidden");
  renderList();
}
$("mobileBack").addEventListener("click", closeChatPanel);

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => { b.className = b.dataset.tab === activeTab ? "tab-btn flex-shrink-0 px-4 py-4 text-cyber-cyan border-b-2 border-cyber-cyan bg-cyber-cyan/5 transition" : "tab-btn flex-shrink-0 px-4 py-4 text-slate-500 hover:text-slate-300 transition"; });
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

  // --- NEW: GROUPS TAB ---
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
  activeGroupId = null; // <-- Reset group
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

  if (dmSocket && dmSocket.readyState === WebSocket.OPEN) dmSocket.send(JSON.stringify({ type: "dm:seen", target_id: activeChatUserId }));
  $("chatInput").focus();
  
  $("startAudioCallBtn").onclick = () => initiateCall(userId, false, username, avatarId, isPremium);
  $("startVideoCallBtn").onclick = () => initiateCall(userId, true, username, avatarId, isPremium);
}

async function openGroupChat(groupId, groupName) {
  activeGroupId = groupId;
  activeChatUserId = null; // <-- Reset DM
  openChatPanel();

  $("chatHeaderContent").innerHTML = `
    <div class="flex items-center gap-3">
      <div class="h-10 w-10 rounded-full bg-slate-700 flex items-center justify-center text-lg">👥</div>
      <div class="text-sm font-bold text-slate-100">${escapeHTML(groupName)}</div>
    </div>`;

  $("chatForm").classList.remove("hidden");
  
  // Load group messages
  try {
    const msgs = await api.request(`/api/v1/groups/${groupId}/messages`);
    const el = $("chatMessages");
    el.innerHTML = "";
    for (const m of msgs) { addMessageToUI(m); }
    el.scrollTop = el.scrollHeight;
  } catch (err) { console.error(err); }
  
  $("chatInput").focus();
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
  wrap.className = mine ? "flex flex-col items-end mb-2" : "flex flex-col items-start mb-2";
  
  let replyHtml = m.reply_to_status_id ? `<div class="text-[10px] text-brand-400 mb-1 px-2 border-l-2 border-brand-500">Replied to a status</div>` : "";

  let contentHtml = "";
  if (m.content && (m.content.includes("Missed audio call") || m.content.includes("Missed video call"))) {
      contentHtml = `<div class="text-sm font-bold text-red-400 flex items-center gap-2"><span>📞</span> ${escapeHTML(m.content)}</div>`;
  } else if (m.content) {
      contentHtml = `<div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"}">${escapeHTML(m.content)}</div>`;
  }

  let mediaHtml = "";
  if (m.media_url) {
      if (m.media_url.match(/\.(mp4|webm|ogg|mov|mp3|wav|m4a)$/i)) {
          mediaHtml = `<audio src="${m.media_url}" controls class="mt-2 w-48"></audio>`;
      } else {
          mediaHtml = `<img src="${m.media_url}" class="max-w-[200px] rounded-xl mt-1 border border-slate-700" />`;
      }
  }

  let statusHtml = mine ? `<div class="text-[10px] text-slate-500 mt-0.5"><span class="msg-status mine">${m.read ? "✓✓" : "✓"}</span> · ${timeAgo(m.created_at)}</div>` : `<div class="text-[10px] text-slate-500 mt-0.5">${timeAgo(m.created_at)}</div>`;
  
  if (m.read && mine) {
    setTimeout(() => { const s = wrap.querySelector('.msg-status'); if (s) s.classList.add("text-cyan-400"); }, 10);
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

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  
  if (!dmSocket || dmSocket.readyState !== WebSocket.OPEN) {
    alert("Connecting to chat server...");
    return;
  }

  $("chatInput").value = "";
  
  if (activeGroupId) {
      dmSocket.send(JSON.stringify({ type: "group:send", group_id: activeGroupId, content: text }));
  } else if (activeChatUserId) {
      dmSocket.send(JSON.stringify({ type: "dm:send", target_id: activeChatUserId, content: text }));
      dmSocket.send(JSON.stringify({ type: "dm:typing", target_id: activeChatUserId, is_typing: false }));
  }
});

// --- CREATE GROUP MODAL LOGIC ---
$("createGroupBtn").addEventListener("click", () => {
    if (friends.length === 0) return alert("Add friends first to create a group.");
    
    const modal = document.createElement("div");
    modal.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
    modal.innerHTML = `
      <div class="w-full max-w-sm bg-slate-900 rounded-2xl p-5 border border-slate-700 shadow-2xl">
        <h3 class="text-white font-bold text-lg mb-4">Create Group</h3>
        <input type="text" id="groupNameInput" placeholder="Group Name" class="w-full bg-slate-800 text-white rounded-lg p-3 text-sm focus:outline-none border border-slate-700 mb-4" />
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
            activeTab = "groups";
            document.querySelectorAll(".tab-btn").forEach((b) => { b.className = b.dataset.tab === activeTab ? "tab-btn flex-shrink-0 px-4 py-4 text-cyber-cyan border-b-2 border-cyber-cyan bg-cyber-cyan/5 transition" : "tab-btn flex-shrink-0 px-4 py-4 text-slate-500 hover:text-slate-300 transition"; });
            await refreshAll();
            renderList();
        } catch (e) {
            alert("Failed to create group: " + e.message);
        }
    };
});

// ... (The rest of the file: voice notes, uploads, WebRTC calls, stories all remain EXACTLY as they were in the previous working version) ...

async function refreshAll() {
  try {
    const promises = [api.listFriends(), api.listFriendRequests(), api.listConversations(), api.request("/api/v1/groups")];
    const results = await Promise.all(promises);
    friends = results[0]; requests = results[1]; conversations = results[2]; groups = results[3]; // <-- Fetch groups
    
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

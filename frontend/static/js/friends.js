import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

let me = null;
let myId = null;
let activeTab = "friends";
let activeChatUserId = null;
let friends = [];
let requests = [];
let conversations = [];
let searchResults = [];
let statuses = [];
let pollTimer = null;

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

function crownMark(isPremium) {
  return isPremium ? ' <span class="text-amber-400 text-xs">👑</span>' : "";
}

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
      if (b.dataset.tab === activeTab) {
        b.className = "tab-btn flex-1 py-3 text-brand-400 border-b-2 border-brand-500";
      } else {
        b.className = "tab-btn flex-1 py-3 text-slate-400 hover:text-slate-200";
      }
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
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold truncate">${escapeHTML(u.username)}${crownMark(u.is_premium)}</div>
            <div class="text-xs text-slate-500">Level ${u.level}</div>
          </div>
          ${action}
        </div>`;
    }).join("");
    wireRowButtons();
    return;
  }

  if (activeTab === "friends") {
    if (friends.length === 0) {
      list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No friends yet.<br><span class="text-xs">Search above to add someone.</span></div>`;
      return;
    }
    list.innerHTML = friends.map((f) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50">
        <div class="flex-shrink-0 cursor-pointer" data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}">
          ${avatarHTML(f.avatar_id, "sm", f.frame_color, f.is_premium)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold truncate flex items-center gap-1">
            ${escapeHTML(f.username)}${crownMark(f.is_premium)}
            ${f.streak_count > 0 ? `<span class="text-orange-500 font-bold text-[10px]" title="${f.streak_count} day streak">🔥 ${f.streak_count}</span>` : ""}
          </div>
          <div class="text-xs text-slate-500">Level ${f.level}</div>
        </div>
        <a href="/user?id=${f.id}" class="text-xs px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold transition">Profile</a>
        <button data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}" class="text-xs px-2 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white font-bold transition">Chat</button>
      </div>`).join("");
    wireFriendRows();
    return;
  }

  if (activeTab === "requests") {
    if (requests.length === 0) {
      list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No pending requests.</div>`;
      return;
    }
    list.innerHTML = requests.map((r) => `
      <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50">
        <div class="flex-shrink-0">${avatarHTML(r.avatar_id, "sm", r.frame_color, r.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold truncate">${escapeHTML(r.username)}${crownMark(r.is_premium)}</div>
          <div class="text-xs text-slate-500">Level ${r.level} · ${timeAgo(r.created_at)}</div>
        </div>
        <div class="flex gap-1">
          <button data-act="accept" data-id="${r.user_id}" class="text-xs px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700">✓</button>
          <button data-act="decline" data-id="${r.user_id}" class="text-xs px-2.5 py-1.5 rounded bg-slate-700 hover:bg-slate-600">✕</button>
        </div>
      </div>`).join("");
    wireRowButtons();
    return;
  }

  if (activeTab === "chats") {
    if (conversations.length === 0) {
      list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">No conversations yet.</div>`;
      return;
    }
    list.innerHTML = conversations.map((c) => `
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50 cursor-pointer" data-chat="${c.user_id}" data-username="${escapeHTML(c.username)}" data-avatar="${c.avatar_id}" data-premium="${c.is_premium ? '1' : '0'}">
        <div class="flex-shrink-0">${avatarHTML(c.avatar_id, "sm", c.frame_color, c.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <div class="text-sm font-semibold truncate flex items-center gap-1">
              ${escapeHTML(c.username)}${crownMark(c.is_premium)}
              ${c.streak > 0 ? `<span class="text-orange-500 font-bold text-[10px]">🔥 ${c.streak}</span>` : ""}
            </div>
            <div class="text-[10px] text-slate-500">${timeAgo(c.last_at)}</div>
          </div>
          <div class="flex items-center justify-between mt-0.5">
            <div class="text-xs text-slate-500 truncate">${escapeHTML(c.last_message)}</div>
            ${c.unread_count > 0 ? `<span class="ml-2 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold">${c.unread_count}</span>` : ""}
          </div>
        </div>
      </div>`).join("");
    wireFriendRows();
    return;
  }
}

function wireRowButtons() {
  document.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const act = btn.dataset.act;
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
    row.addEventListener("click", () => {
      openChat(row.dataset.chat, row.dataset.username, row.dataset.avatar, row.dataset.premium === "1");
    });
  });
}

async function openChat(userId, username, avatarId, isPremium) {
  activeChatUserId = userId;
  openChatPanel();
  $("chatHeaderContent").innerHTML = `
    <div class="flex items-center gap-3">
      ${avatarHTML(avatarId, "sm", null, isPremium)}
      <div>
        <div class="text-sm font-bold text-slate-100">${escapeHTML(username)}${crownMark(isPremium)}</div>
        <div class="text-[10px] text-slate-500">Direct message</div>
      </div>
    </div>`;
  $("chatForm").classList.remove("hidden");
  await loadMessages();
  $("chatInput").focus();
}

async function loadMessages() {
  if (!activeChatUserId) return;
  try {
    const msgs = await api.getConversation(activeChatUserId);
    const el = $("chatMessages");
    el.innerHTML = "";
    for (const m of msgs) {
      const mine = m.sender_id === myId;
      const wrap = document.createElement("div");
      wrap.className = mine ? "flex flex-col items-end" : "flex flex-col items-start";
      wrap.innerHTML = `
        <div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"}">${escapeHTML(m.content)}</div>
        <div class="text-[10px] text-slate-500 mt-0.5">${timeAgo(m.created_at)}</div>`;
      el.appendChild(wrap);
    }
    el.scrollTop = el.scrollHeight;
  } catch (err) { console.error(err); }
}

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || !activeChatUserId) return;
  $("chatInput").value = "";
  try {
    await api.sendDM(activeChatUserId, text);
    await loadMessages();
    await refreshAll();
    renderList();
  } catch (err) { alert(err.message); }
});

// --- STORY UI WITH IMAGE UPLOAD ---

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

  const myStatuses = statuses.filter(s => s.relation === "self");
  const friendStatuses = statuses.filter(s => s.relation === "friend");
  const allToRender = [...myStatuses, ...friendStatuses];

  let html = `
    <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer" id="addStatusBtn">
      <div class="w-14 h-14 rounded-full border-2 border-slate-700 bg-slate-800 flex items-center justify-center text-xl text-slate-400 hover:border-brand-500 transition">+</div>
      <div class="text-[10px] text-slate-400 font-bold">Add</div>
    </div>
  `;

  allToRender.forEach(s => {
    const isSelf = s.relation === "self";
    const ringClass = isSelf ? "border-slate-500" : "border-brand-500";
    html += `
      <div class="flex flex-col items-center gap-1 flex-shrink-0 cursor-pointer view-status-btn" data-status='${JSON.stringify(s)}'>
        <div class="w-14 h-14 rounded-full border-2 ${ringClass} p-0.5">
          ${avatarHTML(s.avatar_id, "md")}
        </div>
        <div class="text-[10px] text-slate-300 font-bold truncate w-14 text-center">${isSelf ? "You" : escapeHTML(s.username)}</div>
      </div>
    `;
  });

  bar.innerHTML = html;

  bar.querySelectorAll(".view-status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const data = JSON.parse(btn.dataset.status);
      showStatusOverlay(data);
    });
  });

  $("addStatusBtn").addEventListener("click", showCreateStatusModal);
}

function showCreateStatusModal() {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="w-full max-w-sm bg-slate-900 rounded-2xl p-5 border border-slate-700 shadow-2xl">
      <h3 class="text-white font-bold text-lg mb-4">Create Status</h3>
      
      <textarea id="statusText" rows="3" placeholder="What's on your mind?" class="w-full bg-slate-800 text-white rounded-lg p-3 text-sm focus:outline-none focus:border-brand-500 border border-slate-700 mb-3"></textarea>
      
      <label class="flex items-center gap-2 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg p-3 cursor-pointer hover:bg-slate-700 transition mb-4">
        <span class="text-xl">📸</span>
        <span class="text-sm font-bold" id="fileLabel">Add Image or Video</span>
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
  const fileLabel = overlay.querySelector("#fileLabel");
  
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      fileLabel.textContent = fileInput.files[0].name;
      fileLabel.classList.add("text-brand-400");
    }
  });

  overlay.querySelector("#cancelStatusBtn").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#postStatusBtn").addEventListener("click", async () => {
    const text = overlay.querySelector("#statusText").value.trim();
    const file = fileInput.files[0];

    if (!text && !file) {
      alert("Please type something or add a media file.");
      return;
    }

    const formData = new FormData();
    if (text) formData.append("content", text);
    if (file) formData.append("media", file);

    try {
      const token = localStorage.getItem("ps_token");
      const res = await fetch("/api/v1/friends/status", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token },
        body: formData
      });
      
      if (!res.ok) throw new Error("Failed to post status");
      
      overlay.remove();
      await renderStories();
    } catch (e) {
      alert("Error posting status");
    }
  });
}

function showStatusOverlay(status) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4";
  
  let mediaHTML = "";
  if (status.media_url) {
    if (status.media_url.match(/\.(mp4|webm|ogg|mov)$/i)) {
      mediaHTML = `<video src="${status.media_url}" controls autoplay class="w-full h-full object-contain"></video>`;
    } else {
      mediaHTML = `<img src="${status.media_url}" class="w-full h-full object-contain" />`;
    }
  }

  overlay.innerHTML = `
    <div class="w-full max-w-sm bg-slate-900 rounded-2xl overflow-hidden relative flex flex-col" style="height: 80vh;">
      <div class="absolute top-4 left-4 right-4 flex gap-1 z-10">
        <div class="h-1 flex-1 bg-white/40 rounded-full"><div class="h-full bg-white rounded-full w-full animate-[progress_5s_linear]"></div></div>
      </div>
      <div class="p-4 pt-10 flex items-center gap-2 border-b border-slate-800 z-10 bg-slate-900/80 backdrop-blur">
        ${avatarHTML(status.avatar_id, "sm")}
        <div class="text-sm font-bold text-white">${status.relation === "self" ? "Your Story" : escapeHTML(status.username)}</div>
        <div class="ml-auto text-xs text-slate-400">${timeAgo(status.created_at)}</div>
      </div>
      
      <div class="flex-1 relative flex items-center justify-center bg-black">
        ${mediaHTML}
        ${status.content ? `<div class="absolute bottom-6 left-4 right-4 text-center text-white text-xl font-bold p-4 bg-black/50 rounded-xl backdrop-blur">${escapeHTML(status.content)}</div>` : ""}
      </div>

      <button id="closeStatusBtn" class="absolute top-4 right-4 w-8 h-8 bg-black/50 rounded-full text-white font-bold text-sm z-20 flex items-center justify-center">✕</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#closeStatusBtn").addEventListener("click", () => overlay.remove());
}

async function refreshAll() {
  try {
    [friends, requests, conversations] = await Promise.all([
      api.listFriends(),
      api.listFriendRequests(),
      api.listConversations(),
    ]);
    const badge = $("reqBadge");
    if (requests.length > 0) {
      badge.textContent = String(requests.length);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (err) { console.error(err); }
}

async function boot() {
  if (!api.getToken()) { window.location.href = "/"; return; }
  try { me = await api.me(); myId = me.id; } catch {
    api.clearToken(); window.location.href = "/"; return;
  }

  await refreshAll();
  renderList();
  await renderStories();

  pollTimer = setInterval(async () => {
    await refreshAll();
    await renderStories();
    if (!$("searchInput").value.trim()) renderList();
    if (activeChatUserId) await loadMessages();
  }, 5000);
}

boot();

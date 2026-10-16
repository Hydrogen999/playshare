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
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function crownMark(isPremium) {
  return isPremium ? ' <span class="text-amber-400 text-xs">👑</span>' : "";
}

function openChatPanel() {
  document.body.classList.add("chat-open");
}
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
  if (!q) {
    searchResults = [];
    renderList();
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
      searchResults = await api.searchUsers(q);
      renderList();
    } catch (err) {
      console.error(err);
    }
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
      <div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 border-b border-slate-800/50 cursor-pointer" data-chat="${f.id}" data-username="${escapeHTML(f.username)}" data-avatar="${f.avatar_id}" data-premium="${f.is_premium ? '1' : '0'}">
        <div class="flex-shrink-0">${avatarHTML(f.avatar_id, "sm", f.frame_color, f.is_premium)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold truncate">${escapeHTML(f.username)}${crownMark(f.is_premium)}</div>
          <div class="text-xs text-slate-500">Level ${f.level}</div>
        </div>
        <span class="text-xs text-brand-400">Message →</span>
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
            <div class="text-sm font-semibold truncate">${escapeHTML(c.username)}${crownMark(c.is_premium)}</div>
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
        else if (act === "chat") {
          openChat(id, btn.dataset.username, btn.dataset.avatar, btn.dataset.premium === "1");
          return;
        }
        await refreshAll();
        const q = $("searchInput").value.trim();
        if (q) searchResults = await api.searchUsers(q);
        renderList();
      } catch (err) {
        alert(err.message);
      }
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
        <div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${
          mine ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-100"
        }">${escapeHTML(m.content)}</div>
        <div class="text-[10px] text-slate-500 mt-0.5">${timeAgo(m.created_at)}</div>`;
      el.appendChild(wrap);
    }
    el.scrollTop = el.scrollHeight;
  } catch (err) {
    console.error(err);
  }
}

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || !activeChatUserId) return;
  $("chatInput").value = "";
  try {
    await api.sendDM(activeChatUserId, text);
    await loadMessages();
  } catch (err) {
    alert(err.message);
  }
});

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
  } catch (err) {
    console.error(err);
  }
}

async function boot() {
  if (!api.getToken()) {
    window.location.href = "/";
    return;
  }
  try {
    me = await api.me();
    myId = me.id;
  } catch {
    api.clearToken();
    window.location.href = "/";
    return;
  }

  await refreshAll();
  renderList();

  pollTimer = setInterval(async () => {
    await refreshAll();
    if (!$("searchInput").value.trim()) renderList();
    if (activeChatUserId) await loadMessages();
  }, 5000);
}

boot();
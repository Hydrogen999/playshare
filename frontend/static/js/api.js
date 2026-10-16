const API_BASE = "";

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = localStorage.getItem("ps_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Only log out when /auth/me fails — background endpoints failing should NOT kick the user
  if (res.status === 401 && auth && path.startsWith("/api/v1/auth/me")) {
    console.warn("[api] auth/me returned 401 — logging out");
    localStorage.removeItem("ps_token");
    if (window.location.pathname !== "/" && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error("Session expired — please log in");
  }

  // Log other 401s but don't log out
  if (res.status === 401) {
    console.warn(`[api] ${path} returned 401 (not logging out)`);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const detail = data?.detail ?? res.statusText ?? "Request failed";
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

export const api = {
  // ---- auth ----
  register: (payload) =>
    request("/api/v1/auth/register", { method: "POST", body: payload, auth: false }),
  login: (payload) =>
    request("/api/v1/auth/login", { method: "POST", body: payload, auth: false }),
  me: () => request("/api/v1/auth/me"),

  // ---- profile ----
  updateProfile: (payload) =>
    request("/api/v1/me/profile", { method: "PATCH", body: payload }),
  listAvatars: () => request("/api/v1/avatars"),
  getUser: (id) => request(`/api/v1/users/${id}`),
  searchUsers: (q) => request(`/api/v1/users/search?q=${encodeURIComponent(q)}`),

  // ---- tokens / stats / xp ----
  tokens: () => request("/api/v1/me/tokens"),
  ledger: () => request("/api/v1/me/ledger"),
  stats: () => request("/api/v1/me/stats"),
  xp: () => request("/api/v1/me/xp"),

  // ---- daily ----
  dailyState: () => request("/api/v1/me/daily"),
  claimDaily: () => request("/api/v1/me/daily/claim", { method: "POST" }),

  // ---- shop ----
  shopCatalog: () => request("/api/v1/shop"),
  shopInventory: () => request("/api/v1/shop/inventory"),
  shopBuy: (itemId) => request("/api/v1/shop/buy", { method: "POST", body: { item_id: itemId } }),
  shopEquip: (itemId) => request("/api/v1/shop/equip", { method: "POST", body: { item_id: itemId } }),

  // ---- friends ----
  listFriends: () => request("/api/v1/friends"),
  listFriendRequests: () => request("/api/v1/friends/requests"),
  sendFriendRequest: (userId) =>
    request(`/api/v1/friends/request/${userId}`, { method: "POST" }),
  acceptFriend: (userId) =>
    request(`/api/v1/friends/accept/${userId}`, { method: "POST" }),
  declineFriend: (userId) =>
    request(`/api/v1/friends/decline/${userId}`, { method: "POST" }),
  removeFriend: (userId) =>
    request(`/api/v1/friends/${userId}`, { method: "DELETE" }),

  // ---- DMs ----
  listConversations: () => request("/api/v1/dm"),
  getConversation: (userId) => request(`/api/v1/dm/${userId}`),
  sendDM: (userId, content) =>
    request(`/api/v1/dm/${userId}`, { method: "POST", body: { content } }),

  // ---- notifications ----
  listNotifications: (unreadOnly = false) =>
    request(`/api/v1/me/notifications?unread_only=${unreadOnly}`),
  unreadNotificationCount: () => request("/api/v1/me/notifications/count"),
  markNotificationRead: (id) =>
    request(`/api/v1/me/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () =>
    request("/api/v1/me/notifications/read-all", { method: "POST" }),

  // ---- tournaments ----
  listTournaments: () => request("/api/v1/tournaments"),
  myTournaments: () => request("/api/v1/tournaments/mine"),
  getTournament: (id) => request(`/api/v1/tournaments/${id}`),
  createTournament: (payload) => request("/api/v1/tournaments", { method: "POST", body: payload }),
  joinTournament: (id) => request(`/api/v1/tournaments/${id}/join`, { method: "POST" }),
  leaveTournament: (id) => request(`/api/v1/tournaments/${id}/leave`, { method: "POST" }),

  // ---- rooms ----
  createRoom: (payload) => request("/api/v1/rooms", { method: "POST", body: payload }),
  listPublicRooms: () => request("/api/v1/rooms/public"),
  joinRoomByCode: (code) => request(`/api/v1/rooms/join/${code}`, { method: "POST" }),

    // ---- payments ----
  getPacks: () => request("/api/v1/payments/packs"),
  checkout: (packId) => request("/api/v1/payments/checkout", { method: "POST", body: { pack_id: packId } }),
  verifyPayment: (reference) => request(`/api/v1/payments/verify/${reference}`),

  // ---- flutterwave (global USD) ----
  flwCheckout: (packId) => request("/api/v1/payments/flw/checkout", { method: "POST", body: { pack_id: packId } }),
  flwVerify: (txRef) => request(`/api/v1/payments/flw/verify/${txRef}`),

  // ---- premium ----
  premiumPlans: () => request("/api/v1/premium/plans"),
  premiumStatus: () => request("/api/v1/premium/status"),
  premiumSubscribe: (planId) => request("/api/v1/premium/subscribe", { method: "POST", body: { plan_id: planId } }),
  premiumVerify: (reference) => request(`/api/v1/premium/verify/${reference}`),

  // ---- leaderboards ----
  leaderboard: (category = "xp", scope = "global") =>
    request(`/api/v1/leaderboards/${category}?scope=${scope}`),

  // ---- referral ----
  myReferral: () => request("/api/v1/referral/me"),

  // ---- achievements ----
  myAchievements: () => request("/api/v1/achievements"),
  checkAchievements: () => request("/api/v1/achievements/check", { method: "POST" }),
  achievementsSummary: () => request("/api/v1/achievements/summary"),

  // ---- battle pass ----
  battlepass: () => request("/api/v1/battlepass"),
  claimBPTier: (tier, track) => request("/api/v1/battlepass/claim", { method: "POST", body: { tier, track } }),
  claimBPAll: (track) => request(`/api/v1/battlepass/claim-all/${track}`, { method: "POST" }),
  purchaseBP: () => request("/api/v1/battlepass/purchase", { method: "POST" }),
  verifyBP: (ref) => request(`/api/v1/battlepass/verify/${ref}`),

  // ---- ads ----
  adConfig: () => request("/api/v1/ads/config"),
  claimRewardedAd: () => request("/api/v1/ads/rewarded/claim", { method: "POST" }),

  // ---- push ----
  pushSettings: () => request("/api/v1/push/settings"),
  updatePushSettings: (payload) => request("/api/v1/push/settings", { method: "POST", body: payload }),

  // ---- chess ----
  chessTierInfo: () => request("/api/v1/chess/tier"),

  // ---- raw request (for admin) ----
  request: (path, opts) => request(path, opts),

  // ---- session ----
  saveToken: (t) => localStorage.setItem("ps_token", t),
  getToken: () => localStorage.getItem("ps_token"),
  clearToken: () => localStorage.removeItem("ps_token"),
};
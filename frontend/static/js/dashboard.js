import { api } from "./api.js";
import { avatarHTML } from "./avatars.js";

const $ = (id) => document.getElementById(id);

const DAILY_REWARDS = [20, 30, 40, 50, 60, 70, 200];

const CHESS_TIER_META = {
  bronze:      { icon: "🥉", label: "Bronze",      color: "#cd7f32" },
  silver:      { icon: "🥈", label: "Silver",      color: "#c0c0c0" },
  gold:        { icon: "🥇", label: "Gold",        color: "#facc15" },
  diamond:     { icon: "💎", label: "Diamond",     color: "#60a5fa" },
  grandmaster: { icon: "👑", label: "Grandmaster", color: "#a855f7" },
};

function timeAgo(iso) {
  if (!iso) return "—";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderMatches(matches) {
  const list = $("matchList");
  if (!list) return;

  if (!matches || matches.length === 0) {
    list.innerHTML = `<div class="text-slate-500 text-sm">No matches yet — enter the lobby and challenge someone!</div>`;
    return;
  }
  list.innerHTML = matches.map((m) => {
    const badge = m.result === "win"
      ? `<span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400">WIN</span>`
      : m.result === "loss"
      ? `<span class="text-xs font-bold px-2 py-0.5 rounded bg-red-500/15 text-red-400">LOSS</span>`
      : `<span class="text-xs font-bold px-2 py-0.5 rounded bg-slate-700 text-slate-300">DRAW</span>`;
    const gameIcon = m.game_slug === "ludo" ? "🎯" : m.game_slug === "chess" ? "♟️" : m.game_slug === "whot" ? "🃏" : "🎲";
    const gameLabel = m.game_slug === "ludo" ? "Ludo" : m.game_slug === "chess" ? "Chess" : m.game_slug === "whot" ? "Whot" : "Roll-off";
    const wager = m.wager > 0
      ? `<span class="text-xs text-slate-400">${m.wager} PC</span>`
      : `<span class="text-xs text-slate-600">friendly</span>`;
    return `
      <div class="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-3">
        <div class="flex-shrink-0">${avatarHTML(m.opponent_avatar_id, "sm")}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm">
            <span class="font-semibold">${m.opponent_username}</span>
            <span class="text-slate-500"> · ${gameIcon} ${gameLabel}</span>
          </div>
          <div class="text-xs text-slate-500 mt-0.5">${timeAgo(m.ended_at)}</div>
        </div>
        <div class="flex-shrink-0 text-right">
          ${badge}<div class="mt-1">${wager}</div>
        </div>
      </div>`;
  }).join("");
}

function renderDaily(state) {
  const card = $("dailyCard");
  if (!card) return;

  const days = $("dailyDays");
  const badge = $("dailyStreak");
  const btn = $("claimDailyBtn");
  const msg = $("dailyMsg");
  if (!days || !badge || !btn || !msg) return;

  days.innerHTML = DAILY_REWARDS.map((amt, i) => {
    const dayNum = i + 1;
    const isClaimed = state.streak > 0 && dayNum < state.day_in_cycle;
    const isCurrent = dayNum === state.day_in_cycle && state.can_claim;
    const isToday = dayNum === state.day_in_cycle && !state.can_claim;

    let cls = "border-slate-800 bg-slate-800/40 text-slate-400";
    if (isClaimed) cls = "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    else if (isCurrent) cls = "border-brand-500 bg-brand-500/20 text-brand-400 ring-2 ring-brand-500/50";
    else if (isToday) cls = "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";

    const icon = isClaimed || isToday ? "✓" : amt;

    return `
      <div class="rounded-lg border ${cls} p-1.5 sm:p-2 text-center">
        <div class="text-[9px] sm:text-[10px] uppercase font-bold opacity-70">D${dayNum}</div>
        <div class="text-xs sm:text-sm font-bold mt-0.5">${icon}</div>
      </div>`;
  }).join("");

  if (state.can_claim) {
    badge.textContent = `Day ${state.day_in_cycle} of 7 · Streak: ${state.streak}`;
    btn.textContent = `Claim +${state.next_reward}`;
    btn.classList.remove("hidden");
  } else {
    badge.textContent = `Streak: ${state.streak} · Come back tomorrow!`;
    btn.classList.add("hidden");
  }

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Claiming…";
    try {
      const res = await api.claimDaily();
      if (res.ok) {
        msg.textContent = `🎉 +${res.claimed} PlayCoins! Day ${res.day_in_cycle}`;
        msg.className = "mt-3 text-center text-sm text-emerald-400 pop";
        msg.classList.remove("hidden");
        renderDaily(res.state);
        try { 
          const me = await api.me(); 
          if ($("tokens")) $("tokens").textContent = me.profile.tokens; 
          if ($("level")) $("level").textContent = me.profile.level; 
        } catch {}
        setTimeout(() => msg.classList.add("hidden"), 4000);
      } else {
        msg.textContent = res.error || "Already claimed";
        msg.className = "mt-3 text-center text-sm text-amber-400";
        msg.classList.remove("hidden");
        btn.disabled = false;
      }
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "mt-3 text-center text-sm text-red-400";
      msg.classList.remove("hidden");
      btn.disabled = false;
    }
  };
}

function renderChess(me) {
  const p = me.profile;
  const rating = p.elo_rating || 1200;
  const tier = p.chess_tier || "bronze";
  const meta = CHESS_TIER_META[tier] || CHESS_TIER_META.bronze;

  if ($("chessRating")) $("chessRating").textContent = rating;
  if ($("chessTierLabel")) {
    $("chessTierLabel").textContent = `${meta.icon} ${meta.label}`;
    $("chessTierLabel").style.background = `${meta.color}25`;
    $("chessTierLabel").style.color = meta.color;
    $("chessTierLabel").style.border = `1px solid ${meta.color}55`;
  }

  const w = p.chess_wins || 0;
  const l = p.chess_losses || 0;
  const d = p.chess_draws || 0;
  const total = p.chess_games_played || 0;
  
  if ($("chessRecord")) {
    $("chessRecord").textContent = total === 0
      ? "No chess games yet — play your first!"
      : `${total} games · ${w}W / ${l}L / ${d}D`;
  }
}

async function load() {
  if (!api.getToken()) { window.location.href = "/"; return; }

  try {
    const me = await api.me();
    if ($("username")) $("username").textContent = me.username;
    if ($("tokens")) $("tokens").textContent = me.profile.tokens;
    if ($("level")) $("level").textContent = me.profile.level;
    if ($("avatarSlot")) $("avatarSlot").innerHTML = avatarHTML(me.profile.avatar_id, "lg", me.profile.frame_color);
    if (me.profile.bio && $("subline")) $("subline").textContent = me.profile.bio;
    if (me.profile.is_premium) { 
      $("premiumBadge")?.classList.remove("hidden"); 
      $("premiumBadgeSmall")?.classList.remove("hidden"); 
    }
    renderChess(me);
  } catch (err) {
    console.error("User load failed", err);
    api.clearToken();
    window.location.href = "/";
    return;
  }

  try {
    const xp = await api.xp();
    if ($("levelBadge")) $("levelBadge").textContent = `LV ${xp.level}`;
    if ($("xpInLevel")) $("xpInLevel").textContent = xp.xp_in_level;
    if ($("xpNeeded")) $("xpNeeded").textContent = xp.xp_needed;
    const pct = Math.max(0, Math.min(100, Math.round(xp.percent * 100)));
    if ($("xpBar")) $("xpBar").style.width = `${pct}%`;
    if (xp.level > 1 && $("levelBadge")) $("levelBadge").classList.add("pop");
  } catch (err) { console.error("XP load failed", err); }

  try {
    const daily = await api.dailyState();
    renderDaily(daily);
  } catch (err) { console.error("Daily load failed", err); }

  try {
    const stats = await api.stats();
    if ($("statGames")) $("statGames").textContent = stats.games_played;
    if ($("statWinRate")) $("statWinRate").textContent = `${Math.round(stats.win_rate * 100)}%`;
    renderMatches(stats.recent_matches);
  } catch (err) { 
    if ($("matchList")) $("matchList").innerHTML = `<div class="text-red-400 text-sm">Failed to load stats.</div>`; 
  }
}

$("logoutBtn")?.addEventListener("click", () => { api.clearToken(); window.location.href = "/"; });

// --- Share Profile Logic ---
async function setupShare() {
  const btn = document.getElementById("shareProfileBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      const me = await api.me();
      const tier = me.profile.chess_tier ? me.profile.chess_tier.toUpperCase() : "BRONZE";
      const text = `I'm playing on PlaySphere! 🎮\n\nMy Stats:\n♟️ Chess Elo: ${me.profile.elo_rating} (${tier})\n⭐ Level: ${me.profile.level}\n\nCome challenge me:`;
      const url = `${location.origin}/user?id=${me.id}`;

      if (navigator.share) {
        await navigator.share({ title: "Challenge me on PlaySphere!", text: text, url: url });
      } else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        alert("Profile link copied to clipboard! Paste it in WhatsApp to challenge friends.");
      }
    } catch (err) {
      if (err.name !== "AbortError") console.error("Share failed:", err);
    }
  });
}

load();
setupShare();

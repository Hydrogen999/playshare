"""Achievement catalog + auto-unlock logic."""

import json
from datetime import datetime, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.match import Match
from app.models.social import Notification
from app.models.user import Profile, User
from app.services.ledger import get_balance

CATALOG: list[dict] = [
    # Rookie tier
    {"id": "first_game",     "name": "First Steps",       "desc": "Play your first match",         "icon": "🎮", "tier": "bronze", "goal": 1},
    {"id": "first_win",      "name": "First Blood",       "desc": "Win your first match",           "icon": "⚔️", "tier": "bronze", "goal": 1},
    {"id": "play_10",        "name": "Regular",           "desc": "Play 10 matches",                "icon": "🎯", "tier": "bronze", "goal": 10},

    # Bronze tier
    {"id": "win_10",         "name": "Contender",         "desc": "Win 10 matches",                 "icon": "🏅", "tier": "bronze", "goal": 10},
    {"id": "play_50",        "name": "Dedicated",         "desc": "Play 50 matches",                "icon": "🎲", "tier": "bronze", "goal": 50},
    {"id": "level_5",        "name": "Rising Star",       "desc": "Reach level 5",                  "icon": "⭐", "tier": "bronze", "goal": 5},
    {"id": "reach_500_pc",   "name": "Coin Collector",    "desc": "Hold 500 PlayCoins",             "icon": "🪙", "tier": "bronze", "goal": 500},
    {"id": "first_friend",   "name": "Social Butterfly",  "desc": "Add your first friend",          "icon": "🤝", "tier": "bronze", "goal": 1},

    # Silver tier
    {"id": "win_50",         "name": "Veteran",           "desc": "Win 50 matches",                 "icon": "🥈", "tier": "silver", "goal": 50},
    {"id": "play_100",       "name": "Grinder",           "desc": "Play 100 matches",               "icon": "💪", "tier": "silver", "goal": 100},
    {"id": "level_10",       "name": "Seasoned",          "desc": "Reach level 10",                 "icon": "🌟", "tier": "silver", "goal": 10},
    {"id": "reach_5000_pc",  "name": "Rich",              "desc": "Hold 5,000 PlayCoins",           "icon": "💰", "tier": "silver", "goal": 5000},
    {"id": "friends_5",      "name": "Squad",             "desc": "Have 5 friends",                 "icon": "👥", "tier": "silver", "goal": 5},
    {"id": "daily_streak_7", "name": "Faithful",          "desc": "Log in 7 days in a row",         "icon": "📅", "tier": "silver", "goal": 7},

    # Gold tier
    {"id": "win_100",        "name": "Champion",          "desc": "Win 100 matches",                "icon": "🥇", "tier": "gold", "goal": 100},
    {"id": "play_500",       "name": "Legendary Grind",   "desc": "Play 500 matches",               "icon": "🔥", "tier": "gold", "goal": 500},
    {"id": "level_25",       "name": "Elite",             "desc": "Reach level 25",                 "icon": "💎", "tier": "gold", "goal": 25},
    {"id": "reach_25000_pc", "name": "Whale",             "desc": "Hold 25,000 PlayCoins",          "icon": "🐋", "tier": "gold", "goal": 25000},
    {"id": "ludo_win_20",    "name": "Ludo Master",       "desc": "Win 20 Ludo matches",            "icon": "🎯", "tier": "gold", "goal": 20},

    # Legendary tier
    {"id": "win_500",        "name": "Unstoppable",       "desc": "Win 500 matches",                "icon": "👑", "tier": "legendary", "goal": 500},
    {"id": "level_50",       "name": "Immortal",          "desc": "Reach level 50",                 "icon": "🏆", "tier": "legendary", "goal": 50},
    {"id": "reach_100k_pc",  "name": "Banker",            "desc": "Hold 100,000 PlayCoins",         "icon": "💎", "tier": "legendary", "goal": 100000},
    {"id": "referral_10",    "name": "Recruiter",         "desc": "Refer 10 players",               "icon": "🎁", "tier": "legendary", "goal": 10},
]

CATALOG_BY_ID = {a["id"]: a for a in CATALOG}

TIER_COLORS = {
    "bronze":    {"bg": "#7c2d12", "border": "#ea580c", "text": "#fdba74"},
    "silver":    {"bg": "#334155", "border": "#94a3b8", "text": "#e2e8f0"},
    "gold":      {"bg": "#713f12", "border": "#facc15", "text": "#fde047"},
    "legendary": {"bg": "#4c1d95", "border": "#a855f7", "text": "#d8b4fe"},
}


def list_catalog() -> list[dict]:
    return CATALOG


def _user_stats(db: Session, user_id: str) -> dict:
    """Compute current progress values for achievement triggers."""
    profile = db.get(Profile, user_id)
    balance = get_balance(db, user_id)

    wins = (
        db.query(func.count(Match.id))
        .filter(Match.winner_id == user_id, Match.status == "finished")
        .scalar() or 0
    )
    plays = (
        db.query(func.count(Match.id))
        .filter(
            or_(Match.player_a == user_id, Match.player_b == user_id),
            Match.status == "finished",
        )
        .scalar() or 0
    )
    ludo_wins = (
        db.query(func.count(Match.id))
        .filter(
            Match.winner_id == user_id,
            Match.status == "finished",
            Match.game_slug == "ludo",
        )
        .scalar() or 0
    )

    from app.models.social import Friendship
    from app.models.daily import DailyReward
    from app.models.referral import Referral

    friend_count = (
        db.query(func.count(Friendship.id))
        .filter(
            Friendship.status == "accepted",
            or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id),
        )
        .scalar() or 0
    )
    daily = db.get(DailyReward, user_id)
    daily_streak = daily.streak if daily else 0
    referral_count = (
        db.query(func.count(Referral.id))
        .filter(Referral.referrer_id == user_id)
        .scalar() or 0
    )

    return {
        "first_game": 1 if plays > 0 else 0,
        "first_win": 1 if wins > 0 else 0,
        "first_friend": 1 if friend_count > 0 else 0,
        "play_10": plays,
        "play_50": plays,
        "play_100": plays,
        "play_500": plays,
        "win_10": wins,
        "win_50": wins,
        "win_100": wins,
        "win_500": wins,
        "ludo_win_20": ludo_wins,
        "level_5": profile.level if profile else 1,
        "level_10": profile.level if profile else 1,
        "level_25": profile.level if profile else 1,
        "level_50": profile.level if profile else 1,
        "reach_500_pc": balance,
        "reach_5000_pc": balance,
        "reach_25000_pc": balance,
        "reach_100k_pc": balance,
        "friends_5": friend_count,
        "daily_streak_7": daily_streak,
        "referral_10": referral_count,
    }


def check_and_unlock(db: Session, user_id: str) -> list[dict]:
    """Check all achievements. Unlock any the user just earned. Returns newly unlocked."""
    from app.models.referral import Referral as _Ref  # noqa
    # lazy import to avoid circular
    from app.models.achievement import UserAchievement

    stats = _user_stats(db, user_id)
    owned = {
        r.achievement_id
        for r in db.query(UserAchievement).filter(UserAchievement.user_id == user_id).all()
    }

    newly_unlocked: list[dict] = []
    for ach in CATALOG:
        if ach["id"] in owned:
            continue
        progress = stats.get(ach["id"], 0)
        if progress >= ach["goal"]:
            db.add(UserAchievement(user_id=user_id, achievement_id=ach["id"]))
            db.add(Notification(
                user_id=user_id,
                type="achievement",
                payload=json.dumps({
                    "achievement_id": ach["id"],
                    "name": ach["name"],
                    "icon": ach["icon"],
                    "tier": ach["tier"],
                }),
            ))
            newly_unlocked.append(ach)

    if newly_unlocked:
        db.commit()

    return newly_unlocked


def user_achievements(db: Session, user_id: str) -> list[dict]:
    """Return all catalog achievements with unlocked status + progress."""
    from app.models.achievement import UserAchievement

    stats = _user_stats(db, user_id)
    owned_rows = db.query(UserAchievement).filter(UserAchievement.user_id == user_id).all()
    owned_map = {r.achievement_id: r.unlocked_at.isoformat() for r in owned_rows}

    out = []
    for ach in CATALOG:
        progress = stats.get(ach["id"], 0)
        out.append({
            **ach,
            "unlocked": ach["id"] in owned_map,
            "unlocked_at": owned_map.get(ach["id"]),
            "progress": min(progress, ach["goal"]),
            "progress_pct": min(1.0, (progress / ach["goal"]) if ach["goal"] else 0),
        })
    return out


def unlocked_count(db: Session, user_id: str) -> int:
    from app.models.achievement import UserAchievement
    return (
        db.query(func.count(UserAchievement.id))
        .filter(UserAchievement.user_id == user_id)
        .scalar() or 0
    )
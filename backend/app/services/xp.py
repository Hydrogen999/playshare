"""XP + leveling system.

Level formula: level = floor(sqrt(xp / 100)) + 1
    0 xp   -> level 1
    100 xp -> level 2
    400 xp -> level 3
    900 xp -> level 4
    1600 xp -> level 5
    ...
    next level requires (level^2) * 100 xp total

XP rewards:
    play_match   = 10
    win_match    = 30
    draw_match   = 15
    ludo_win     = 40
    ludo_loss    = 15
"""

import math

from sqlalchemy.orm import Session

from app.models.match import Match
from app.models.user import User
from app.models.xp import XPEvent


def xp_for_level(level: int) -> int:
    """Total XP needed to reach a given level."""
    if level <= 1:
        return 0
    return ((level - 1) ** 2) * 100


def level_for_xp(xp: int) -> int:
    """Convert total XP to level."""
    if xp < 0:
        return 1
    return int(math.isqrt(xp // 100)) + 1


def progress_to_next(xp: int) -> dict:
    """Return {level, xp_in_level, xp_for_next, xp_needed, percent}."""
    level = level_for_xp(xp)
    current_floor = xp_for_level(level)
    next_floor = xp_for_level(level + 1)
    xp_in_level = xp - current_floor
    xp_needed = next_floor - current_floor
    percent = 0.0 if xp_needed <= 0 else round(xp_in_level / xp_needed, 4)
    return {
        "level": level,
        "xp_in_level": xp_in_level,
        "xp_needed": xp_needed,
        "xp_total": xp,
        "xp_next_level": next_floor,
        "percent": percent,
    }


def award_xp(
    db: Session,
    user_id: str,
    amount: int,
    source: str,
    ref_id: str | None = None,
) -> dict:
    """Add XP to a user. Also adds Season XP for battle pass."""
    if amount <= 0:
        return {"xp_total": 0, "level": 1, "level_up": False}

    user = db.get(User, user_id)
    if not user or not user.profile:
        return {"xp_total": 0, "level": 1, "level_up": False}

    old_level = user.profile.level
    user.profile.xp += amount
    new_level = level_for_xp(user.profile.xp)
    user.profile.level = new_level

    db.add(XPEvent(user_id=user_id, amount=amount, source=source, ref_id=ref_id))
    db.commit()

    # Season XP — every XP earned feeds the battle pass
    try:
        from app.services.battlepass import add_season_xp
        add_season_xp(db, user_id, amount)
    except Exception as e:
        print(f"[season xp error] {e}")

    return {
        "xp_total": user.profile.xp,
        "level": new_level,
        "level_up": new_level > old_level,
    }


def award_match_xp(db: Session, match: Match) -> dict:
    """Award XP to both players based on the match outcome."""
    result: dict[str, dict] = {}

    for player_id in (match.player_a, match.player_b):
        if match.winner_id is None:
            amount = 15
            src = "draw_match"
        elif match.winner_id == player_id:
            amount = 40 if match.game_slug == "ludo" else 30
            src = "win_match"
        else:
            amount = 15
            src = "loss_match"
        result[player_id] = award_xp(db, player_id, amount, src, match.id)

    return result
"""Daily reward logic. 7-day cycle with streak tracking."""

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models.daily import DailyReward
from app.services.ledger import grant_tokens
from app.services.xp import award_xp

# Reward per day in the 7-day cycle
REWARDS = [20, 30, 40, 50, 60, 70, 200]
CYCLE_LEN = len(REWARDS)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _is_same_day(a: datetime, b: datetime) -> bool:
    return a.year == b.year and a.month == b.month and a.day == b.day


def _days_ago(dt: datetime) -> int:
    """Days between dt and now, ignoring time-of-day."""
    today = _utcnow().date()
    return (today - dt.date()).days


def get_state(db: Session, user_id: str) -> dict:
    """Return current daily reward state — can they claim? what's next?"""
    row = db.get(DailyReward, user_id)
    if not row:
        return {
            "streak": 0,
            "day_in_cycle": 1,
            "can_claim": True,
            "next_reward": REWARDS[0],
            "total_claimed": 0,
            "last_claimed_at": None,
            "rewards_preview": REWARDS,
        }

    if row.last_claimed_at is None:
        return _fresh_state(row, can_claim=True)

    days = _days_ago(row.last_claimed_at)

    if days == 0:
        # Already claimed today
        return _fresh_state(row, can_claim=False)
    elif days == 1:
        # Continuing streak
        next_streak = row.streak + 1
        return _state_for_streak(row, next_streak, can_claim=True)
    else:
        # Missed a day — reset
        return _state_for_streak(row, 1, can_claim=True)


def _fresh_state(row: DailyReward, can_claim: bool) -> dict:
    return _state_for_streak(row, row.streak, can_claim)


def _state_for_streak(row: DailyReward, next_streak: int, can_claim: bool) -> dict:
    if next_streak <= 0:
        next_streak = 1
    day_in_cycle = ((next_streak - 1) % CYCLE_LEN) + 1
    reward = REWARDS[day_in_cycle - 1]
    return {
        "streak": row.streak,
        "day_in_cycle": day_in_cycle,
        "can_claim": can_claim,
        "next_reward": reward,
        "total_claimed": row.total_claimed,
        "last_claimed_at": row.last_claimed_at.isoformat() if row.last_claimed_at else None,
        "rewards_preview": REWARDS,
    }


def claim(db: Session, user_id: str) -> dict:
    """Claim today's reward. Returns state + claimed amount."""
    state = get_state(db, user_id)
    if not state["can_claim"]:
        return {"ok": False, "error": "Already claimed today", "state": state}

    row = db.get(DailyReward, user_id)
    if not row:
        row = DailyReward(user_id=user_id, streak=0, total_claimed=0)
        db.add(row)
        db.flush()

    # Determine new streak
    if row.last_claimed_at is None:
        new_streak = 1
    else:
        days = _days_ago(row.last_claimed_at)
        if days == 1:
            new_streak = row.streak + 1
        else:
            new_streak = 1

    day_in_cycle = ((new_streak - 1) % CYCLE_LEN) + 1
    reward = REWARDS[day_in_cycle - 1]

    row.streak = new_streak
    row.last_claimed_at = _utcnow()
    row.total_claimed += reward
    db.commit()

    # Grant tokens + XP
    try:
        grant_tokens(db, user_id, reward, reason=f"daily_reward_day_{day_in_cycle}",
                     idempotency_key=None)
    except Exception:
        pass
    try:
        award_xp(db, user_id, 15, "daily_reward")
    except Exception:
        pass

    new_state = get_state(db, user_id)
    return {
        "ok": True,
        "claimed": reward,
        "day_in_cycle": day_in_cycle,
        "streak": new_streak,
        "state": new_state,
    }
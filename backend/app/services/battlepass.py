"""Battle Pass — season progress, rewards, purchase."""

import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.battlepass import BattlePassPurchase, Season, SeasonProgress
from app.models.cosmetic import UserCosmetic
from app.models.user import User
from app.services.ledger import grant_tokens

MAX_TIER = 20
XP_PER_TIER = 250

PASS_PRICE_KOBO = 250000
CURRENCY = "NGN"

REWARDS: list[tuple[dict, dict]] = [
    ({"type": "coins", "amount": 100}, {"type": "skin",  "id": "frame_bronze",  "name": "Bronze Ring"}),
    ({"type": "coins", "amount": 150}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 100}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 150}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 200}, {"type": "skin",  "id": "frame_silver",  "name": "Silver Ring"}),
    ({"type": "coins", "amount": 150}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 150}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 200}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 150}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 300}, {"type": "skin",  "id": "frame_gold",    "name": "Gold Ring"}),
    ({"type": "coins", "amount": 200}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 200}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 200}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 250}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 300}, {"type": "skin",  "id": "frame_neon",    "name": "Neon Ring"}),
    ({"type": "coins", "amount": 250}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 250}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 300}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 300}, {"type": "coins", "amount": 500}),
    ({"type": "coins", "amount": 500}, {"type": "skin",  "id": "frame_galaxy",  "name": "Galaxy Ring"}),
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def tier_for_xp(xp: int) -> int:
    return min(MAX_TIER, xp // XP_PER_TIER)


def get_active_season(db: Session) -> Season | None:
    """Return active season or create a new one. Never crashes."""
    try:
        now = _now()
        # Grab latest season marked active
        s = (
            db.query(Season)
            .filter(Season.is_active == 1)
            .order_by(Season.starts_at.desc())
            .first()
        )
        if s:
            ends = _to_aware(s.ends_at)
            if ends and ends > now:
                return s
            # Expired — deactivate and fall through
            s.is_active = 0
            db.commit()
    except Exception as e:
        print(f"[get_active_season read error] {e}")
        try:
            db.rollback()
        except Exception:
            pass

    return _create_default_season(db)


def _create_default_season(db: Session) -> Season:
    now = _now()
    s = Season(
        name="Season 1",
        starts_at=now,
        ends_at=now + timedelta(days=60),
        is_active=1,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def get_progress(db: Session, user_id: str, season_id: str) -> SeasonProgress:
    row = (
        db.query(SeasonProgress)
        .filter(
            SeasonProgress.user_id == user_id,
            SeasonProgress.season_id == season_id,
        )
        .first()
    )
    if row:
        return row
    row = SeasonProgress(
        user_id=user_id,
        season_id=season_id,
        season_xp=0,
        claimed_free="[]",
        claimed_premium="[]",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def add_season_xp(db: Session, user_id: str, amount: int) -> dict:
    if amount <= 0:
        return {"ok": False}
    try:
        season = get_active_season(db)
        if not season:
            return {"ok": False}
        prog = get_progress(db, user_id, season.id)
        old_tier = tier_for_xp(prog.season_xp)
        prog.season_xp += amount
        new_tier = tier_for_xp(prog.season_xp)
        db.commit()
        return {"ok": True, "old_tier": old_tier, "new_tier": new_tier}
    except Exception as e:
        print(f"[add_season_xp error] {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return {"ok": False}


def has_premium(db: Session, user_id: str, season_id: str) -> bool:
    try:
        return (
            db.query(BattlePassPurchase)
            .filter(
                BattlePassPurchase.user_id == user_id,
                BattlePassPurchase.season_id == season_id,
                BattlePassPurchase.status == "paid",
            )
            .first()
            is not None
        )
    except Exception as e:
        print(f"[has_premium error] {e}")
        return False


def _parse_list(raw: str) -> list[int]:
    try:
        v = json.loads(raw or "[]")
        return [int(x) for x in v]
    except Exception:
        return []


def _grant_reward(db: Session, user_id: str, reward: dict) -> bool:
    rtype = reward.get("type")
    if rtype == "coins":
        amount = int(reward.get("amount", 0))
        if amount > 0:
            grant_tokens(db, user_id, amount, reason="battlepass_reward")
        return True
    if rtype == "skin":
        skin_id = reward.get("id")
        if not skin_id:
            return False
        existing = (
            db.query(UserCosmetic)
            .filter(UserCosmetic.user_id == user_id, UserCosmetic.item_id == skin_id)
            .first()
        )
        if not existing:
            db.add(UserCosmetic(user_id=user_id, item_id=skin_id, equipped=False))
        return True
    return False


def claim_tier(db: Session, user_id: str, tier: int, track: str) -> dict:
    if tier < 1 or tier > MAX_TIER:
        return {"ok": False, "error": "Invalid tier"}
    if track not in ("free", "premium"):
        return {"ok": False, "error": "Invalid track"}

    season = get_active_season(db)
    if not season:
        return {"ok": False, "error": "No active season"}

    prog = get_progress(db, user_id, season.id)
    current_tier = tier_for_xp(prog.season_xp)
    if tier > current_tier:
        return {"ok": False, "error": "Tier not reached"}

    if track == "premium" and not has_premium(db, user_id, season.id):
        return {"ok": False, "error": "Premium pass required"}

    claimed = _parse_list(prog.claimed_free if track == "free" else prog.claimed_premium)
    if tier in claimed:
        return {"ok": False, "error": "Already claimed"}

    reward = REWARDS[tier - 1][0 if track == "free" else 1]
    if not _grant_reward(db, user_id, reward):
        return {"ok": False, "error": "Could not grant reward"}

    claimed.append(tier)
    if track == "free":
        prog.claimed_free = json.dumps(claimed)
    else:
        prog.claimed_premium = json.dumps(claimed)
    db.commit()
    return {"ok": True, "reward": reward}


def claim_all(db: Session, user_id: str, track: str) -> dict:
    season = get_active_season(db)
    if not season:
        return {"ok": False, "error": "No active season"}
    prog = get_progress(db, user_id, season.id)
    current_tier = tier_for_xp(prog.season_xp)
    claimed = _parse_list(prog.claimed_free if track == "free" else prog.claimed_premium)

    if track == "premium" and not has_premium(db, user_id, season.id):
        return {"ok": False, "error": "Premium pass required"}

    total = 0
    for t in range(1, current_tier + 1):
        if t in claimed:
            continue
        reward = REWARDS[t - 1][0 if track == "free" else 1]
        if _grant_reward(db, user_id, reward):
            claimed.append(t)
            total += 1

    if track == "free":
        prog.claimed_free = json.dumps(claimed)
    else:
        prog.claimed_premium = json.dumps(claimed)
    db.commit()
    return {"ok": True, "tiers_claimed": total}


def overview(db: Session, user_id: str) -> dict:
    try:
        season = get_active_season(db)
        if not season:
            return {"active": False}

        prog = get_progress(db, user_id, season.id)
        tier = tier_for_xp(prog.season_xp)
        has_prem = has_premium(db, user_id, season.id)
        claimed_free = _parse_list(prog.claimed_free)
        claimed_premium = _parse_list(prog.claimed_premium)

        tiers = []
        for i in range(1, MAX_TIER + 1):
            free_r = REWARDS[i - 1][0]
            prem_r = REWARDS[i - 1][1]
            tiers.append({
                "tier": i,
                "xp_required": i * XP_PER_TIER,
                "reached": tier >= i,
                "free": {**free_r, "claimed": i in claimed_free},
                "premium": {**prem_r, "claimed": i in claimed_premium},
            })

        ends = _to_aware(season.ends_at)
        now = _now()
        days_left = max(0, (ends - now).days) if ends else 0

        progress_pct = 1.0 if tier >= MAX_TIER else (prog.season_xp - tier * XP_PER_TIER) / XP_PER_TIER

        return {
            "active": True,
            "season": {
                "id": season.id,
                "name": season.name,
                "ends_at": ends.isoformat() if ends else None,
                "days_left": days_left,
            },
            "user": {
                "season_xp": prog.season_xp,
                "tier": tier,
                "has_premium": has_prem,
                "next_tier_xp": (tier + 1) * XP_PER_TIER if tier < MAX_TIER else prog.season_xp,
                "current_tier_xp": tier * XP_PER_TIER,
                "progress_pct": max(0.0, min(1.0, progress_pct)),
            },
            "price": {
                "amount_kobo": PASS_PRICE_KOBO,
                "currency": CURRENCY,
                "label": f"₦{PASS_PRICE_KOBO / 100:,.0f}",
            },
            "tiers": tiers,
        }
    except Exception as e:
        print(f"[battlepass overview error] {e}")
        import traceback
        traceback.print_exc()
        return {"active": False, "error": str(e)}


async def initialize_purchase(db: Session, user_id: str, user_email: str) -> dict:
    if not settings.PAYSTACK_SECRET_KEY:
        return {"ok": False, "error": "Payments not configured"}

    season = get_active_season(db)
    if not season:
        return {"ok": False, "error": "No active season"}

    if has_premium(db, user_id, season.id):
        return {"ok": False, "error": "Already own the premium pass"}

    reference = f"psb_{uuid.uuid4().hex[:24]}"

    row = BattlePassPurchase(
        user_id=user_id,
        season_id=season.id,
        reference=reference,
        amount_kobo=PASS_PRICE_KOBO,
        currency=CURRENCY,
        status="pending",
    )
    db.add(row)
    db.commit()

    callback = settings.PAYSTACK_CALLBACK_URL.replace("/buy/callback", "/battlepass/callback")

    body = {
        "email": user_email,
        "amount": PASS_PRICE_KOBO,
        "currency": CURRENCY,
        "reference": reference,
        "callback_url": callback,
        "metadata": {"user_id": user_id, "season_id": season.id, "type": "battlepass"},
    }
    headers = {
        "Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{settings.PAYSTACK_BASE_URL}/transaction/initialize",
                json=body,
                headers=headers,
            )
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": f"Paystack error: {e}"}

    if not data.get("status"):
        return {"ok": False, "error": data.get("message", "Init failed")}

    return {
        "ok": True,
        "reference": reference,
        "authorization_url": data["data"]["authorization_url"],
    }


async def verify_purchase(db: Session, reference: str) -> dict:
    if not settings.PAYSTACK_SECRET_KEY:
        return {"ok": False, "error": "Payments not configured"}

    row = (
        db.query(BattlePassPurchase)
        .filter(BattlePassPurchase.reference == reference)
        .first()
    )
    if not row:
        return {"ok": False, "error": "Unknown reference"}

    if row.status == "paid":
        return {"ok": True, "already_paid": True}

    headers = {"Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f"{settings.PAYSTACK_BASE_URL}/transaction/verify/{reference}",
                headers=headers,
            )
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": f"Verify failed: {e}"}

    if not data.get("status"):
        return {"ok": False, "error": data.get("message", "Verify failed")}

    tx = data["data"]
    if tx.get("status") != "success":
        row.status = "failed"
        db.commit()
        return {"ok": False, "error": f"Payment not successful: {tx.get('status')}"}

    if int(tx.get("amount", 0)) < row.amount_kobo:
        return {"ok": False, "error": "Amount mismatch"}

    row.status = "paid"
    row.paid_at = _now()
    db.commit()
    return {"ok": True, "season_id": row.season_id}
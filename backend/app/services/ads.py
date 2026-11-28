"""Ads — settings, banners, rewarded video tracking."""

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models.ads import AdSettings, RewardedAdView
from app.services.ledger import grant_tokens
from app.services.premium import is_premium


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def get_settings(db: Session) -> AdSettings:
    row = db.get(AdSettings, 1)
    if not row:
        row = AdSettings(id=1, enabled=False)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _views_today(db: Session, user_id: str) -> int:
    start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        db.query(RewardedAdView)
        .filter(
            RewardedAdView.user_id == user_id,
            RewardedAdView.viewed_at >= start,
        )
        .count()
    )


def config_for_user(db: Session, user_id: str) -> dict:
    s = get_settings(db)
    prem = is_premium(db, user_id)
    viewed = _views_today(db, user_id)
    remaining = max(0, s.rewarded_daily_limit - viewed)
    return {
        "enabled": bool(s.enabled),
        "show_banner": bool(s.enabled) and not prem,  # premium = no ads
        "banner_code": s.banner_code,
        "rewarded_code": s.rewarded_code,
        "rewarded_coins": s.rewarded_coins,
        "rewarded_daily_limit": s.rewarded_daily_limit,
        "rewarded_viewed_today": viewed,
        "rewarded_remaining": remaining,
        "is_premium": prem,
    }


def claim_rewarded(db: Session, user_id: str) -> dict:
    """Called after a user finishes watching a rewarded video."""
    s = get_settings(db)
    if not s.enabled:
        return {"ok": False, "error": "Ads are not enabled"}

    viewed = _views_today(db, user_id)
    if viewed >= s.rewarded_daily_limit:
        return {"ok": False, "error": "Daily limit reached"}

    coins = int(s.rewarded_coins)
    if coins <= 0:
        return {"ok": False, "error": "Reward not configured"}

    db.add(RewardedAdView(user_id=user_id, coins_granted=coins))
    db.commit()

    try:
        grant_tokens(
            db, user_id, coins,
            reason="rewarded_ad",
            idempotency_key=f"ad:{user_id}:{_now().timestamp()}",
        )
        db.commit()
    except Exception as e:
        print(f"[rewarded ad grant error] {e}")

    remaining = max(0, s.rewarded_daily_limit - (viewed + 1))
    return {"ok": True, "coins": coins, "remaining": remaining}


def update_settings(
    db: Session,
    enabled: bool | None = None,
    banner_code: str | None = None,
    rewarded_code: str | None = None,
    rewarded_coins: int | None = None,
    rewarded_daily_limit: int | None = None,
) -> AdSettings:
    s = get_settings(db)
    if enabled is not None: s.enabled = enabled
    if banner_code is not None: s.banner_code = banner_code
    if rewarded_code is not None: s.rewarded_code = rewarded_code
    if rewarded_coins is not None: s.rewarded_coins = max(1, min(1000, rewarded_coins))
    if rewarded_daily_limit is not None: s.rewarded_daily_limit = max(1, min(100, rewarded_daily_limit))
    db.commit()
    db.refresh(s)
    return 
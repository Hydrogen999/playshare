"""Referral system — unique codes + rewards."""

import random
import string
import uuid

from sqlalchemy.orm import Session

from app.models.referral import Referral, ReferralCode
from app.models.user import User
from app.services.ledger import grant_tokens
from app.services.premium import premium_bulk
from app.services.xp import award_xp

REFERRER_REWARD = 500
REFERRED_REWARD = 500
REFERRER_XP = 50
REFERRED_XP = 100

CODE_ALPHABET = string.ascii_uppercase + string.digits
CODE_LEN = 8


def _gen_code() -> str:
    return "".join(random.choices(CODE_ALPHABET, k=CODE_LEN))


def get_or_create_code(db: Session, user_id: str) -> str:
    row = db.get(ReferralCode, user_id)
    if row:
        return row.code

    for _ in range(20):
        code = _gen_code()
        if not db.query(ReferralCode).filter(ReferralCode.code == code).first():
            break
    else:
        code = "PS" + uuid.uuid4().hex[:10].upper()

    row = ReferralCode(user_id=user_id, code=code)
    db.add(row)
    db.commit()
    return code


def apply_referral(db: Session, new_user_id: str, code: str) -> dict:
    """Called after a new user registers. Pays both sides once."""
    code = (code or "").strip().upper()
    if not code:
        return {"ok": False, "error": "No code"}

    row = db.query(ReferralCode).filter(ReferralCode.code == code).first()
    if not row:
        return {"ok": False, "error": "Invalid code"}
    if row.user_id == new_user_id:
        return {"ok": False, "error": "Cannot refer yourself"}

    existing = db.query(Referral).filter(Referral.referred_id == new_user_id).first()
    if existing:
        return {"ok": False, "error": "Already referred"}

    referrer = db.get(User, row.user_id)
    if not referrer:
        return {"ok": False, "error": "Referrer missing"}

    ref = Referral(
        referrer_id=row.user_id,
        referred_id=new_user_id,
        code_used=code,
        reward_paid=False,
    )
    db.add(ref)
    db.commit()

    try:
        grant_tokens(
            db, row.user_id, REFERRER_REWARD,
            reason="referral_reward",
            idempotency_key=f"ref_referrer:{new_user_id}",
        )
        grant_tokens(
            db, new_user_id, REFERRED_REWARD,
            reason="referral_bonus",
            idempotency_key=f"ref_referred:{new_user_id}",
        )
        award_xp(db, row.user_id, REFERRER_XP, "referral")
        award_xp(db, new_user_id, REFERRED_XP, "referral_bonus")
        ref.reward_paid = True
        db.commit()
    except Exception as e:
        print(f"[referral reward error] {e}")

    return {"ok": True, "rewarded": REFERRED_REWARD, "referrer": referrer.username}


def stats_for(db: Session, user_id: str) -> dict:
    code = get_or_create_code(db, user_id)
    rows = (
        db.query(Referral)
        .filter(Referral.referrer_id == user_id)
        .order_by(Referral.created_at.desc())
        .all()
    )
    total = len(rows)
    total_earned = total * REFERRER_REWARD
    total_xp = total * REFERRER_XP

    recent = []
    if rows:
        ids = [r.referred_id for r in rows[:20]]
        users = {u.id: u for u in db.query(User).filter(User.id.in_(ids)).all()}
        premiums = premium_bulk(db, ids)
        for r in rows[:20]:
            u = users.get(r.referred_id)
            if not u:
                continue
            recent.append({
                "user_id": u.id,
                "username": u.username,
                "avatar_id": u.profile.avatar_id if u.profile else "fox",
                "level": u.profile.level if u.profile else 1,
                "is_premium": premiums.get(u.id, False),
                "joined_at": r.created_at.isoformat(),
            })

    return {
        "code": code,
        "total_referrals": total,
        "total_earned_coins": total_earned,
        "total_earned_xp": total_xp,
        "reward_per_referral": REFERRER_REWARD,
        "recent": recent,
    }
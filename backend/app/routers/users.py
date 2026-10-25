from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.match import Match
from app.models.social import Friendship
from app.models.user import User
from app.models.achievement import UserAchievement
from app.schemas.social import UserSearchOut
from app.schemas.user import PublicProfileOut, PublicUserOut
from app.services.cosmetics import get_frame_style, get_frame_styles_bulk
from app.services.elo import tier_for
from app.services.premium import premium_bulk # <-- ADDED

router = APIRouter(prefix="/api/v1/users", tags=["users"])


@router.get("/search", response_model=list[UserSearchOut])
def search_users(
    q: str = Query(min_length=1, max_length=32),
    limit: int = 20,
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    q_lower = q.lower().strip()
    rows = (
        db.query(User)
        .filter(User.username.ilike(f"%{q_lower}%"))
        .order_by(User.username.asc())
        .limit(min(limit, 50))
        .all()
    )

    user_ids = [u.id for u in rows]
    frames = get_frame_styles_bulk(db, user_ids)
    premiums = premium_bulk(db, user_ids) # <-- ADDED

    out: list[UserSearchOut] = []
    for u in rows:
        if u.id == me.id:
            relationship = "self"
        else:
            f = (
                db.query(Friendship)
                .filter(
                    or_(
                        (Friendship.requester_id == me.id) & (Friendship.addressee_id == u.id),
                        (Friendship.requester_id == u.id) & (Friendship.addressee_id == me.id),
                    )
                )
                .first()
            )
            if not f:
                relationship = "none"
            elif f.status == "accepted":
                relationship = "friends"
            elif f.status == "pending":
                relationship = "pending_out" if f.requester_id == me.id else "pending_in"
            else:
                relationship = "none"

        out.append(UserSearchOut(
            id=u.id,
            username=u.username,
            avatar_id=u.profile.avatar_id if u.profile else "fox",
            level=u.profile.level if u.profile else 1,
            relationship=relationship,
            frame_color=frames.get(u.id),
            is_premium=premiums.get(u.id, False), # <-- ADDED
        ))
    return out


@router.get("/{user_id}")
def get_full_profile(
    user_id: str,
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    """Fetch a complete public profile: stats, matches, achievements."""
    u = db.get(User, user_id)
    if not u or not u.profile:
        raise HTTPException(status_code=404, detail="User not found")

    elo = getattr(u.profile, "elo_rating", 1200) or 1200
    tier = tier_for(elo)
    is_prem = premium_bulk(db, [u.id]).get(u.id, False) # <-- ADDED
    
    relationship = "self"
    if u.id != me.id:
        f = (
            db.query(Friendship)
            .filter(
                or_(
                    (Friendship.requester_id == me.id) & (Friendship.addressee_id == u.id),
                    (Friendship.requester_id == u.id) & (Friendship.addressee_id == me.id),
                )
            )
            .first()
        )
        if not f:
            relationship = "none"
        elif f.status == "accepted":
            relationship = "friends"
        elif f.status == "pending":
            relationship = "pending_out" if f.requester_id == me.id else "pending_in"

    matches = (
        db.query(Match)
        .filter(
            or_(Match.player_a == u.id, Match.player_b == u.id),
            Match.status == "finished",
        )
        .order_by(Match.finished_at.desc().nullslast())
        .limit(10)
        .all()
    )

    recent = []
    for m in matches:
        opp_id = m.player_b if m.player_a == u.id else m.player_a
        opp = db.get(User, opp_id)
        is_win = m.winner_id == u.id
        is_draw = m.winner_id is None
        recent.append({
            "game_slug": m.game_slug,
            "result": "draw" if is_draw else ("win" if is_win else "loss"),
            "opponent_username": opp.username if opp else "unknown",
            "wager": m.wager,
        })

    achs = db.query(func.count(UserAchievement.id)).filter(UserAchievement.user_id == u.id).scalar() or 0

    return {
        "id": u.id,
        "username": u.username,
        "role": u.role,
        "avatar_id": u.profile.avatar_id,
        "frame_color": get_frame_style(db, u.id),
        "level": u.profile.level,
        "xp": u.profile.xp,
        "bio": u.profile.bio,
        "country": u.profile.country,
        "elo": elo,
        "chess_tier": tier,
        "relationship": relationship,
        "is_premium": is_prem, # <-- ADDED
        "stats": {
            "achievements_unlocked": achs,
            "coins": u.profile.tokens_cached,
        },
        "recent_matches": recent,
    }

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.social import Friendship
from app.models.user import User
from app.schemas.social import UserSearchOut
from app.schemas.user import PublicProfileOut, PublicUserOut
from app.services.cosmetics import get_frame_style, get_frame_styles_bulk
from app.services.premium import premium_bulk

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
    premiums = premium_bulk(db, user_ids)

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
            is_premium=premiums.get(u.id, False),
        ))
    return out


@router.get("/{user_id}", response_model=PublicUserOut)
def get_user(
    user_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    p = u.profile
    premiums = premium_bulk(db, [u.id])
    return PublicUserOut(
        id=u.id,
        username=u.username,
        role=u.role,
        profile=PublicProfileOut(
            avatar_id=p.avatar_id,
            level=p.level,
            xp=p.xp,
            bio=p.bio,
            country=p.country,
            frame_color=get_frame_style(db, u.id),
            is_premium=premiums.get(u.id, False),
        ),
    )
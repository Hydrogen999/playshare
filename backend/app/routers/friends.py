import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.social import Friendship, Notification
from app.models.user import User
from app.schemas.social import FriendOut, FriendRequestOut
from app.services.cosmetics import get_frame_styles_bulk
from app.services.premium import premium_bulk

router = APIRouter(prefix="/api/v1/friends", tags=["friends"])


def _find_friendship(db: Session, a: str, b: str) -> Friendship | None:
    return (
        db.query(Friendship)
        .filter(
            or_(
                (Friendship.requester_id == a) & (Friendship.addressee_id == b),
                (Friendship.requester_id == b) & (Friendship.addressee_id == a),
            )
        )
        .first()
    )


def _user_summary(db: Session, user_id: str) -> dict:
    u = db.get(User, user_id)
    if not u or not u.profile:
        return {"id": user_id, "username": "unknown", "avatar_id": "fox", "level": 1}
    return {
        "id": u.id,
        "username": u.username,
        "avatar_id": u.profile.avatar_id,
        "level": u.profile.level,
    }


@router.get("", response_model=list[FriendOut])
def list_friends(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Friendship)
        .filter(
            Friendship.status == "accepted",
            or_(Friendship.requester_id == me.id, Friendship.addressee_id == me.id),
        )
        .all()
    )
    other_ids = [
        r.addressee_id if r.requester_id == me.id else r.requester_id
        for r in rows
    ]
    frames = get_frame_styles_bulk(db, other_ids)
    premiums = premium_bulk(db, other_ids)

    out: list[FriendOut] = []
    for r in rows:
        other_id = r.addressee_id if r.requester_id == me.id else r.requester_id
        info = _user_summary(db, other_id)
        out.append(FriendOut(
            id=info["id"],
            username=info["username"],
            avatar_id=info["avatar_id"],
            level=info["level"],
            online=False,
            frame_color=frames.get(other_id),
            is_premium=premiums.get(other_id, False),
        ))
    return out


@router.get("/requests", response_model=list[FriendRequestOut])
def list_requests(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Friendship)
        .filter(Friendship.addressee_id == me.id, Friendship.status == "pending")
        .order_by(Friendship.created_at.desc())
        .all()
    )
    requester_ids = [r.requester_id for r in rows]
    frames = get_frame_styles_bulk(db, requester_ids)
    premiums = premium_bulk(db, requester_ids)

    out: list[FriendRequestOut] = []
    for r in rows:
        info = _user_summary(db, r.requester_id)
        out.append(FriendRequestOut(
            request_id=r.id,
            user_id=info["id"],
            username=info["username"],
            avatar_id=info["avatar_id"],
            level=info["level"],
            created_at=r.created_at.isoformat(),
            frame_color=frames.get(r.requester_id),
            is_premium=premiums.get(r.requester_id, False),
        ))
    return out


@router.post("/request/{user_id}")
def send_request(
    user_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user_id == me.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    existing = _find_friendship(db, me.id, user_id)
    if existing:
        if existing.status == "accepted":
            raise HTTPException(status_code=400, detail="Already friends")
        if existing.status == "pending":
            if existing.addressee_id == me.id:
                existing.status = "accepted"
                db.commit()
                return {"status": "accepted"}
            raise HTTPException(status_code=400, detail="Request already sent")
        existing.status = "pending"
        existing.requester_id = me.id
        existing.addressee_id = user_id
        db.commit()
        return {"status": "pending"}

    f = Friendship(requester_id=me.id, addressee_id=user_id, status="pending")
    db.add(f)
    db.flush()

    notif = Notification(
        user_id=user_id,
        type="friend_request",
        payload=json.dumps({
            "from_id": me.id,
            "from_username": me.username,
            "from_avatar": me.profile.avatar_id if me.profile else "fox",
            "from_level": me.profile.level if me.profile else 1,
            "request_id": f.id,
        }),
    )
    db.add(notif)
    db.commit()
    return {"status": "pending"}


@router.post("/accept/{user_id}")
def accept_request(
    user_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    f = _find_friendship(db, me.id, user_id)
    if not f or f.status != "pending":
        raise HTTPException(status_code=404, detail="No pending request")
    if f.addressee_id != me.id:
        raise HTTPException(status_code=403, detail="Not your request to accept")
    f.status = "accepted"

    notif = Notification(
        user_id=user_id,
        type="friend_accepted",
        payload=json.dumps({
            "from_id": me.id,
            "from_username": me.username,
            "from_avatar": me.profile.avatar_id if me.profile else "fox",
            "from_level": me.profile.level if me.profile else 1,
        }),
    )
    db.add(notif)
    db.commit()
    return {"status": "accepted"}


@router.post("/decline/{user_id}")
def decline_request(
    user_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    f = _find_friendship(db, me.id, user_id)
    if not f or f.status != "pending":
        raise HTTPException(status_code=404, detail="No pending request")
    if f.addressee_id != me.id:
        raise HTTPException(status_code=403, detail="Not your request")
    f.status = "declined"
    db.commit()
    return {"status": "declined"}


@router.delete("/{user_id}")
def remove_friend(
    user_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    f = _find_friendship(db, me.id, user_id)
    if not f:
        raise HTTPException(status_code=404, detail="Not friends")
    db.delete(f)
    db.commit()
    return {"status": "removed"}
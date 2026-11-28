import json
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.social import Friendship, Notification, Status, StatusView
from app.models.user import User
from app.schemas.social import FriendOut, FriendRequestOut
from app.services.cosmetics import get_frame_styles_bulk
from app.services.media import BadMedia, MAX_ANY, save_media
from app.services.premium import premium_bulk
from app.services.safety import blocked_ids, can_see, check_interaction, peek_safety
from app.services.userextra import extras

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
def list_friends(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(Friendship)
        .filter(
            Friendship.status == "accepted",
            or_(Friendship.requester_id == me.id, Friendship.addressee_id == me.id),
        )
        .all()
    )
    other_ids = [r.addressee_id if r.requester_id == me.id else r.requester_id for r in rows]
    frames = get_frame_styles_bulk(db, other_ids)
    premiums = premium_bulk(db, other_ids)
    ex = extras(db, other_ids)

    out: list[FriendOut] = []
    for r in rows:
        other_id = r.addressee_id if r.requester_id == me.id else r.requester_id
        info = _user_summary(db, other_id)
        out.append(FriendOut(
            id=info["id"], username=info["username"], avatar_id=info["avatar_id"],
            level=info["level"], online=False, frame_color=frames.get(other_id),
            is_premium=premiums.get(other_id, False), streak_count=r.streak_count,
            avatar_url=ex[other_id]["avatar_url"], is_verified=ex[other_id]["is_verified"],
        ))
    return out


@router.get("/requests", response_model=list[FriendRequestOut])
def list_requests(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(Friendship)
        .filter(Friendship.addressee_id == me.id, Friendship.status == "pending")
        .order_by(Friendship.created_at.desc())
        .all()
    )
    requester_ids = [r.requester_id for r in rows]
    frames = get_frame_styles_bulk(db, requester_ids)
    premiums = premium_bulk(db, requester_ids)
    ex = extras(db, requester_ids)

    out: list[FriendRequestOut] = []
    for r in rows:
        info = _user_summary(db, r.requester_id)
        out.append(FriendRequestOut(
            request_id=r.id, user_id=info["id"], username=info["username"],
            avatar_id=info["avatar_id"], level=info["level"], created_at=r.created_at.isoformat(),
            frame_color=frames.get(r.requester_id), is_premium=premiums.get(r.requester_id, False),
            avatar_url=ex[r.requester_id]["avatar_url"], is_verified=ex[r.requester_id]["is_verified"],
        ))
    return out


@router.post("/request/{user_id}")
def send_request(user_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if user_id == me.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    why = check_interaction(db, me.id, user_id, "add")
    if why:
        raise HTTPException(status_code=403, detail=why)

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
        user_id=user_id, type="friend_request",
        payload=json.dumps({"from_id": me.id, "from_username": me.username, "from_avatar": me.profile.avatar_id if me.profile else "fox", "from_level": me.profile.level if me.profile else 1, "request_id": f.id}),
    )
    db.add(notif)
    db.commit()
    return {"status": "pending"}


@router.post("/accept/{user_id}")
def accept_request(user_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    f = _find_friendship(db, me.id, user_id)
    if not f or f.status != "pending":
        raise HTTPException(status_code=404, detail="No pending request")
    if f.addressee_id != me.id:
        raise HTTPException(status_code=403, detail="Not your request to accept")
    f.status = "accepted"

    notif = Notification(
        user_id=user_id, type="friend_accepted",
        payload=json.dumps({"from_id": me.id, "from_username": me.username, "from_avatar": me.profile.avatar_id if me.profile else "fox", "from_level": me.profile.level if me.profile else 1}),
    )
    db.add(notif)
    db.commit()
    return {"status": "accepted"}


@router.post("/decline/{user_id}")
def decline_request(user_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    f = _find_friendship(db, me.id, user_id)
    if not f or f.status != "pending":
        raise HTTPException(status_code=404, detail="No pending request")
    if f.addressee_id != me.id:
        raise HTTPException(status_code=403, detail="Not your request")
    f.status = "declined"
    db.commit()
    return {"status": "declined"}


@router.delete("/{user_id}")
def remove_friend(user_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    f = _find_friendship(db, me.id, user_id)
    if not f:
        raise HTTPException(status_code=404, detail="Not friends")
    db.delete(f)
    db.commit()
    return {"status": "removed"}


# ---------------------------------------------------------------------------
# STATUS / STORIES ENDPOINTS
# ---------------------------------------------------------------------------

@router.post("/status")
async def create_status(
    content: str = Form(""),
    game_invite: str | None = Form(None),
    media: UploadFile | None = File(None),
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    today = datetime.now(timezone.utc).date()
    count = db.query(Status).filter(
        Status.user_id == me.id,
        func.date(Status.created_at) == today
    ).count()
    
    if count >= 20:
        raise HTTPException(400, "You can only post 20 statuses per day.")

    media_url = None
    if media:
        data = await media.read(MAX_ANY + 1)
        try:
            media_url = save_media(db, me.id, data, media.filename or "", only=("image", "video"))
        except BadMedia as e:
            raise HTTPException(400, str(e))

    expires = datetime.now(timezone.utc) + timedelta(hours=24)
    s = Status(
        user_id=me.id, content=content[:255] if content else "",
        game_invite=game_invite, media_url=media_url, expires_at=expires,
    )
    db.add(s)
    db.commit()
    return {"ok": True}


@router.get("/status/feed")
def get_status_feed(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    statuses = db.query(Status).filter(Status.expires_at > now).all()
    
    out = []
    ex = extras(db, list({s.user_id for s in statuses}))
    for s in statuses:
        u = db.get(User, s.user_id)
        if not u or not u.profile: continue
        
        # Determine relation & SKIP STRANGERS
        if s.user_id == me.id:
            relation = "self"
        else:
            rel = _find_friendship(db, me.id, s.user_id)
            if not rel or rel.status != "accepted":
                continue # <--- THIS FIXES THE STRANGER ISSUE
            relation = "friend"

        viewers = []
        if s.user_id == me.id:
            views = db.query(StatusView).filter(StatusView.status_id == s.id).all()
            for v in views:
                vu = db.get(User, v.viewer_id)
                if vu:
                    viewers.append({"user_id": vu.id, "username": vu.username, "avatar_id": vu.profile.avatar_id})

        out.append({
            "id": s.id, "user_id": s.user_id, "username": u.username,
            "avatar_id": u.profile.avatar_id, "content": s.content,
            "game_invite": s.game_invite, "media_url": s.media_url,
            "relation": relation, "created_at": s.created_at.isoformat(),
            "avatar_url": ex.get(s.user_id, {}).get("avatar_url"),
            "is_verified": ex.get(s.user_id, {}).get("is_verified", False),
            "viewers": viewers
        })
    return out


@router.post("/status/{status_id}/view")
def mark_status_view(status_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    st = db.get(Status, status_id)
    if not st:
        raise HTTPException(404, "Status not found")
    if st.user_id != me.id:
        rel = _find_friendship(db, me.id, st.user_id)
        if not rel or rel.status != "accepted":
            raise HTTPException(403, "Not allowed")
    existing = db.query(StatusView).filter(StatusView.status_id == status_id, StatusView.viewer_id == me.id).first()
    if not existing:
        v = StatusView(status_id=status_id, viewer_id=me.id)
        db.add(v)
        db.commit()
    return {"ok": True}



def _local_today(offset_min: int) -> tuple[int, int]:
    """(month, day) right now in the viewer's own timezone."""
    t = datetime.now(timezone.utc) + timedelta(minutes=max(-840, min(840, offset_min)))
    return t.month, t.day


@router.get("/birthdays")
def birthdays(offset_min: int = Query(0), me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Who has a birthday today: you, and friends who allow you to see it."""
    from app.models.safety import UserSafety
    month, day = _local_today(offset_min)
    mine = peek_safety(db, me.id)
    is_me = mine["birth_month"] == month and mine["birth_day"] == day

    rows = (
        db.query(Friendship)
        .filter(Friendship.status == "accepted", or_(Friendship.requester_id == me.id, Friendship.addressee_id == me.id))
        .all()
    )
    ids = [r.addressee_id if r.requester_id == me.id else r.requester_id for r in rows]
    if not ids:
        return {"me": is_me, "friends": []}
    cands = db.query(UserSafety).filter(UserSafety.user_id.in_(ids), UserSafety.birth_month == month, UserSafety.birth_day == day).all()
    out = []
    ex = extras(db, [c.user_id for c in cands])
    for c in cands:
        if not can_see(db, me.id, c.user_id, "birthday"):
            continue
        u = db.get(User, c.user_id)
        if not u or not u.profile or u.is_banned:
            continue
        out.append({"id": u.id, "username": u.username, "avatar_id": u.profile.avatar_id,
                    "avatar_url": ex[u.id]["avatar_url"], "is_verified": ex[u.id]["is_verified"]})
    return {"me": is_me, "friends": out}


@router.get("/suggestions")
def suggestions(limit: int = 15, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """People you may know: friends of friends first, then recently active players."""
    from app.models.safety import UserSafety
    limit = max(1, min(limit, 30))
    related = db.query(Friendship).filter(or_(Friendship.requester_id == me.id, Friendship.addressee_id == me.id)).all()
    skip = {me.id} | blocked_ids(db, me.id)
    friends = set()
    for r in related:
        other = r.addressee_id if r.requester_id == me.id else r.requester_id
        skip.add(other)
        if r.status == "accepted":
            friends.add(other)

    mutual: dict[str, int] = {}
    if friends:
        fof = db.query(Friendship).filter(
            Friendship.status == "accepted",
            or_(Friendship.requester_id.in_(friends), Friendship.addressee_id.in_(friends))).all()
        for r in fof:
            for a, b in ((r.requester_id, r.addressee_id), (r.addressee_id, r.requester_id)):
                if a in friends and b not in skip:
                    mutual[b] = mutual.get(b, 0) + 1
    ranked = [uid for uid, _n in sorted(mutual.items(), key=lambda kv: -kv[1])]

    if len(ranked) < limit:
        more = (db.query(User).filter(User.is_banned.is_(False), ~User.id.in_(list(skip | set(ranked))))
                .order_by(User.created_at.desc()).limit(limit * 3).all())
        ranked += [u.id for u in more]

    closed = {r.user_id for r in db.query(UserSafety).filter(UserSafety.user_id.in_(ranked), UserSafety.p_add == "nobody").all()} if ranked else set()
    ranked = [i for i in ranked if i not in closed][:limit]
    ex = extras(db, ranked)
    frames = get_frame_styles_bulk(db, ranked)
    prem = premium_bulk(db, ranked)
    out = []
    for uid in ranked:
        u = db.get(User, uid)
        if not u or not u.profile:
            continue
        out.append({"id": u.id, "username": u.username, "avatar_id": u.profile.avatar_id,
                    "avatar_url": ex[uid]["avatar_url"], "level": u.profile.level,
                    "frame_color": frames.get(uid), "is_premium": prem.get(uid, False),
                    "is_verified": ex[uid]["is_verified"], "mutual": mutual.get(uid, 0)})
    return out

import json
import os
import shutil
import uuid
from datetime import datetime, timezone, date, timedelta
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.social import DirectMessage, Notification, Friendship
from app.models.user import User
from app.schemas.social import ConversationOut, DMOut, SendDMIn
from app.services.premium import premium_bulk

router = APIRouter(prefix="/api/v1/dm", tags=["dm"])

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
UPLOAD_DIR = os.path.join(BASE_DIR, "frontend", "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

def _is_premium(db: Session, user_id: str) -> bool:
    return premium_bulk(db, [user_id]).get(user_id, False)

def _update_streak(db: Session, me_id: str, other_id: str):
    f = db.query(Friendship).filter(
        or_(
            and_(Friendship.requester_id == me_id, Friendship.addressee_id == other_id),
            and_(Friendship.requester_id == other_id, Friendship.addressee_id == me_id),
        )
    ).first()
    
    if not f or f.status != "accepted":
        return

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if f.last_streak_date == today:
        return

    if f.last_streak_date:
        last_date = datetime.strptime(f.last_streak_date, "%Y-%m-%d").date()
        today_date = date.today()
        delta = (today_date - last_date).days
        
        if delta == 1:
            f.streak_count += 1
        elif delta >= 5:
            f.streak_count = 1 
        elif delta >= 2:
            f.streak_count = 1
    else:
        f.streak_count = 1

    f.last_streak_date = today
    db.commit()

@router.post("/streak/{friend_id}/restore")
def restore_streak(friend_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    f = db.query(Friendship).filter(
        or_(
            and_(Friendship.requester_id == me.id, Friendship.addressee_id == friend_id),
            and_(Friendship.requester_id == friend_id, Friendship.addressee_id == me.id),
        )
    ).first()
    
    if not f:
        raise HTTPException(404, "Friendship not found")
        
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    f.last_streak_date = today
    db.commit()
    return {"ok": True, "streak_count": f.streak_count}

@router.get("", response_model=list[ConversationOut])
def list_conversations(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # --- FIX: ONLY GET DIRECT MESSAGES (group_id is null) ---
    rows = (
        db.query(DirectMessage)
        .filter(
            or_(DirectMessage.sender_id == me.id, DirectMessage.recipient_id == me.id),
            DirectMessage.group_id.is_(None) 
        )
        .order_by(DirectMessage.created_at.desc())
        .all()
    )

    seen: set[str] = set()
    convos: list[ConversationOut] = []
    
    friendships = db.query(Friendship).filter(
        Friendship.status == "accepted",
        or_(Friendship.requester_id == me.id, Friendship.addressee_id == me.id)
    ).all()
    streak_map = { (f.addressee_id if f.requester_id == me.id else f.requester_id): f.streak_count for f in friendships }

    for m in rows:
        other = m.recipient_id if m.sender_id == me.id else m.sender_id
        if not other or other in seen: # Safety check
            continue
        seen.add(other)
        u = db.get(User, other)
        unread = db.query(DirectMessage).filter(
            DirectMessage.sender_id == other,
            DirectMessage.recipient_id == me.id,
            DirectMessage.read_at.is_(None),
        ).count()
        
        convos.append(ConversationOut(
            user_id=other,
            username=u.username if u else "unknown",
            avatar_id=u.profile.avatar_id if u and u.profile else "fox",
            last_message=m.content[:80] or "📷 Image",
            last_at=m.created_at.isoformat(),
            unread_count=unread,
            streak=streak_map.get(other, 0)
        ))
    return convos

@router.post("/upload")
async def upload_chat_media(
    file: UploadFile = File(...),
    me: User = Depends(get_current_user),
):
    if not file.content_type or not file.content_type.startswith(("image/", "audio/", "video/")):
        raise HTTPException(status_code=400, detail="Invalid file type")
    
    ext = file.filename.split(".")[-1] if file.filename else "bin"
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    try:
        with open(filepath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        print(f"[UPLOAD ERROR] {e}")
        raise HTTPException(status_code=500, detail="Could not save file")
        
    return {"url": f"/static/uploads/{filename}"}

@router.get("/{user_id}", response_model=list[DMOut])
def get_conversation(user_id: str, limit: int = 100, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    retention = me.profile.chat_retention_days or 1
    if not _is_premium(db, me.id) and retention > 1:
        retention = 1
        
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention)

    # --- FIX: ONLY GET DIRECT MESSAGES (group_id is null) ---
    rows = (
        db.query(DirectMessage)
        .filter(
            or_(
                and_(DirectMessage.sender_id == me.id, DirectMessage.recipient_id == user_id),
                and_(DirectMessage.sender_id == user_id, DirectMessage.recipient_id == me.id),
            ),
            DirectMessage.group_id.is_(None),
            DirectMessage.created_at >= cutoff 
        )
        .order_by(DirectMessage.created_at.asc())
        .limit(min(limit, 500))
        .all()
    )

    changed = False
    for m in rows:
        if m.recipient_id == me.id and m.read_at is None:
            m.read_at = datetime.now(timezone.utc)
            changed = True
    if changed: db.commit()

    return [
        DMOut(
            id=m.id, sender_id=m.sender_id, recipient_id=m.recipient_id,
            content=m.content, media_url=m.media_url, read=m.read_at is not None,
            created_at=m.created_at.isoformat(),
        )
        for m in rows
    ]

@router.post("/{user_id}", response_model=DMOut)
def send_dm(
    user_id: str,
    content: str = Form(""),
    media: UploadFile | None = File(None),
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user_id == me.id:
        raise HTTPException(400, "Cannot DM yourself")
    
    if media and not _is_premium(db, me.id):
        raise HTTPException(403, "Only Premium users can send images. Upgrade to Premium!")

    media_url = None
    if media:
        ext = media.filename.split(".")[-1]
        filename = f"dm_{uuid.uuid4().hex}.{ext}"
        filepath = os.path.join(UPLOAD_DIR, filename)
        with open(filepath, "wb") as buffer:
            shutil.copyfileobj(media.file, buffer)
        media_url = f"/static/uploads/{filename}"

    if not content and not media_url:
        raise HTTPException(400, "Empty message")

    m = DirectMessage(sender_id=me.id, recipient_id=user_id, content=content[:1000], media_url=media_url)
    db.add(m)
    db.flush()

    _update_streak(db, me.id, user_id)

    notif = Notification(
        user_id=user_id, type="dm",
        payload=json.dumps({
            "from_id": me.id, "from_username": me.username,
            "from_avatar": me.profile.avatar_id if me.profile else "fox",
            "message_id": m.id, "preview": content[:60] if content else "📷 Image",
        }),
    )
    db.add(notif)
    db.commit()
    db.refresh(m)

    return DMOut(
        id=m.id, sender_id=m.sender_id, recipient_id=m.recipient_id,
        content=m.content, media_url=m.media_url, read=False,
        created_at=m.created_at.isoformat(),
    )

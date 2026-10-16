import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.social import DirectMessage, Notification
from app.models.user import User
from app.schemas.social import ConversationOut, DMOut, SendDMIn

router = APIRouter(prefix="/api/v1/dm", tags=["dm"])


@router.get("", response_model=list[ConversationOut])
def list_conversations(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Get all DMs involving me, ordered newest first
    rows = (
        db.query(DirectMessage)
        .filter(
            or_(
                DirectMessage.sender_id == me.id,
                DirectMessage.recipient_id == me.id,
            )
        )
        .order_by(DirectMessage.created_at.desc())
        .all()
    )

    seen: set[str] = set()
    convos: list[ConversationOut] = []
    for m in rows:
        other = m.recipient_id if m.sender_id == me.id else m.sender_id
        if other in seen:
            continue
        seen.add(other)
        u = db.get(User, other)
        unread = (
            db.query(DirectMessage)
            .filter(
                DirectMessage.sender_id == other,
                DirectMessage.recipient_id == me.id,
                DirectMessage.read_at.is_(None),
            )
            .count()
        )
        convos.append(ConversationOut(
            user_id=other,
            username=u.username if u else "unknown",
            avatar_id=u.profile.avatar_id if u and u.profile else "fox",
            last_message=m.content[:80],
            last_at=m.created_at.isoformat(),
            unread_count=unread,
        ))
    return convos


@router.get("/{user_id}", response_model=list[DMOut])
def get_conversation(
    user_id: str,
    limit: int = 100,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(DirectMessage)
        .filter(
            or_(
                and_(
                    DirectMessage.sender_id == me.id,
                    DirectMessage.recipient_id == user_id,
                ),
                and_(
                    DirectMessage.sender_id == user_id,
                    DirectMessage.recipient_id == me.id,
                ),
            )
        )
        .order_by(DirectMessage.created_at.asc())
        .limit(min(limit, 500))
        .all()
    )

    # Mark received as read
    changed = False
    for m in rows:
        if m.recipient_id == me.id and m.read_at is None:
            m.read_at = datetime.now(timezone.utc)
            changed = True
    if changed:
        db.commit()

    return [
        DMOut(
            id=m.id,
            sender_id=m.sender_id,
            recipient_id=m.recipient_id,
            content=m.content,
            read=m.read_at is not None,
            created_at=m.created_at.isoformat(),
        )
        for m in rows
    ]


@router.post("/{user_id}", response_model=DMOut)
def send_dm(
    user_id: str,
    data: SendDMIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user_id == me.id:
        raise HTTPException(status_code=400, detail="Cannot DM yourself")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    content = data.content.strip()[:1000]
    if not content:
        raise HTTPException(status_code=400, detail="Empty message")

    m = DirectMessage(sender_id=me.id, recipient_id=user_id, content=content)
    db.add(m)
    db.flush()

    notif = Notification(
        user_id=user_id,
        type="dm",
        payload=json.dumps({
            "from_id": me.id,
            "from_username": me.username,
            "from_avatar": me.profile.avatar_id if me.profile else "fox",
            "message_id": m.id,
            "preview": content[:60],
        }),
    )
    db.add(notif)
    db.commit()
    db.refresh(m)

    return DMOut(
        id=m.id,
        sender_id=m.sender_id,
        recipient_id=m.recipient_id,
        content=m.content,
        read=False,
        created_at=m.created_at.isoformat(),
    )
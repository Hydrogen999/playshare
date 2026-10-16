import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.social import Notification
from app.models.user import User
from app.schemas.social import NotificationOut

router = APIRouter(prefix="/api/v1/me/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    limit: int = 50,
    unread_only: bool = False,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(Notification).filter(Notification.user_id == me.id)
    if unread_only:
        q = q.filter(Notification.read_at.is_(None))
    rows = q.order_by(Notification.created_at.desc()).limit(min(limit, 200)).all()
    out: list[NotificationOut] = []
    for n in rows:
        try:
            payload = json.loads(n.payload) if n.payload else {}
        except Exception:
            payload = {}
        out.append(NotificationOut(
            id=n.id,
            type=n.type,
            payload=payload,
            read=n.read_at is not None,
            created_at=n.created_at.isoformat(),
        ))
    return out


@router.get("/count")
def unread_count(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    c = (
        db.query(Notification)
        .filter(Notification.user_id == me.id, Notification.read_at.is_(None))
        .count()
    )
    return {"count": c}


@router.post("/read-all")
def mark_all_read(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    db.query(Notification).filter(
        Notification.user_id == me.id,
        Notification.read_at.is_(None),
    ).update({Notification.read_at: now})
    db.commit()
    return {"status": "ok"}


@router.post("/{notification_id}/read")
def mark_read(
    notification_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    n = db.get(Notification, notification_id)
    if n and n.user_id == me.id and n.read_at is None:
        n.read_at = datetime.now(timezone.utc)
        db.commit()
    return {"status": "ok"}
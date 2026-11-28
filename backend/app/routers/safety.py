import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_admin
from app.models.push import DeviceToken, PushSettings
from app.models.safety import (
    EmailCode, MediaFile, UserBlock, UserPhoto, UserReport, UserSafety,
)
from app.models.social import (
    ChatGroupMember, DirectMessage, Friendship, MessageReaction, Notification, Status, StatusView,
)
from app.models.user import User
from app.models.verification import VerificationDocument
from app.security import hash_password, verify_password
from app.services.ratelimit import guard
from app.services.safety import get_safety, peek_safety
from app.services.safety_rules import MIN_AGE, PRIVACY, parse_birthday
from app.services.userextra import photos_bulk
from fastapi import Request

router = APIRouter(prefix="/api/v1/safety", tags=["safety"])

REASONS = {"spam", "harassment", "hate", "nudity", "violence", "scam", "impersonation", "underage", "self_harm", "other"}


# --------------------------------------------------------------- blocking
@router.post("/block/{user_id}")
def block_user(user_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if user_id == me.id:
        raise HTTPException(400, "You cannot block yourself.")
    if not db.get(User, user_id):
        raise HTTPException(404, "User not found.")
    if not db.get(UserBlock, (me.id, user_id)):
        db.add(UserBlock(blocker_id=me.id, blocked_id=user_id))
    # Blocking also ends the friendship and drops pending requests.
    db.query(Friendship).filter(
        or_((Friendship.requester_id == me.id) & (Friendship.addressee_id == user_id),
            (Friendship.requester_id == user_id) & (Friendship.addressee_id == me.id))
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@router.delete("/block/{user_id}")
def unblock_user(user_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(UserBlock).filter(UserBlock.blocker_id == me.id, UserBlock.blocked_id == user_id).delete()
    db.commit()
    return {"ok": True}


@router.get("/blocks")
def list_blocks(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(UserBlock).filter(UserBlock.blocker_id == me.id).order_by(UserBlock.created_at.desc()).all()
    ids = [r.blocked_id for r in rows]
    users = {u.id: u for u in db.query(User).filter(User.id.in_(ids)).all()} if ids else {}
    photos = photos_bulk(db, ids)
    return [{"id": i, "username": users[i].username if i in users else "unknown",
             "avatar_id": users[i].profile.avatar_id if i in users and users[i].profile else "default",
             "avatar_url": photos.get(i)} for i in ids]


# --------------------------------------------------------------- reporting
class ReportIn(BaseModel):
    target_type: str
    target_id: str
    reason: str
    details: str = ""


@router.post("/report")
def report(data: ReportIn, request: Request, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    guard(request, "report", 20, 24 * 3600, me.id)
    if data.target_type not in ("user", "message", "status"):
        raise HTTPException(400, "Unknown report type.")
    reason = data.reason.strip().lower().replace(" ", "_")[:40]
    if reason not in REASONS:
        reason = "other"
    details = data.details.strip()[:1000]

    reported: str | None = None
    if data.target_type == "user":
        if not db.get(User, data.target_id):
            raise HTTPException(404, "User not found.")
        reported = data.target_id
    elif data.target_type == "message":
        m = db.get(DirectMessage, data.target_id)
        if not m:
            raise HTTPException(404, "Message not found.")
        in_dm = me.id in (m.sender_id, m.recipient_id)
        in_group = bool(m.group_id) and db.get(ChatGroupMember, (m.group_id, me.id)) is not None
        if not (in_dm or in_group):          # you can only report what you could see
            raise HTTPException(404, "Message not found.")
        reported = m.sender_id
    else:
        s = db.get(Status, data.target_id)
        if not s:
            raise HTTPException(404, "Status not found.")
        reported = s.user_id
    if reported == me.id:
        raise HTTPException(400, "You cannot report yourself.")

    dup = db.query(UserReport).filter(UserReport.reporter_id == me.id, UserReport.target_type == data.target_type,
                                      UserReport.target_id == data.target_id, UserReport.status == "open").first()
    if not dup:
        db.add(UserReport(reporter_id=me.id, target_type=data.target_type, target_id=data.target_id,
                          reported_user_id=reported, reason=reason, details=details))
        db.commit()
    return {"ok": True}


@router.get("/admin/reports")
def admin_reports(status: str = "open", limit: int = 50, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.query(UserReport).filter(UserReport.status == status).order_by(UserReport.created_at.desc()).limit(min(limit, 200)).all()
    names = {u.id: u.username for u in db.query(User).filter(User.id.in_({x for r in rows for x in (r.reporter_id, r.reported_user_id) if x})).all()} if rows else {}
    return [{"id": r.id, "target_type": r.target_type, "target_id": r.target_id, "reason": r.reason, "details": r.details,
             "reporter": names.get(r.reporter_id), "reported_user_id": r.reported_user_id,
             "reported": names.get(r.reported_user_id), "created_at": r.created_at.isoformat()} for r in rows]


class ResolveIn(BaseModel):
    action: str          # dismiss | actioned | ban


@router.post("/admin/reports/{report_id}/resolve")
def admin_resolve(report_id: str, data: ResolveIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    r = db.get(UserReport, report_id)
    if not r:
        raise HTTPException(404, "Report not found.")
    if data.action not in ("dismiss", "actioned", "ban"):
        raise HTTPException(400, "Unknown action.")
    if data.action == "ban" and r.reported_user_id:
        target = db.get(User, r.reported_user_id)
        if target and target.role != "admin":
            target.is_banned = True
    r.status = "dismissed" if data.action == "dismiss" else "actioned"
    r.reviewed_by, r.reviewed_at = admin.id, datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


# ----------------------------------------------------------------- privacy
def _privacy_payload(db: Session, uid: str) -> dict:
    p = peek_safety(db, uid)
    out = {k: p[k] for k in PRIVACY}
    out["has_birthday"] = p["birth_month"] is not None
    out["birthday_month"] = p["birth_month"]
    out["birthday_day"] = p["birth_day"]
    return out


@router.get("/privacy")
def get_privacy(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _privacy_payload(db, me.id)


@router.post("/privacy")
def set_privacy(changes: dict[str, str], me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = get_safety(db, me.id)
    for key, value in changes.items():
        spec = PRIVACY.get(key)
        if not spec:
            continue
        col, allowed_values, _default = spec
        if value not in allowed_values:
            raise HTTPException(400, f"Invalid value for {key}.")
        setattr(row, col, value)
    db.commit()
    return _privacy_payload(db, me.id)


class BirthdayIn(BaseModel):
    month: int
    day: int
    year: int


@router.post("/birthday")
def set_birthday(data: BirthdayIn, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = get_safety(db, me.id)
    if row.birth_month is not None:
        raise HTTPException(409, "Your birthday is already set. Contact support to change it.")
    try:
        d = parse_birthday(data.month, data.day, data.year)
    except ValueError as e:
        raise HTTPException(400, str(e))
    row.birth_month, row.birth_day, row.birth_year = d.month, d.day, d.year
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------- delete account
class DeleteIn(BaseModel):
    password: str


@router.post("/delete-account")
def delete_account(data: DeleteIn, request: Request, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    guard(request, "delete", 5, 3600, me.id)
    if not verify_password(data.password, me.password_hash):
        raise HTTPException(403, "Wrong password.")
    uid = me.id
    # 1) remove personal data
    db.query(Friendship).filter(or_(Friendship.requester_id == uid, Friendship.addressee_id == uid)).delete(synchronize_session=False)
    mine = [m.id for m in db.query(DirectMessage.id).filter(or_(DirectMessage.sender_id == uid, DirectMessage.recipient_id == uid)).all()]
    if mine:
        db.query(MessageReaction).filter(MessageReaction.message_id.in_(mine)).delete(synchronize_session=False)
        db.query(DirectMessage).filter(DirectMessage.id.in_(mine)).delete(synchronize_session=False)
    db.query(MessageReaction).filter(MessageReaction.user_id == uid).delete(synchronize_session=False)
    db.query(Notification).filter(Notification.user_id == uid).delete(synchronize_session=False)
    sids = [s.id for s in db.query(Status.id).filter(Status.user_id == uid).all()]
    if sids:
        db.query(StatusView).filter(StatusView.status_id.in_(sids)).delete(synchronize_session=False)
    db.query(Status).filter(Status.user_id == uid).delete(synchronize_session=False)
    db.query(StatusView).filter(StatusView.viewer_id == uid).delete(synchronize_session=False)
    db.query(ChatGroupMember).filter(ChatGroupMember.user_id == uid).delete(synchronize_session=False)
    db.query(UserBlock).filter(or_(UserBlock.blocker_id == uid, UserBlock.blocked_id == uid)).delete(synchronize_session=False)
    db.query(UserReport).filter(UserReport.reporter_id == uid).delete(synchronize_session=False)
    db.query(UserSafety).filter(UserSafety.user_id == uid).delete(synchronize_session=False)
    db.query(UserPhoto).filter(UserPhoto.user_id == uid).delete(synchronize_session=False)
    db.query(MediaFile).filter(MediaFile.owner_id == uid).delete(synchronize_session=False)
    db.query(EmailCode).filter(EmailCode.email == me.email).delete(synchronize_session=False)
    db.query(DeviceToken).filter(DeviceToken.user_id == uid).delete(synchronize_session=False)
    db.query(PushSettings).filter(PushSettings.user_id == uid).delete(synchronize_session=False)
    from app.models.verification import VerificationApplication
    app_ids = [a.id for a in db.query(VerificationApplication.id).filter(VerificationApplication.user_id == uid).all()]
    if app_ids:   # ID documents are wiped; payment/audit rows stay for accounting
        db.query(VerificationDocument).filter(VerificationDocument.application_id.in_(app_ids)).update(
            {"data": None, "deleted_at": datetime.now(timezone.utc)}, synchronize_session=False)
    # 2) anonymise the account row so game/ledger history keeps working
    me.email = f"deleted-{uid}@deleted.invalid"
    me.username = f"deleted_{uid[:8]}"
    me.password_hash = hash_password(secrets.token_urlsafe(32))
    me.is_banned = True
    if me.profile:
        me.profile.bio = ""
        me.profile.country = ""
        me.profile.avatar_id = "default"
    db.commit()
    return {"ok": True}

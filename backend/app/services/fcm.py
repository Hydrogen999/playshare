"""Send push notifications through Firebase Cloud Messaging (HTTP v1).

Needs the `google-auth` and `requests` packages and the FCM_SERVICE_ACCOUNT_JSON
environment variable. If either is missing every function quietly does nothing,
so the rest of the app is never affected.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models.push import DeviceToken, PushSettings

log = logging.getLogger(__name__)
_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_creds = None
_project = None


def enabled() -> bool:
    return bool(settings.FCM_SERVICE_ACCOUNT_JSON)


def _access_token() -> tuple[str, str] | None:
    global _creds, _project
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError:
        return None
    if _creds is None:
        info = json.loads(settings.FCM_SERVICE_ACCOUNT_JSON)
        _creds = service_account.Credentials.from_service_account_info(info, scopes=[_SCOPE])
        _project = info["project_id"]
    if not _creds.valid:
        _creds.refresh(Request())
    return _creds.token, _project


def _wants(db: Session, user_id: str, kind: str) -> bool:
    s = db.get(PushSettings, user_id)
    if s is None:
        return True
    if not s.enabled:
        return False
    return {"dm": s.on_dm, "friend": s.on_friend, "challenge": s.on_challenge}.get(kind, True)


def send_to_user(user_id: str, data: dict, *, title: str | None = None, body: str | None = None,
                 kind: str = "dm", high_priority: bool = False) -> int:
    """Blocking. Returns how many devices accepted it. Run with asyncio.to_thread."""
    if not enabled():
        return 0
    try:
        import requests
        tok = _access_token()
        if not tok:
            return 0
        access, project = tok
        with SessionLocal() as db:
            if kind != "call" and not _wants(db, user_id, kind):
                return 0
            tokens = [t.token for t in db.query(DeviceToken).filter(DeviceToken.user_id == user_id).all()]
            ok = 0
            for t in tokens:
                msg: dict = {"token": t, "data": {k: str(v) for k, v in data.items() if v is not None}}
                if title:
                    msg["notification"] = {"title": title, "body": body or ""}
                if high_priority:
                    msg["android"] = {"priority": "HIGH"}
                    msg["apns"] = {"headers": {"apns-priority": "10"}}
                r = requests.post(
                    f"https://fcm.googleapis.com/v1/projects/{project}/messages:send",
                    headers={"Authorization": f"Bearer {access}"}, json={"message": msg}, timeout=10)
                if r.status_code == 200:
                    ok += 1
                elif r.status_code in (400, 404) and ("UNREGISTERED" in r.text or "NOT_FOUND" in r.text or "INVALID_ARGUMENT" in r.text):
                    db.query(DeviceToken).filter(DeviceToken.token == t).delete()
                    db.commit()
            return ok
    except Exception:
        log.exception("push failed")
        return 0

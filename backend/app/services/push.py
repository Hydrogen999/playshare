import json
import logging
import time

import httpx
import jwt

from app.config import settings
from app.database import SessionLocal
from app.models.device_token import DeviceToken
from app.models.push import PushSettings

log = logging.getLogger(__name__)
_cache = {"token": None, "exp": 0.0}
_CATEGORY = {"dm": "on_dm", "friend": "on_friend", "challenge": "on_challenge",
             "tournament": "on_tournament", "achievement": "on_achievement"}


def push_configured() -> bool:
    return bool(settings.FIREBASE_SERVICE_ACCOUNT_JSON)


def _account() -> dict:
    return json.loads(settings.FIREBASE_SERVICE_ACCOUNT_JSON)


def _access_token() -> str:
    now = time.time()
    if _cache["token"] and _cache["exp"] - 60 > now:
        return _cache["token"]
    acc = _account()
    assertion = jwt.encode(
        {
            "iss": acc["client_email"],
            "scope": "https://www.googleapis.com/auth/firebase.messaging",
            "aud": "https://oauth2.googleapis.com/token",
            "iat": int(now),
            "exp": int(now) + 3600,
        },
        acc["private_key"],
        algorithm="RS256",
    )
    r = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    _cache["token"] = data["access_token"]
    _cache["exp"] = now + int(data.get("expires_in", 3600))
    return _cache["token"]


def send_push(user_ids, title, body, data=None, category=None, data_only=False, ttl=None) -> None:
    """Send a push to every phone of these users. Safe to call from a thread."""
    if not push_configured() or not user_ids:
        return
    try:
        auth = _access_token()
        project = _account()["project_id"]
    except Exception as e:  # noqa: BLE001
        log.error("[PUSH] auth failed: %s", e)
        return
    payload_data = {k: str(v) for k, v in (data or {}).items() if v is not None}
    with SessionLocal() as db:
        allowed = []
        for uid in set(user_ids):
            st = db.query(PushSettings).filter(PushSettings.user_id == uid).first()
            if st is not None:
                if st.enabled is False:
                    continue
                col = _CATEGORY.get(category or "")
                if col and getattr(st, col, True) is False:
                    continue
            allowed.append(uid)
        if not allowed:
            return
        tokens = db.query(DeviceToken).filter(DeviceToken.user_id.in_(allowed)).all()
        dead = []
        for t in tokens:
            message = {
                "token": t.token,
                "data": payload_data,
                "android": {"priority": "HIGH", **({"ttl": ttl} if ttl else {})},
                "apns": {"headers": {"apns-priority": "10"}, "payload": {"aps": {"sound": "default"}}},
            }
            if not data_only:
                message["notification"] = {"title": title, "body": body}
                message["android"]["notification"] = {"channel_id": "messages"}
            try:
                r = httpx.post(
                    f"https://fcm.googleapis.com/v1/projects/{project}/messages:send",
                    headers={"Authorization": f"Bearer {auth}"},
                    json={"message": message},
                    timeout=8,
                )
                if r.status_code in (404, 400) and "UNREGISTERED" in r.text.upper():
                    dead.append(t)
                elif r.status_code >= 300:
                    log.warning("[PUSH] %s %s", r.status_code, r.text[:200])
            except Exception as e:  # noqa: BLE001
                log.warning("[PUSH] send failed: %s", e)
        for t in dead:
            db.delete(t)
        if dead:
            db.commit()

"""ICE (STUN/TURN) servers handed to the app for calls.

TURN is what makes calls work on mobile data and strict networks; without it a
lot of calls fail or drop. Credentials are created here, on the server, so no
TURN secret ever ships inside the app.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

from app.config import settings

STUN = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
    {"urls": "stun:stun.cloudflare.com:3478"},
]


def build_ice_servers(user_id: str, now: float | None = None) -> list[dict]:
    servers = list(STUN)
    urls = settings.turn_list
    if not urls:
        return servers
    if settings.TURN_SECRET:
        # coturn "use-auth-secret": time-limited credential, valid for 6 hours.
        expiry = int((now if now is not None else time.time()) + 6 * 3600)
        username = f"{expiry}:{user_id}"
        digest = hmac.new(settings.TURN_SECRET.encode(), username.encode(), hashlib.sha1).digest()
        servers.append({"urls": urls, "username": username, "credential": base64.b64encode(digest).decode()})
    elif settings.TURN_USERNAME and settings.TURN_CREDENTIAL:
        servers.append({"urls": urls, "username": settings.TURN_USERNAME, "credential": settings.TURN_CREDENTIAL})
    return servers

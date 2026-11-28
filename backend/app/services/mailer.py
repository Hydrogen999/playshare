"""Email through Resend's HTTPS API (Render's free plan blocks SMTP ports)."""

from __future__ import annotations

import httpx

from app.config import settings


def email_enabled() -> bool:
    return bool(settings.RESEND_API_KEY and settings.MAIL_FROM)


def send_email(to: str, subject: str, text: str) -> bool:
    if not email_enabled():
        return False
    try:
        r = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
            json={"from": settings.MAIL_FROM, "to": [to], "subject": subject, "text": text},
            timeout=15,
        )
        return r.status_code < 300
    except Exception as e:  # never crash a request because email failed
        print(f"[mail error] {e}")
        return False

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import extract, or_

from app.database import SessionLocal
from app.models.social import Friendship
from app.models.user import User
from app.services.push import push_configured, send_push

log = logging.getLogger(__name__)
_last_day = {"d": None}


def _run_once() -> None:
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        people = (
            db.query(User)
            .filter(
                User.date_of_birth.isnot(None),
                extract("month", User.date_of_birth) == now.month,
                extract("day", User.date_of_birth) == now.day,
            )
            .all()
        )
        for u in people:
            send_push([u.id], "Happy Birthday!", f"Happy birthday {u.username}! Enjoy your day.",
                      {"type": "birthday"}, category="friend")
            rows = db.query(Friendship).filter(
                Friendship.status == "accepted",
                or_(Friendship.requester_id == u.id, Friendship.addressee_id == u.id),
            ).all()
            ids = [r.addressee_id if r.requester_id == u.id else r.requester_id for r in rows]
            if ids:
                send_push(ids, "Birthday today", f"It's {u.username}'s birthday today. Say happy birthday!",
                          {"type": "birthday_friend", "user_id": u.id}, category="friend")


async def birthday_loop() -> None:
    """Once a day (around 07:00 UTC) wish people a happy birthday."""
    while True:
        try:
            now = datetime.now(timezone.utc)
            if push_configured() and now.hour == 7 and _last_day["d"] != now.date():
                _last_day["d"] = now.date()
                await asyncio.to_thread(_run_once)
        except Exception as e:  # noqa: BLE001
            log.error("[BIRTHDAY] %s", e)
        await asyncio.sleep(900)

import asyncio
import json
import logging

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import func

from app.database import SessionLocal
from app.models.social import ChatGroupMember, DirectMessage, Notification
from app.security import decode_token

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FRAME_CHARS = 64 * 1024   # reject absurdly large frames
MAX_CONTENT_LEN = 1000
MAX_URL_LEN = 2048

CALL_EVENTS = {"call:offer", "call:answer", "call:ice-candidate", "call:end", "call:reject"}
CALL_FIELDS = (
    "type", "call_type", "call_id", "sdp", "candidate", "is_missed",
    "offer", "answer", "is_video",
)


# --------------------------------------------------------------------------- #
# Connection hub
# --------------------------------------------------------------------------- #
class DMHub:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        self.active_connections.setdefault(str(user_id), set()).add(ws)

    def disconnect(self, user_id: str, ws: WebSocket):
        user_id = str(user_id)
        conns = self.active_connections.get(user_id)
        if conns is None:
            return
        conns.discard(ws)
        if not conns:
            del self.active_connections[user_id]

    async def send_to_user(self, user_id, message: dict):
        user_id = str(user_id)
        conns = self.active_connections.get(user_id)
        if not conns:
            return
        payload = json.dumps(message)
        dead = []
        for ws in list(conns):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(user_id, ws)

    async def send_to_users(self, user_ids, message: dict):
        await asyncio.gather(*(self.send_to_user(uid, message) for uid in set(map(str, user_ids))))


dm_hub = DMHub()


# --------------------------------------------------------------------------- #
# Sync DB helpers
# --------------------------------------------------------------------------- #
def _dm_payload(mm: DirectMessage) -> dict:
    return {
        "type": "dm:new",
        "id": mm.id,
        "sender_id": mm.sender_id,
        "recipient_id": mm.recipient_id,
        "content": mm.content,
        "media_url": mm.media_url,
        "reply_to_id": getattr(mm, "reply_to_id", None),
        "created_at": mm.created_at.isoformat(),
    }


def _save_dm(sender_id, target_id, content, media_url, reply_to_id) -> dict:
    with SessionLocal() as db:
        mm = DirectMessage(
            sender_id=sender_id,
            recipient_id=target_id,
            content=content,
            media_url=media_url,
            reply_to_id=reply_to_id,
        )
        db.add(mm)
        db.flush()

        db.add(
            Notification(
                user_id=target_id,
                type="dm",
                payload=json.dumps(
                    {
                        "from_id": sender_id,
                        "message_id": mm.id,
                        "preview": content[:60] if content else "📷 Media",
                    }
                ),
            )
        )
        db.commit()
        db.refresh(mm)
        return _dm_payload(mm)


def _save_group_message(sender_id, group_id, content, media_url):
    with SessionLocal() as db:
        members = (
            db.query(ChatGroupMember.user_id)
            .filter(ChatGroupMember.group_id == group_id)
            .all()
        )
        member_ids = [m[0] for m in members]
        if str(sender_id) not in {str(m) for m in member_ids}:
            return None, []

        mm = DirectMessage(
            sender_id=sender_id,
            group_id=group_id,
            content=content,
            media_url=media_url,
        )
        db.add(mm)
        db.commit()
        db.refresh(mm)

        payload = {
            "type": "group:new",
            "id": mm.id,
            "sender_id": sender_id,
            "group_id": group_id,
            "content": mm.content,
            "media_url": mm.media_url,
            "created_at": mm.created_at.isoformat(),
        }
        return payload, member_ids


def _mark_seen(reader_id, sender_id):
    with SessionLocal() as db:
        db.query(DirectMessage).filter(
            DirectMessage.sender_id == sender_id,
            DirectMessage.recipient_id == reader_id,
            DirectMessage.read_at.is_(None),
        ).update({"read_at": func.now()}, synchronize_session=False)
        db.commit()


def _save_missed_call(caller_id, callee_id, call_type) -> dict:
    with SessionLocal() as db:
        mm = DirectMessage(
            sender_id=caller_id,
            recipient_id=callee_id,
            content=f"Missed {call_type} call",
        )
        db.add(mm)
        db.commit()
        db.refresh(mm)
        return _dm_payload(mm)

# --- NEW: Save Challenge to Database ---
def _save_challenge(sender_id, target_id, content, game_slug, room_code) -> dict:
    with SessionLocal() as db:
        # We store the game details inside the media_url field
        # Format: challenge:{game_slug}:{room_code}
        mm = DirectMessage(
            sender_id=sender_id,
            recipient_id=target_id,
            content=content,
            media_url=f"challenge:{game_slug}:{room_code}"
        )
        db.add(mm)
        db.commit()
        db.refresh(mm)
        return _dm_payload(mm)


# --------------------------------------------------------------------------- #
# Small validators
# --------------------------------------------------------------------------- #
def _clean_text(value) -> str:
    return value.strip()[:MAX_CONTENT_LEN] if isinstance(value, str) else ""


def _clean_url(value):
    if isinstance(value, str) and 0 < len(value) <= MAX_URL_LEN:
        return value
    return None


# --------------------------------------------------------------------------- #
# Message handlers
# --------------------------------------------------------------------------- #
async def handle_typing(user_id, msg):
    target_id = msg.get("target_id")
    if not target_id:
        return
    await dm_hub.send_to_user(
        target_id,
        {"type": "dm:typing", "sender_id": user_id, "is_typing": bool(msg.get("is_typing", False))},
    )


async def handle_group_send(user_id, msg):
    group_id = msg.get("group_id")
    content = _clean_text(msg.get("content"))
    media_url = _clean_url(msg.get("media_url"))
    if not group_id or (not content and not media_url):
        return

    try:
        out_msg, member_ids = await asyncio.to_thread(
            _save_group_message, user_id, group_id, content, media_url
        )
    except Exception:
        logger.exception("DB error in group:send")
        return

    if out_msg is None:
        return

    await dm_hub.send_to_users(member_ids, out_msg)


async def handle_dm_send(user_id, msg):
    target_id = msg.get("target_id")
    content = _clean_text(msg.get("content"))
    media_url = _clean_url(msg.get("media_url"))
    reply_to_id = msg.get("reply_to_id")
    if not target_id or (not content and not media_url):
        return

    try:
        out_msg = await asyncio.to_thread(
            _save_dm, user_id, target_id, content, media_url, reply_to_id
        )
    except Exception:
        logger.exception("DB error in dm:send")
        return

    await dm_hub.send_to_users([target_id, user_id], out_msg)


async def handle_dm_seen(user_id, msg):
    target_id = msg.get("target_id")
    if not target_id:
        return
    try:
        await asyncio.to_thread(_mark_seen, user_id, target_id)
    except Exception:
        logger.exception("DB error in dm:seen")
        return
    await dm_hub.send_to_user(target_id, {"type": "dm:seen", "reader_id": user_id})


async def handle_call(user_id, msg):
    mtype = msg["type"]
    target_id = msg.get("target_id")
    if not target_id:
        return

    is_rejected = mtype == "call:reject"
    is_missed_end = mtype == "call:end" and msg.get("is_missed")

    if is_rejected or is_missed_end:
        call_type = msg.get("call_type") if msg.get("call_type") in ("audio", "video") else "audio"
        caller_id, callee_id = (target_id, user_id) if is_rejected else (user_id, target_id)
        try:
            out_msg = await asyncio.to_thread(_save_missed_call, caller_id, callee_id, call_type)
            await dm_hub.send_to_users([caller_id, callee_id], out_msg)
        except Exception:
            logger.exception("DB error saving missed call")

    relay = {k: msg[k] for k in CALL_FIELDS if k in msg}
    relay["sender_id"] = user_id
    await dm_hub.send_to_user(target_id, relay)

# --- NEW: Handle Game Challenge ---
async def handle_challenge(user_id, msg):
    target_id = msg.get("target_id")
    content = _clean_text(msg.get("content"))
    game_slug = msg.get("game_slug")
    room_code = msg.get("room_code")

    if not target_id or not content or not game_slug or not room_code:
        return

    try:
        out_msg = await asyncio.to_thread(
            _save_challenge, user_id, target_id, content, game_slug, room_code
        )
    except Exception:
        logger.exception("DB error in dm:challenge")
        return

    # Send to both sender (for multi-tab sync) and recipient
    await dm_hub.send_to_users([target_id, user_id], out_msg)


HANDLERS = {
    "dm:typing": handle_typing,
    "group:send": handle_group_send,
    "dm:send": handle_dm_send,
    "dm:seen": handle_dm_seen,
    "dm:challenge": handle_challenge, # <-- REGISTERED HERE
    **{event: handle_call for event in CALL_EVENTS},
}


# --------------------------------------------------------------------------- #
# WebSocket endpoint
# --------------------------------------------------------------------------- #
@router.websocket("/ws/dm")
async def dm_websocket(ws: WebSocket, token: str = Query(...)):
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
    except jwt.PyJWTError:
        user_id = None

    if not user_id:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await dm_hub.connect(user_id, ws)

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_FRAME_CHARS:
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue

            handler = HANDLERS.get(msg.get("type"))
            if handler is None:
                continue

            try:
                await handler(user_id, msg)
            except WebSocketDisconnect:
                raise
            except Exception:
                logger.exception("Unhandled error in %s", msg.get("type"))

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WS error for user %s", user_id)
    finally:
        dm_hub.disconnect(user_id, ws)

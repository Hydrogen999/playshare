import asyncio
import json
import logging
from datetime import datetime, timezone

from app.models.social import ChatGroupMember, DirectMessage, Notification, MessageReaction
from sqlalchemy import func

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from app.database import SessionLocal
from app.models.token import TokenAccount, LedgerTransaction, LedgerEntry
from app.models.user import User, Profile
from app.security import decode_token

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FRAME_CHARS = 64 * 1024
MAX_CONTENT_LEN = 1000
MAX_URL_LEN = 2048

CALL_EVENTS = {"call:offer", "call:answer", "call:ice-candidate", "call:end", "call:reject"}
CALL_FIELDS = (
    "type", "call_type", "call_id", "sdp", "candidate", "is_missed",
    "offer", "answer", "is_video",
)

class DMHub:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        is_new = str(user_id) not in self.active_connections
        self.active_connections.setdefault(str(user_id), set()).add(ws)
        
        # 🟢 Update last_seen to now when they connect
        await asyncio.to_thread(self._update_last_seen, user_id, datetime.now(timezone.utc))
        
        # If this is their first connection, broadcast to their friends that they are online
        if is_new:
            await self._broadcast_presence(user_id, "online", None)

    def disconnect(self, user_id: str, ws: WebSocket):
        user_id = str(user_id)
        conns = self.active_connections.get(user_id)
        if conns is None:
            return
        conns.discard(ws)
        if not conns:
            del self.active_connections[user_id]
            # 🟢 Broadcast offline status when they fully disconnect
            now = datetime.now(timezone.utc)
            asyncio.create_task(self._broadcast_presence(user_id, "offline", now))
            asyncio.create_task(asyncio.to_thread(self._update_last_seen, user_id, now))

    def _update_last_seen(self, user_id, dt):
        with SessionLocal() as db:
            user = db.get(User, user_id)
            if user:
                user.last_seen = dt
                db.commit()

    async def _broadcast_presence(self, user_id, status, last_seen):
        payload = {
            "type": "presence:update",
            "user_id": str(user_id),
            "status": status,
            "last_seen": last_seen.isoformat() if last_seen else None
        }
        # Send to all connected users
        await asyncio.gather(*(self.send_to_user(uid, payload) for uid in list(self.active_connections.keys())))

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

def _dm_payload(mm: DirectMessage, db=None) -> dict:
    # 🟢 NEW: If deleted, hide the content
    is_deleted = mm.deleted_at is not None
    payload = {
        "type": "dm:new",
        "id": mm.id,
        "sender_id": mm.sender_id,
        "recipient_id": mm.recipient_id,
        "content": "This message was deleted" if is_deleted else mm.content,
        "media_url": None if is_deleted else mm.media_url,
        "reply_to_id": getattr(mm, "reply_to_id", None),
        "created_at": mm.created_at.isoformat(),
        "is_deleted": is_deleted,
    }
    if db and not is_deleted:
        reacts = db.query(MessageReaction).filter(MessageReaction.message_id == mm.id).all()
        payload["reactions"] = [{"user_id": r.user_id, "emoji": r.emoji} for r in reacts]
    return payload

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
                payload=json.dumps({
                    "from_id": sender_id,
                    "message_id": mm.id,
                    "preview": content[:60] if content else "📷 Media",
                }),
            )
        )
        db.commit()
        db.refresh(mm)
        return _dm_payload(mm)

def _save_group_message(sender_id, group_id, content, media_url):
    with SessionLocal() as db:
        members = db.query(ChatGroupMember.user_id).filter(ChatGroupMember.group_id == group_id).all()
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
            "is_deleted": False,
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

def _save_challenge(sender_id, target_id, content, game_slug, room_code) -> dict:
    with SessionLocal() as db:
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

def _save_gift_and_transfer(sender_id, target_id, amount) -> dict:
    with SessionLocal() as db:
        try:
            sender_acc = db.query(TokenAccount).filter(TokenAccount.user_id == sender_id).with_for_update().first()
            target_acc = db.query(TokenAccount).filter(TokenAccount.user_id == target_id).with_for_update().first()
            
            if not sender_acc or not target_acc or sender_acc.balance < amount:
                return {"ok": False, "error": "Insufficient balance"}

            sender_acc.balance -= amount
            target_acc.balance += amount
            
            sender_prof = db.query(Profile).filter(Profile.user_id == sender_id).first()
            target_prof = db.query(Profile).filter(Profile.user_id == target_id).first()
            if sender_prof: sender_prof.tokens_cached -= amount
            if target_prof: target_prof.tokens_cached += amount

            tx = LedgerTransaction(type="gift", notes=f"Gift from {sender_id} to {target_id}")
            db.add(tx)
            db.flush()
            
            db.add(LedgerEntry(transaction_id=tx.id, account_id=sender_id, delta=-amount, balance_after=sender_acc.balance))
            db.add(LedgerEntry(transaction_id=tx.id, account_id=target_id, delta=amount, balance_after=target_acc.balance))

            mm = DirectMessage(
                sender_id=sender_id,
                recipient_id=target_id,
                content=f"Sent a gift of {amount} PlayCoins",
                media_url=f"gift:{amount}"
            )
            db.add(mm)

            db.add(Notification(
                user_id=target_id,
                type="gift",
                payload=json.dumps({
                    "from_id": sender_id,
                    "amount": amount,
                    "message": f"{sender_id} gifted you {amount} PlayCoins!"
                })
            ))
            
            db.commit()
            db.refresh(mm)

            return {
                "ok": True,
                "message": _dm_payload(mm),
                "new_sender_balance": sender_acc.balance,
                "new_target_balance": target_acc.balance
            }
        except Exception as e:
            db.rollback()
            logger.exception("Gift transfer failed")
            return {"ok": False, "error": "Transaction failed"}

def _clean_text(value) -> str:
    return value.strip()[:MAX_CONTENT_LEN] if isinstance(value, str) else ""

def _clean_url(value):
    if isinstance(value, str) and 0 < len(value) <= MAX_URL_LEN:
        return value
    return None

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

    await dm_hub.send_to_users([target_id, user_id], out_msg)

async def handle_gift(user_id, msg):
    target_id = msg.get("target_id")
    try:
        amount = int(msg.get("amount", 0))
    except (TypeError, ValueError):
        return

    if not target_id or amount <= 0:
        return

    res = await asyncio.to_thread(_save_gift_and_transfer, user_id, target_id, amount)
    
    if res.get("ok"):
        out_msg = res["message"]
        await dm_hub.send_to_users([target_id, user_id], out_msg)
        await dm_hub.send_to_user(user_id, {"type": "balance:update", "new_balance": res["new_sender_balance"]})
        await dm_hub.send_to_user(target_id, {"type": "balance:update", "new_balance": res["new_target_balance"]})
    else:
        await dm_hub.send_to_user(user_id, {"type": "dm:error", "error": res.get("error", "Gift failed")})

def _save_reaction(msg_id, user_id, emoji) -> dict:
    with SessionLocal() as db:
        existing = db.query(MessageReaction).filter(
            MessageReaction.message_id == msg_id,
            MessageReaction.user_id == user_id
        ).first()

        msg = db.query(DirectMessage).filter(DirectMessage.id == msg_id).first()
        if not msg:
            return None

        action = "add"
        if existing:
            if existing.emoji == emoji:
                db.delete(existing)
                action = "remove"
            else:
                existing.emoji = emoji
        else:
            db.add(MessageReaction(message_id=msg_id, user_id=user_id, emoji=emoji))
        
        db.commit()
        return {
            "type": "dm:reaction",
            "message_id": msg_id,
            "user_id": user_id,
            "emoji": emoji,
            "action": action,
            "sender_id": msg.sender_id,
            "recipient_id": msg.recipient_id,
        }

async def handle_react(user_id, msg):
    msg_id = msg.get("message_id")
    emoji = msg.get("emoji")
    if not msg_id or not emoji:
        return

    res = await asyncio.to_thread(_save_reaction, msg_id, user_id, emoji)
    if res:
        await dm_hub.send_to_users([res["sender_id"], res["recipient_id"]], res)

def _delete_dm(msg_id, user_id) -> dict:
    with SessionLocal() as db:
        mm = db.query(DirectMessage).filter(DirectMessage.id == msg_id).first()
        if not mm or mm.sender_id != user_id:
            return None
        
        mm.deleted_at = datetime.now(timezone.utc)
        mm.content = "This message was deleted"
        mm.media_url = None
        
        db.commit()
        
        return {
            "type": "dm:deleted",
            "message_id": msg_id,
            "sender_id": mm.sender_id,
            "recipient_id": mm.recipient_id,
            "group_id": mm.group_id,
        }

async def handle_delete(user_id, msg):
    msg_id = msg.get("message_id")
    if not msg_id:
        return

    res = await asyncio.to_thread(_delete_dm, msg_id, user_id)
    if res:
        if res["group_id"]:
            with SessionLocal() as db:
                members = db.query(ChatGroupMember.user_id).filter(ChatGroupMember.group_id == res["group_id"]).all()
                member_ids = [m[0] for m in members]
            await dm_hub.send_to_users(member_ids, res)
        else:
            await dm_hub.send_to_users([res["sender_id"], res["recipient_id"]], res)


HANDLERS = {
    "dm:typing": handle_typing,
    "group:send": handle_group_send,
    "dm:send": handle_dm_send,
    "dm:seen": handle_dm_seen,
    "dm:challenge": handle_challenge,
    "dm:gift": handle_gift,
    "dm:react": handle_react,
    "dm:delete": handle_delete,
    **{event: handle_call for event in CALL_EVENTS},
}


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

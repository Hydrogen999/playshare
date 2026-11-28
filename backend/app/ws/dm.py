import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone

from app.models.social import ChatGroupMember, DirectMessage, Notification, MessageReaction
from sqlalchemy import func

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from app.database import SessionLocal
from app.models.token import TokenAccount, LedgerTransaction, LedgerEntry
from app.models.user import User, Profile
from app.security import decode_token
from app.models.social import Friendship
from app.services import fcm
from app.services.media import is_own_media_url
from app.services.safety import blocked_ids, can_see, check_interaction, is_blocked, peek_safety
from app.services.userextra import extras
from sqlalchemy import or_

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

PENDING_CALL_TTL = 45          # seconds a call stays "ringing" for a phone that is asleep
CALL_PAIR_TTL = 4 * 3600


class DMHub:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}
        # calls waiting for a sleeping phone: callee_id -> {"caller", "msgs", "expires"}
        self.pending_calls: dict[str, dict] = {}
        # calls in progress: frozenset({a, b}) -> started timestamp
        self.calls: dict[frozenset, float] = {}

    def is_online(self, user_id) -> bool:
        return str(user_id) in self.active_connections

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        user_id = str(user_id)
        is_new = user_id not in self.active_connections
        self.active_connections.setdefault(user_id, set()).add(ws)

        await asyncio.to_thread(self._update_last_seen, user_id, datetime.now(timezone.utc))

        if is_new:
            await self._broadcast_presence(user_id, "online", None)
        # Tell this user which of their friends are online right now.
        await self._send_presence_snapshot(user_id)
        # A call that arrived while the phone was asleep: deliver it now.
        pend = self.pending_calls.pop(user_id, None)
        if pend and pend["expires"] > time.time():
            for m in pend["msgs"]:
                await self.send_to_user(user_id, m)

    def disconnect(self, user_id: str, ws: WebSocket):
        user_id = str(user_id)
        conns = self.active_connections.get(user_id)
        if conns is None:
            return
        conns.discard(ws)
        if not conns:
            del self.active_connections[user_id]
            now = datetime.now(timezone.utc)
            asyncio.create_task(self._broadcast_presence(user_id, "offline", now))
            asyncio.create_task(asyncio.to_thread(self._update_last_seen, user_id, now))
            asyncio.create_task(self._drop_calls_of(user_id))

    async def _drop_calls_of(self, user_id: str):
        """A phone that vanished mid-call: tell the other side so it does not hang."""
        for pair in [p for p in self.calls if user_id in p]:
            self.calls.pop(pair, None)
            (other,) = tuple(pair - {user_id}) or (None,)
            if other:
                await self.send_to_user(other, {"type": "call:end", "sender_id": user_id})
        self.pending_calls.pop(user_id, None)

    def _update_last_seen(self, user_id, dt):
        with SessionLocal() as db:
            prof = db.get(Profile, user_id)      # last_seen lives on Profile, not User
            if prof:
                prof.last_seen = dt
                db.commit()

    def _friend_ids(self, user_id: str) -> list[str]:
        with SessionLocal() as db:
            rows = db.query(Friendship).filter(
                Friendship.status == "accepted",
                or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id)).all()
            return [r.addressee_id if r.requester_id == user_id else r.requester_id for r in rows]

    def _presence_rules(self, user_id: str) -> tuple[bool, bool]:
        with SessionLocal() as db:
            s = peek_safety(db, user_id)
            return s["online_status"] == "friends", s["last_seen"] == "friends"

    async def _broadcast_presence(self, user_id, status, last_seen):
        """Only the user's friends see online/offline, and only if the user allows it."""
        show_online, show_seen = await asyncio.to_thread(self._presence_rules, str(user_id))
        if not show_online:
            return
        friends = await asyncio.to_thread(self._friend_ids, str(user_id))
        payload = {
            "type": "presence:update",
            "user_id": str(user_id),
            "status": status,
            "last_seen": last_seen.isoformat() if (last_seen and show_seen) else None,
        }
        targets = [f for f in friends if f in self.active_connections]
        if targets:
            await asyncio.gather(*(self.send_to_user(uid, payload) for uid in targets))

    def _visible_online(self, user_id: str) -> list[str]:
        out = []
        for f in self._friend_ids(user_id):
            if f in self.active_connections and self._presence_rules(f)[0]:
                out.append(f)
        return out

    async def _send_presence_snapshot(self, user_id: str):
        try:
            ids = await asyncio.to_thread(self._visible_online, user_id)
        except Exception:
            return
        for f in ids:
            await self.send_to_user(user_id, {"type": "presence:update", "user_id": f, "status": "online", "last_seen": None})

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
        # Members who blocked the sender (or were blocked by them) do not receive it live.
        hidden = blocked_ids(db, str(sender_id))
        member_ids = [m for m in member_ids if str(m) not in hidden]

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
    """Chat media may only point at files WE stored. This also stops anyone from
    faking special messages such as "gift:1000" or "challenge:..." by hand."""
    return value if is_own_media_url(value) else None


_SLUG = re.compile(r"^[a-z0-9_\-]{1,32}$")
_CODE = re.compile(r"^[A-Za-z0-9_\-]{1,16}$")


def _deny(user_id, reason: str):
    return dm_hub.send_to_user(user_id, {"type": "dm:error", "error": reason})


def _check(actor, target, kind):
    with SessionLocal() as db:
        if not db.get(User, target):
            return "User not found."
        return check_interaction(db, actor, target, kind)

def _is_blocked_pair(a, b):
    with SessionLocal() as db:
        return is_blocked(db, a, b)


async def handle_typing(user_id, msg):
    target_id = msg.get("target_id")
    if not isinstance(target_id, str) or not dm_hub.is_online(target_id):
        return
    if await asyncio.to_thread(_is_blocked_pair, user_id, target_id):
        return
    await dm_hub.send_to_user(
        target_id,
        {"type": "dm:typing", "sender_id": user_id, "is_typing": bool(msg.get("is_typing", False))},
    )

async def handle_group_send(user_id, msg):
    group_id = msg.get("group_id")
    content = _clean_text(msg.get("content"))
    media_url = _clean_url(msg.get("media_url"))
    if not isinstance(group_id, str) or (not content and not media_url):
        return
    if msg.get("media_url") and not media_url:
        await _deny(user_id, "That attachment is not allowed.")
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

def _valid_reply(reply_to_id, a, b):
    if not isinstance(reply_to_id, str):
        return None
    with SessionLocal() as db:
        m = db.get(DirectMessage, reply_to_id)
        if m and {m.sender_id, m.recipient_id} == {a, b}:
            return reply_to_id
    return None


def _push_dm(sender_id, target_id, content, media_url):
    """Notify a phone that has no live connection (app closed)."""
    with SessionLocal() as db:
        u = db.get(User, sender_id)
        if not u:
            return
        ex = extras(db, [sender_id])[sender_id]
        avatar = u.profile.avatar_id if u.profile else "fox"
        name = u.username
    preview = content[:80] if content else "Sent you a photo or voice note"
    fcm.send_to_user(target_id, {"type": "dm", "sender_id": sender_id, "sender_name": name,
                                 "avatar_id": avatar, "avatar_url": ex["avatar_url"] or ""},
                     title=name, body=preview, kind="dm")


async def handle_dm_send(user_id, msg):
    target_id = msg.get("target_id")
    content = _clean_text(msg.get("content"))
    media_url = _clean_url(msg.get("media_url"))
    if not isinstance(target_id, str) or (not content and not media_url):
        return
    if msg.get("media_url") and not media_url:
        await _deny(user_id, "That attachment is not allowed.")
        return
    reason = await asyncio.to_thread(_check, user_id, target_id, "message")
    if reason:
        await _deny(user_id, reason)
        return
    reply_to_id = await asyncio.to_thread(_valid_reply, msg.get("reply_to_id"), user_id, target_id)

    try:
        out_msg = await asyncio.to_thread(_save_dm, user_id, target_id, content, media_url, reply_to_id)
    except Exception:
        logger.exception("DB error in dm:send")
        return

    await dm_hub.send_to_users([target_id, user_id], out_msg)
    if not dm_hub.is_online(target_id):
        asyncio.create_task(asyncio.to_thread(_push_dm, user_id, target_id, content, media_url))

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

def _push_call(caller_id, target_id, is_video):
    with SessionLocal() as db:
        u = db.get(User, caller_id)
        name = u.username if u else "Someone"
    fcm.send_to_user(target_id, {"type": "call", "caller_id": caller_id, "caller_name": name,
                                 "is_video": "1" if is_video else "0"}, kind="call", high_priority=True)


def _push_call_end(target_id):
    fcm.send_to_user(target_id, {"type": "call_end"}, kind="call", high_priority=True)


async def handle_call(user_id, msg):
    mtype = msg["type"]
    target_id = msg.get("target_id")
    if not isinstance(target_id, str) or target_id == user_id:
        return
    pair = frozenset((user_id, target_id))
    now = time.time()
    # forget very old calls
    for p in [p for p, t in dm_hub.calls.items() if now - t > CALL_PAIR_TTL]:
        dm_hub.calls.pop(p, None)

    relay = {k: msg[k] for k in CALL_FIELDS if k in msg}
    relay["sender_id"] = user_id

    if mtype == "call:offer":
        reason = await asyncio.to_thread(_check, user_id, target_id, "call")
        if reason:
            await dm_hub.send_to_user(user_id, {"type": "call:unavailable", "sender_id": target_id, "reason": reason})
            return
        is_video = bool(msg.get("is_video"))
        if dm_hub.is_online(target_id):
            dm_hub.calls[pair] = now
            await dm_hub.send_to_user(target_id, relay)
            return
        # The callee's phone is asleep or the app is closed.
        if fcm.enabled():
            dm_hub.calls[pair] = now
            dm_hub.pending_calls[target_id] = {"caller": user_id, "msgs": [relay], "expires": now + PENDING_CALL_TTL}
            asyncio.create_task(asyncio.to_thread(_push_call, user_id, target_id, is_video))
        else:
            await dm_hub.send_to_user(user_id, {"type": "call:unavailable", "sender_id": target_id, "reason": "offline"})
            try:
                out = await asyncio.to_thread(_save_missed_call, user_id, target_id, "video" if is_video else "audio")
                await dm_hub.send_to_users([user_id], out)
            except Exception:
                logger.exception("DB error saving missed call")
        return

    # Everything else (answer / ice / end / reject) only flows inside a call that was set up properly.
    if pair not in dm_hub.calls:
        return

    pend = dm_hub.pending_calls.get(target_id)
    if mtype == "call:ice-candidate" and pend and pend["caller"] == user_id and not dm_hub.is_online(target_id):
        if len(pend["msgs"]) < 60:
            pend["msgs"].append(relay)
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

    if mtype in ("call:end", "call:reject"):
        dm_hub.calls.pop(pair, None)
        if pend and pend["caller"] == user_id:
            dm_hub.pending_calls.pop(target_id, None)
        if not dm_hub.is_online(target_id):
            asyncio.create_task(asyncio.to_thread(_push_call_end, target_id))
    await dm_hub.send_to_user(target_id, relay)

async def handle_challenge(user_id, msg):
    target_id = msg.get("target_id")
    content = _clean_text(msg.get("content"))
    game_slug = msg.get("game_slug")
    room_code = msg.get("room_code")

    if not isinstance(target_id, str) or not content:
        return
    if not (isinstance(game_slug, str) and _SLUG.match(game_slug) and isinstance(room_code, str) and _CODE.match(room_code)):
        return
    reason = await asyncio.to_thread(_check, user_id, target_id, "message")
    if reason:
        await _deny(user_id, reason)
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

    if not isinstance(target_id, str) or amount <= 0:
        return
    reason = await asyncio.to_thread(_check, user_id, target_id, "message")
    if reason:
        await _deny(user_id, reason)
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
        if msg.group_id:
            if db.get(ChatGroupMember, (msg.group_id, user_id)) is None:
                return None
        elif user_id not in (msg.sender_id, msg.recipient_id) or is_blocked(db, msg.sender_id, msg.recipient_id):
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
            "group_id": msg.group_id,
        }

async def handle_react(user_id, msg):
    msg_id = msg.get("message_id")
    emoji = msg.get("emoji")
    if not msg_id or not emoji:
        return

    if not isinstance(msg_id, str) or not isinstance(emoji, str) or not (0 < len(emoji) <= 16):
        return
    res = await asyncio.to_thread(_save_reaction, msg_id, user_id, emoji)
    if res:
        if res.get("group_id"):
            with SessionLocal() as db:
                members = [m[0] for m in db.query(ChatGroupMember.user_id).filter(ChatGroupMember.group_id == res["group_id"]).all()]
            await dm_hub.send_to_users(members, res)
        else:
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

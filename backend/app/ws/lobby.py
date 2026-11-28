import asyncio
import json
import random
import uuid
from datetime import datetime, timezone

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.room import Room, RoomMember
from app.models.user import User
from app.redis_client import get_redis
from app.security import decode_token
from app.services.cosmetics import get_frame_style
from app.services.premium import is_premium

router = APIRouter()

WORLD_W = 1600
WORLD_H = 900
PADDING = 60
CHALLENGE_TTL = 30

LOBBY_CHANNEL = "playsphere:lobby:events"
PRESENCE_KEY = "playsphere:lobby:players"
CHALLENGE_PREFIX = "playsphere:challenge:"


class LobbyHub:
    def __init__(self):
        self.local: dict[str, WebSocket] = {}
        self._redis = None
        self._pubsub = None
        self._task = None

    async def start(self):
        if self._task is not None:
            return
        self._redis = get_redis()
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(LOBBY_CHANNEL)
        self._task = asyncio.create_task(self._listen())

    async def _listen(self):
        try:
            async for msg in self._pubsub.listen():
                if not msg or msg.get("type") != "message":
                    continue
                try:
                    env = json.loads(msg["data"])
                except Exception:
                    continue
                raw = env.get("__raw")
                if not raw:
                    continue
                target = env.get("__target")
                sender = env.get("__sender")

                if target:
                    sock = self.local.get(target)
                    if sock:
                        try:
                            await sock.send_text(json.dumps(raw))
                        except Exception:
                            self.local.pop(target, None)
                    continue

                for uid, sock in list(self.local.items()):
                    if uid == sender:
                        continue
                    try:
                        await sock.send_text(json.dumps(raw))
                    except Exception:
                        self.local.pop(uid, None)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[lobby listener] {e}")

    async def publish(self, raw: dict, exclude: str | None = None, target: str | None = None):
        env = {"__raw": raw}
        if exclude: env["__sender"] = exclude
        if target: env["__target"] = target
        await self._redis.publish(LOBBY_CHANNEL, json.dumps(env))

    async def send_local(self, user_id: str, raw: dict) -> bool:
        sock = self.local.get(user_id)
        if not sock:
            return False
        try:
            await sock.send_text(json.dumps(raw))
            return True
        except Exception:
            self.local.pop(user_id, None)
            return False

    async def send_to_user(self, user_id: str, raw: dict) -> None:
        ok = await self.send_local(user_id, raw)
        if not ok:
            await self.publish(raw, target=user_id)

    async def presence_add(self, uid, username, avatar_id, level, frame_color, premium, x, y):
        await self._redis.hset(PRESENCE_KEY, uid, json.dumps({
            "id": uid, "username": username, "avatar_id": avatar_id,
            "level": level, "frame_color": frame_color, "is_premium": premium,
            "x": x, "y": y,
        }))

    async def presence_remove(self, uid):
        await self._redis.hdel(PRESENCE_KEY, uid)

    async def presence_move(self, uid, x, y):
        raw = await self._redis.hget(PRESENCE_KEY, uid)
        if not raw:
            return
        d = json.loads(raw)
        d["x"] = x
        d["y"] = y
        await self._redis.hset(PRESENCE_KEY, uid, json.dumps(d))

    async def presence_all(self) -> list[dict]:
        raw = await self._redis.hgetall(PRESENCE_KEY)
        return [json.loads(v) for v in raw.values()]

    async def challenge_create(self, from_id, to_id) -> str:
        cid = str(uuid.uuid4())
        await self._redis.setex(
            f"{CHALLENGE_PREFIX}{cid}", CHALLENGE_TTL,
            json.dumps({
                "id": cid, "from_id": from_id, "to_id": to_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }),
        )
        return cid

    async def challenge_get(self, cid):
        raw = await self._redis.get(f"{CHALLENGE_PREFIX}{cid}")
        return json.loads(raw) if raw else None

    async def challenge_del(self, cid):
        await self._redis.delete(f"{CHALLENGE_PREFIX}{cid}")


hub = LobbyHub()


@router.websocket("/ws/lobby")
async def lobby_ws(ws: WebSocket, token: str = Query(...)):
    try:
        payload = decode_token(token)
    except jwt.PyJWTError:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    user_id = payload.get("sub")
    if not user_id:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    db: Session = SessionLocal()
    try:
        user = db.get(User, user_id)
        if not user or user.is_banned:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        username = user.username
        avatar_id = user.profile.avatar_id
        level = user.profile.level
        frame_color = get_frame_style(db, user_id)
        premium = is_premium(db, user_id)
    finally:
        db.close()

    await hub.start()
    await ws.accept()

    # --- INSTANT GHOST DISCONNECT FIX ---
    # If this user is already in the local dict, kick the old socket out instantly
    old_ws = hub.local.get(user_id)
    if old_ws:
        try:
            await old_ws.close()
        except Exception:
            pass
        hub.local.pop(user_id, None)
    # ------------------------------------

    hub.local[user_id] = ws

    x = random.randint(PADDING, WORLD_W - PADDING)
    y = random.randint(PADDING, WORLD_H - PADDING)
    await hub.presence_add(user_id, username, avatar_id, level, frame_color, premium, x, y)

    snapshot = await hub.presence_all()
    await ws.send_text(json.dumps({
        "type": "lobby:init",
        "you": user_id,
        "world": {"w": WORLD_W, "h": WORLD_H},
        "players": snapshot,
    }))

    await hub.publish({
        "type": "lobby:player_joined",
        "player": {
            "id": user_id, "username": username,
            "avatar_id": avatar_id, "level": level,
            "frame_color": frame_color, "is_premium": premium,
            "x": x, "y": y,
        },
    }, exclude=user_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")

            if mtype == "lobby:move":
                try:
                    nx = max(PADDING, min(WORLD_W - PADDING, float(msg.get("x", 0))))
                    ny = max(PADDING, min(WORLD_H - PADDING, float(msg.get("y", 0))))
                except (TypeError, ValueError):
                    continue
                await hub.presence_move(user_id, nx, ny)
                await hub.publish(
                    {"type": "lobby:player_moved", "id": user_id, "x": nx, "y": ny},
                    exclude=user_id,
                )

            elif mtype == "challenge:send":
                target_id = msg.get("target_id")
                if not target_id or target_id == user_id:
                    continue
                if not await hub._redis.hexists(PRESENCE_KEY, target_id):
                    await hub.send_local(user_id, {
                        "type": "challenge:error", "error": "Player is not online",
                    })
                    continue

                cid = await hub.challenge_create(user_id, target_id)
                await hub.send_to_user(target_id, {
                    "type": "challenge:incoming",
                    "challenge_id": cid,
                    "from": {
                        "id": user_id, "username": username,
                        "avatar_id": avatar_id, "level": level,
                        "frame_color": frame_color, "is_premium": premium,
                    },
                })
                await hub.send_local(user_id, {
                    "type": "challenge:sent", "challenge_id": cid, "to_id": target_id,
                })

            elif mtype == "challenge:respond":
                cid = msg.get("challenge_id")
                accept = bool(msg.get("accept", False))
                c = await hub.challenge_get(cid) if cid else None

                if not c or c["to_id"] != user_id:
                    await hub.send_local(user_id, {
                        "type": "challenge:error", "error": "Challenge expired or invalid",
                    })
                    continue
                await hub.challenge_del(cid)

                if not accept:
                    await hub.send_to_user(c["from_id"], {
                        "type": "challenge:declined", "challenge_id": cid,
                    })
                    continue

                db2: Session = SessionLocal()
                try:
                    ua = db2.get(User, c["from_id"])
                    ub = db2.get(User, c["to_id"])
                    if not ua or not ub:
                        await hub.send_local(user_id, {
                            "type": "challenge:error", "error": "One player no longer exists",
                        })
                        continue

                    room = Room(
                        game_slug="dice", status="waiting", wager=0,
                        created_by=c["from_id"],
                    )
                    db2.add(room)
                    db2.flush()
                    db2.add(RoomMember(room_id=room.id, user_id=c["from_id"]))
                    db2.add(RoomMember(room_id=room.id, user_id=c["to_id"]))
                    db2.commit()
                    room_id = room.id
                except Exception as e:
                    print(f"[challenge accept error] {e}")
                    await hub.send_local(user_id, {
                        "type": "challenge:error", "error": "Could not create room",
                    })
                    continue
                finally:
                    db2.close()

                await hub.send_to_user(c["from_id"], {
                    "type": "challenge:accepted", "challenge_id": cid, "room_id": room_id,
                })
                await hub.send_to_user(c["to_id"], {
                    "type": "challenge:accepted", "challenge_id": cid, "room_id": room_id,
                })

    except WebSocketDisconnect:
        pass
    finally:
        hub.local.pop(user_id, None)
        await hub.presence_remove(user_id)
        await hub.publish({"type": "lobby:player_left", "id": user_id})

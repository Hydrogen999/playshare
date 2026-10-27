import json
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, status
import jwt
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import SessionLocal
from app.models.user import User
from app.models.social import DirectMessage, Notification
from app.security import decode_token
from app.services import presence as presence_svc

router = APIRouter()

class DMHub:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        if user_id not in self.active_connections:
            self.active_connections[user_id] = set()
        self.active_connections[user_id].add(ws)

    def disconnect(self, user_id: str, ws: WebSocket):
        if user_id in self.active_connections:
            self.active_connections[user_id].discard(ws)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]

    async def send_to_user(self, user_id: str, message: dict):
        if user_id in self.active_connections:
            for ws in list(self.active_connections[user_id]):
                try:
                    await ws.send_text(json.dumps(message))
                except Exception:
                    self.active_connections[user_id].discard(ws)

dm_hub = DMHub()

@router.websocket("/ws/dm")
async def dm_websocket(ws: WebSocket, token: str = Query(...)):
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if not user_id:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
    except jwt.PyJWTError:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await dm_hub.connect(user_id, ws)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            target_id = msg.get("target_id")

            if mtype == "dm:typing":
                await dm_hub.send_to_user(target_id, {
                    "type": "dm:typing",
                    "sender_id": user_id,
                    "is_typing": msg.get("is_typing", False)
                })

            elif mtype == "dm:send":
                content = (msg.get("content") or "").strip()
                reply_to_id = msg.get("reply_to_id")
                media_url = msg.get("media_url")

                if not content and not media_url:
                    continue

                db: Session = SessionLocal()
                try:
                    mm = DirectMessage(
                        sender_id=user_id, 
                        recipient_id=target_id, 
                        content=content[:1000],
                        media_url=media_url,
                        reply_to_id=reply_to_id
                    )
                    db.add(mm)
                    db.flush()

                    notif = Notification(
                        user_id=target_id,
                        type="dm",
                        payload=json.dumps({
                            "from_id": user_id,
                            "message_id": mm.id,
                            "preview": content[:60] if content else "📷 Media",
                        }),
                    )
                    db.add(notif)
                    db.commit()
                    db.refresh(mm)

                    out_msg = {
                        "type": "dm:new",
                        "id": mm.id,
                        "sender_id": user_id,
                        "recipient_id": target_id,
                        "content": mm.content,
                        "media_url": mm.media_url,
                        "reply_to_id": mm.reply_to_id,
                        "created_at": mm.created_at.isoformat()
                    }
                except Exception as e:
                    print(f"[DB ERROR dm:send] {e}")
                    continue
                finally:
                    db.close()

                await dm_hub.send_to_user(target_id, out_msg)
                await dm_hub.send_to_user(user_id, out_msg)

            elif mtype == "dm:seen":
                db: Session = SessionLocal()
                try:
                    db.query(DirectMessage).filter(
                        DirectMessage.sender_id == target_id,
                        DirectMessage.recipient_id == user_id,
                        DirectMessage.read_at.is_(None)
                    ).update({"read_at": func.now()}, synchronize_session=False)
                    db.commit()
                except Exception as e:
                    print(f"[DB ERROR dm:seen] {e}")
                finally:
                    db.close()
                
                await dm_hub.send_to_user(target_id, {
                    "type": "dm:seen",
                    "reader_id": user_id
                })

            elif mtype in ("call:offer", "call:answer", "call:ice-candidate", "call:end", "call:reject"):
                # Save Missed Call to Database if rejected or ended early
                if mtype == "call:reject" or (mtype == "call:end" and msg.get("is_missed")):
                    db: Session = SessionLocal()
                    try:
                        call_content = f"Missed {msg.get('call_type', 'audio')} call"
                        mm = DirectMessage(
                            sender_id=user_id,
                            recipient_id=target_id,
                            content=call_content,
                        )
                        db.add(mm)
                        db.commit()
                        db.refresh(mm)
                        
                        out_msg = {
                            "type": "dm:new",
                            "id": mm.id,
                            "sender_id": user_id,
                            "recipient_id": target_id,
                            "content": mm.content,
                            "media_url": None,
                            "reply_to_id": None,
                            "created_at": mm.created_at.isoformat()
                        }
                        await dm_hub.send_to_user(target_id, out_msg)
                        await dm_hub.send_to_user(user_id, out_msg)
                    except Exception as e:
                        print(f"[DB ERROR missed call] {e}")
                    finally:
                        db.close()

                await dm_hub.send_to_user(target_id, {
                    **msg,
                    "sender_id": user_id
                })

    except WebSocketDisconnect:
        dm_hub.disconnect(user_id, ws)
    except Exception as e:
        print(f"[WS ERROR] {e}")
        dm_hub.disconnect(user_id, ws)

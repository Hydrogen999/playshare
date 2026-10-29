import asyncio
import json

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.match import Match
from app.models.room import Message, Room, RoomMember
from app.models.user import User
from app.redis_client import get_redis
from app.security import decode_token
from app.services import presence as presence_svc
from app.services.dice import DiceError, play_match
from app.services.elo import new_ratings as elo_new_ratings, tier_for as elo_tier
from app.services.games.chess import (
    from_fen, to_fen, make_move, legal_moves,
    state_to_dict as chess_state_to_dict,
    result as chess_result,
)
from app.services.games.ludo import (
    LudoState, PlayerState, apply_move, begin_roll,
    legal_moves as ludo_legal_moves, new_ludo_game, state_to_dict as ludo_state_to_dict,
)
from app.services.games.whot import (
    WhotState, play_card as whot_play_card, draw_card as whot_draw_card, 
    new_whot_game, state_to_dict as whot_state_to_dict, 
    state_from_dict as whot_state_from_dict, serialize_full_state as whot_full_state
)
from app.services.ledger import LedgerError, lock_wager, refund_wager, settle_winner
from app.services.tournament import advance_winner
from app.services.xp import award_match_xp

router = APIRouter()

ALLOWED_GAMES = {"dice", "ludo", "chess", "whot"}
ROOM_CHANNEL_PREFIX = "playsphere:room:"


def _elo_of(user: User | None, default: int = 1200) -> int:
    if not user or not user.profile:
        return default
    return getattr(user.profile, "elo_rating", default) or default


class RoomHub:
    def __init__(self):
        self.local: dict[str, dict[str, WebSocket]] = {}
        self.spectators: dict[str, set[str]] = {} # Track spectators
        self._redis = None
        self._pubsubs: dict[str, object] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    async def _ensure_started(self):
        if self._redis is None:
            self._redis = get_redis()

    async def subscribe(self, room_id: str):
        await self._ensure_started()
        if room_id in self._pubsubs:
            return
        ps = self._redis.pubsub()
        await ps.subscribe(f"{ROOM_CHANNEL_PREFIX}{room_id}")
        self._pubsubs[room_id] = ps
        self._tasks[room_id] = asyncio.create_task(self._listen(room_id, ps))

    async def _listen(self, room_id: str, ps):
        try:
            async for msg in ps.listen():
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
                peers = self.local.get(room_id, {})

                if target:
                    sock = peers.get(target)
                    if sock:
                        try:
                            await sock.send_text(json.dumps(raw))
                        except Exception:
                            peers.pop(target, None)
                    continue

                for uid, sock in list(peers.items()):
                    if uid == sender:
                        continue
                    try:
                        await sock.send_text(json.dumps(raw))
                    except Exception:
                        peers.pop(uid, None)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[room listener {room_id}] {e}")

    async def publish(self, room_id: str, raw: dict,
                      exclude: str | None = None, target: str | None = None):
        await self._ensure_started()
        env = {"__raw": raw}
        if exclude:
            env["__sender"] = exclude
        if target:
            env["__target"] = target
        await self._redis.publish(f"{ROOM_CHANNEL_PREFIX}{room_id}", json.dumps(env))

    async def send_local(self, room_id: str, user_id: str, raw: dict):
        sock = self.local.get(room_id, {}).get(user_id)
        if not sock:
            return
        try:
            await sock.send_text(json.dumps(raw))
        except Exception:
            self.local.get(room_id, {}).pop(user_id, None)

    async def send_to_user(self, room_id: str, user_id: str, raw: dict):
        if user_id in self.local.get(room_id, {}):
            await self.send_local(room_id, user_id, raw)
        else:
            await self.publish(room_id, raw, target=user_id)

    async def join(self, room_id: str, user_id: str, ws: WebSocket, spectator: bool = False):
        self.local.setdefault(room_id, {})[user_id] = ws
        if spectator:
            self.spectators.setdefault(room_id, set()).add(user_id)
        await self.subscribe(room_id)

    async def leave(self, room_id: str, user_id: str):
        self.local.get(room_id, {}).pop(user_id, None)
        if room_id in self.spectators:
            self.spectators[room_id].discard(user_id)


hub = RoomHub()


def _member_payload(db: Session, member: RoomMember) -> dict:
    u = db.get(User, member.user_id)
    return {
        "user_id": member.user_id,
        "username": u.username if u else "unknown",
        "avatar_id": u.profile.avatar_id if u else "fox",
        "level": u.profile.level if u else 1,
        "ready": member.ready,
    }


def _ensure_pending_match(db: Session, room: Room) -> Match | None:
    existing = (
        db.query(Match)
        .filter(Match.room_id == room.id, Match.status.in_(["pending", "playing"]))
        .first()
    )
    if existing:
        return existing
    members = db.query(RoomMember).filter(RoomMember.room_id == room.id).all()
    if len(members) < 2:
        return None
    m = Match(
        room_id=room.id,
        game_slug=room.game_slug,
        status="pending",
        wager=room.wager or 0,
        player_a=members[0].user_id,
        player_b=members[1].user_id,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _match_payload(m: Match) -> dict:
    return {
        "id": m.id, "room_id": m.room_id, "game_slug": m.game_slug,
        "status": m.status, "wager": m.wager, "player_a": m.player_a,
        "player_b": m.player_b, "roll_a": m.roll_a, "roll_b": m.roll_b,
        "winner_id": m.winner_id, "result": m.result,
    }


def _settle_match(db: Session, m: Match, winner_id: str | None) -> dict:
    if m.wager > 0:
        try:
            lock_wager(db, m.id, m.player_a, m.player_b, m.wager)
        except LedgerError:
            pass
        if winner_id is None:
            try:
                refund_wager(db, m.id, m.player_a, m.player_b, m.wager)
            except LedgerError:
                pass
        else:
            try:
                settle_winner(db, m.id, winner_id, m.wager)
            except LedgerError:
                pass
    m.status = "finished"
    m.winner_id = winner_id
    m.result = "draw" if winner_id is None else "win"
    
    # Set Room back to waiting
    room = db.get(Room, m.room_id)
    if room:
        room.status = "waiting"
        
    db.commit()
    try:
        return award_match_xp(db, m)
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# LUDO
# ---------------------------------------------------------------------------
def _load_ludo_state(m: Match) -> LudoState:
    data = json.loads(m.state_json)
    players = [
        PlayerState(user_id=p["user_id"], color=p["color"], tokens=list(p["tokens"]))
        for p in data["players"]
    ]
    return LudoState(
        players=players,
        current_player_index=data["current_player_index"],
        last_roll=data["last_roll"],
        dice_rolled=data["dice_rolled"],
        awaiting_token_choice=data["awaiting_token_choice"],
        winner_user_id=data["winner_user_id"],
        turn_number=data["turn_number"],
        consecutive_sixes=data.get("consecutive_sixes", 0),
    )

def _save_ludo_state(db: Session, m: Match, state: LudoState):
    m.state_json = json.dumps(ludo_state_to_dict(state))
    db.commit()

def _start_ludo_match(db: Session, room: Room) -> Match | None:
    members = db.query(RoomMember).filter(RoomMember.room_id == room.id).all()
    n = len(members)
    if n < 2 or n > 4:
        return None
    old = db.query(Match).filter(Match.room_id == room.id, Match.status.in_(["pending", "playing"])).all()
    for m in old:
        m.status = "closed"
    user_ids = [m.user_id for m in members]
    state = new_ludo_game(user_ids)
    m = Match(
        room_id=room.id, game_slug="ludo", status="playing", wager=room.wager or 0,
        player_a=user_ids[0], player_b=user_ids[1], state_json=json.dumps(ludo_state_to_dict(state)),
    )
    room.status = "playing" # <-- Update room status
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


# ---------------------------------------------------------------------------
# CHESS
# ---------------------------------------------------------------------------
def _new_chess_state(white_id: str, black_id: str) -> dict:
    from app.services.games.chess import START_FEN
    return {
        "fen": START_FEN, "white_id": white_id, "black_id": black_id,
        "moves": [], "sans": [], "resigned_by": None, "draw_offered_by": None,
    }

def _load_chess_state(m: Match) -> dict:
    return json.loads(m.state_json)

def _save_chess_state(db: Session, m: Match, state: dict):
    m.state_json = json.dumps(state)
    db.commit()

def _start_chess_match(db: Session, room: Room) -> Match | None:
    members = db.query(RoomMember).filter(RoomMember.room_id == room.id).all()
    if len(members) != 2:
        return None
    old = db.query(Match).filter(Match.room_id == room.id, Match.status.in_(["pending", "playing"])).all()
    for m in old:
        m.status = "closed"
    white, black = members[0].user_id, members[1].user_id
    state = _new_chess_state(white, black)
    m = Match(
        room_id=room.id, game_slug="chess", status="playing", wager=room.wager or 0,
        player_a=white, player_b=black, state_json=json.dumps(state),
    )
    room.status = "playing" # <-- Update room status
    db.add(m)
    db.commit()
    db.refresh(m)
    return m

def _find_legal_move_by_uci(board, uci: str):
    for mv in legal_moves(board):
        if mv.to_uci() == uci:
            return mv
    return None

def _update_chess_elo(db: Session, st: dict, outcome: str) -> dict:
    try:
        white, black = db.get(User, st["white_id"]), db.get(User, st["black_id"])
        if not white or not black or not white.profile or not black.profile:
            return {}
        wa, ba = _elo_of(white), _elo_of(black)
        wg, bg = white.profile.chess_games_played or 0, black.profile.chess_games_played or 0
        elo_outcome = "a_win" if outcome == "w" else ("b_win" if outcome == "b" else "draw")
        new_w, new_b = elo_new_ratings(wa, ba, wg, bg, elo_outcome)
        white.profile.elo_rating = new_w
        black.profile.elo_rating = new_b
        white.profile.chess_games_played = wg + 1
        black.profile.chess_games_played = bg + 1
        if outcome == "w":
            white.profile.chess_wins = (white.profile.chess_wins or 0) + 1
            black.profile.chess_losses = (black.profile.chess_losses or 0) + 1
        elif outcome == "b":
            black.profile.chess_wins = (black.profile.chess_wins or 0) + 1
            white.profile.chess_losses = (white.profile.chess_losses or 0) + 1
        else:
            white.profile.chess_draws = (white.profile.chess_draws or 0) + 1
            black.profile.chess_draws = (black.profile.chess_draws or 0) + 1
        db.commit()
        return {
            "white": {"before": wa, "after": new_w, "delta": new_w - wa, "tier": elo_tier(new_w)},
            "black": {"before": ba, "after": new_b, "delta": new_b - ba, "tier": elo_tier(new_b)},
        }
    except Exception as e:
        print(f"[elo update error] {e}")
        db.rollback()
        return {}


# ---------------------------------------------------------------------------
# WHOT
# ---------------------------------------------------------------------------
def _load_whot_state(m: Match) -> WhotState:
    return whot_state_from_dict(json.loads(m.state_json))

def _save_whot_state(db: Session, m: Match, state: WhotState):
    m.state_json = json.dumps(whot_full_state(state)) 
    db.commit()

def _start_whot_match(db: Session, room: Room) -> Match | None:
    members = db.query(RoomMember).filter(RoomMember.room_id == room.id).all()
    n = len(members)
    if n < 2 or n > 4:
        return None
    old = db.query(Match).filter(Match.room_id == room.id, Match.status.in_(["pending", "playing"])).all()
    for m in old:
        m.status = "closed"
    user_ids = [m.user_id for m in members]
    state = new_whot_game(user_ids)
    m = Match(
        room_id=room.id, game_slug="whot", status="playing", wager=room.wager or 0,
        player_a=user_ids[0], player_b=user_ids[1], 
        state_json=json.dumps(whot_full_state(state)),
    )
    room.status = "playing" # <-- Update room status
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


# ---------------------------------------------------------------------------
# WEBSOCKET
# ---------------------------------------------------------------------------
@router.websocket("/ws/room/{room_id}")
async def room_ws(
    ws: WebSocket,
    room_id: str,
    token: str = Query(...),
    reconnect_token: str | None = Query(None),
    spectator: bool = Query(False), # <-- NEW SPECTATOR FLAG
):
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
        room = db.get(Room, room_id)
        if not user or not room or user.is_banned:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
            
        members = db.query(RoomMember).filter(RoomMember.room_id == room_id).all()
        
        if spectator:
            if room.status != "playing":
                await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                return
        else:
            if user_id not in {m.user_id for m in members}:
                # --- FIX: AUTO-JOIN IF ROOM IS WAITING AND HAS SPACE ---
                if room.status == "waiting" and len(members) < (room.max_players or 4):
                    new_member = RoomMember(room_id=room_id, user_id=user_id)
                    db.add(new_member)
                    db.commit()
                    members = db.query(RoomMember).filter(RoomMember.room_id == room_id).all()
                else:
                    await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
            # --- FIX END ---

            if reconnect_token and not presence_svc.validate_token(db, room_id, user_id, reconnect_token):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                return

        members_payload = [_member_payload(db, m) for m in members]
        msgs = db.query(Message).filter(Message.room_id == room_id).order_by(Message.created_at.desc()).limit(50).all()
        msgs_payload = [{"id": m.id, "sender_id": m.sender_id, "content": m.content, "created_at": m.created_at.isoformat()} for m in reversed(msgs)]
        room_meta = {
            "id": room.id, "game_slug": room.game_slug, "status": room.status, "wager": room.wager,
            "code": room.code, "tournament_match_id": room.tournament_match_id, "is_public": room.is_public,
        }
        
        pending = _ensure_pending_match(db, room)
        match_payload = _match_payload(pending) if pending else None

        ludo_state = chess_state = whot_state = None
        if pending and pending.state_json:
            if pending.game_slug == "ludo":
                ludo_state = json.loads(pending.state_json)
            elif pending.game_slug == "chess":
                chess_state = json.loads(pending.state_json)
                try:
                    board = from_fen(chess_state["fen"])
                    chess_state["board"] = chess_state_to_dict(board)
                    w_user, b_user = db.get(User, chess_state["white_id"]), db.get(User, chess_state["black_id"])
                    chess_state["white_tier"] = elo_tier(_elo_of(w_user))
                    chess_state["black_tier"] = elo_tier(_elo_of(b_user))
                except Exception:
                    chess_state["board"] = None
            elif pending.game_slug == "whot":
                viewer = "spectator" if spectator else user_id
                whot_state = whot_state_to_dict(_load_whot_state(pending), viewer)
    finally:
        db.close()

    await ws.accept()

    if not spectator:
        db_p = SessionLocal()
        try:
            issue_token = presence_svc.get_or_create_token(db_p, room_id, user_id)
            await presence_svc.mark_online(db_p, room_id, user_id, reconnect_token or issue_token)
        finally:
            db_p.close()
    else:
        issue_token = None

    await hub.join(room_id, user_id, ws, spectator=spectator)

    await ws.send_text(json.dumps({
        "type": "room:init",
        "you": user_id,
        "is_spectator": spectator,
        "reconnect_token": issue_token,
        "room": room_meta,
        "members": members_payload,
        "messages": msgs_payload,
        "match": match_payload,
        "ludo_state": ludo_state,
        "chess_state": chess_state,
        "whot_state": whot_state,
    }))

    if not spectator:
        await hub.publish(room_id, {"type": "room:player_joined", "user_id": user_id}, exclude=user_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "presence:ping":
                if spectator: 
                    await ws.send_text(json.dumps({"type": "presence:pong"}))
                    continue
                db_h: Session = SessionLocal()
                try:
                    await presence_svc.mark_online(db_h, room_id, user_id)
                finally:
                    db_h.close()
                await ws.send_text(json.dumps({"type": "presence:pong"}))
                continue

            if mtype == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
                continue
                
            if spectator and mtype != "chat:send":
                continue

            elif mtype == "chat:send":
                content = (msg.get("content") or "").strip()[:500]
                if not content:
                    continue
                db2: Session = SessionLocal()
                try:
                    mm = Message(room_id=room_id, sender_id=user_id, content=content)
                    db2.add(mm)
                    db2.commit()
                    db2.refresh(mm)
                    out = {"type": "chat:message", "id": mm.id, "sender_id": user_id, "content": mm.content, "created_at": mm.created_at.isoformat()}
                finally:
                    db2.close()
                await hub.publish(room_id, out)

            elif mtype == "room:set_game":
                slug = (msg.get("game_slug") or "").strip().lower()
                if slug not in ALLOWED_GAMES:
                    continue
                db_g: Session = SessionLocal()
                try:
                    r = db_g.get(Room, room_id)
                    if r and r.status == "waiting" and not r.tournament_match_id:
                        r.game_slug = slug
                        mm = db_g.query(Match).filter(Match.room_id == room_id, Match.status == "pending").first()
                        if mm:
                            mm.game_slug = slug
                        db_g.commit()
                finally:
                    db_g.close()
                await hub.publish(room_id, {"type": "room:game_update", "game_slug": slug, "set_by": user_id})

            elif mtype == "room:set_wager":
                try:
                    w = int(msg.get("wager", 0))
                except (TypeError, ValueError):
                    continue
                if w < 0 or w > 10000:
                    continue
                db6: Session = SessionLocal()
                payload_m = None
                try:
                    r = db6.get(Room, room_id)
                    if r and r.tournament_match_id:
                        continue
                    mm = db6.query(Match).filter(Match.room_id == room_id, Match.status.in_(["pending", "playing"])).first()
                    if r and mm:
                        mm.wager = w
                        r.wager = w
                        db6.commit()
                        payload_m = _match_payload(mm)
                finally:
                    db6.close()
                if payload_m:
                    await hub.publish(room_id, {"type": "room:wager_update", "match": payload_m})

            elif mtype == "room:ready":
                ready_val = bool(msg.get("ready", True))
                both_ready = False
                ready_payload: list[dict] = []
                current_game = "dice"
                member_count = 0
                db3: Session = SessionLocal()
                try:
                    member = db3.query(RoomMember).filter(RoomMember.room_id == room_id, RoomMember.user_id == user_id).first()
                    room_obj = db3.get(Room, room_id)
                    if room_obj:
                        current_game = room_obj.game_slug
                    if member:
                        member.ready = ready_val
                        db3.commit()
                        all_members = db3.query(RoomMember).filter(RoomMember.room_id == room_id).all()
                        member_count = len(all_members)
                        ready_payload = [{"user_id": x.user_id, "ready": x.ready} for x in all_members]
                        if current_game in ("ludo", "whot"):
                            both_ready = member_count >= 2 and all(x["ready"] for x in ready_payload)
                        else:
                            both_ready = member_count == 2 and all(x["ready"] for x in ready_payload)
                finally:
                    db3.close()

                await hub.publish(room_id, {"type": "room:ready_update", "members": ready_payload})

                if both_ready:
                    await hub.publish(room_id, {"type": "room:all_ready"})
                    db4: Session = SessionLocal()
                    try:
                        for x in db4.query(RoomMember).filter(RoomMember.room_id == room_id).all():
                            x.ready = False
                        db4.commit()
                    finally:
                        db4.close()

                    if current_game == "ludo":
                        db5: Session = SessionLocal()
                        try:
                            r = db5.get(Room, room_id)
                            m5 = _start_ludo_match(db5, r)
                            if m5:
                                await hub.publish(room_id, {"type": "ludo:start", "match_id": m5.id, "wager": m5.wager, "state": json.loads(m5.state_json)})
                        finally:
                            db5.close()

                    elif current_game == "chess":
                        db5: Session = SessionLocal()
                        try:
                            r = db5.get(Room, room_id)
                            m5 = _start_chess_match(db5, r)
                            if m5:
                                st = json.loads(m5.state_json)
                                board = from_fen(st["fen"])
                                w_user, b_user = db5.get(User, st["white_id"]), db5.get(User, st["black_id"])
                                await hub.publish(room_id, {
                                    "type": "chess:start", "match_id": m5.id, "wager": m5.wager,
                                    "white_id": st["white_id"], "black_id": st["black_id"],
                                    "white_tier": elo_tier(_elo_of(w_user)), "black_tier": elo_tier(_elo_of(b_user)),
                                    "board": chess_state_to_dict(board),
                                })
                        finally:
                            db5.close()

                    elif current_game == "whot":
                        db5: Session = SessionLocal()
                        try:
                            r = db5.get(Room, room_id)
                            m5 = _start_whot_match(db5, r)
                            if m5:
                                for member in db5.query(RoomMember).filter(RoomMember.room_id == room_id).all():
                                    state_dict = whot_state_to_dict(_load_whot_state(m5), member.user_id)
                                    await hub.send_to_user(room_id, member.user_id, {
                                        "type": "whot:start", "match_id": m5.id, "wager": m5.wager, "state": state_dict
                                    })
                                spec_state = whot_state_to_dict(_load_whot_state(m5), "spectator")
                                for spec_id in hub.spectators.get(room_id, set()):
                                    await hub.send_to_user(room_id, spec_id, {
                                        "type": "whot:start", "match_id": m5.id, "wager": m5.wager, "state": spec_state
                                    })
                        finally:
                            db5.close()

                    else:
                        db5: Session = SessionLocal()
                        try:
                            r = db5.get(Room, room_id)
                            m5 = _ensure_pending_match(db5, r)
                            if m5:
                                try:
                                    result = play_match(db5, m5.id)
                                    try:
                                        result["xp"] = award_match_xp(db5, m5)
                                    except Exception:
                                        pass
                                    await hub.publish(room_id, {"type": "match:result", "result": result})
                                except DiceError as e:
                                    await hub.publish(room_id, {"type": "match:error", "error": str(e)})
                        finally:
                            db5.close()

            # --- LUDO ---
            elif mtype == "ludo:roll":
                db_l: Session = SessionLocal()
                try:
                    m = db_l.query(Match).filter(Match.room_id == room_id, Match.game_slug == "ludo", Match.status == "playing").first()
                    if not m or not m.state_json:
                        await hub.send_local(room_id, user_id, {"type": "ludo:error", "error": "No active ludo game"})
                        continue
                    state = _load_ludo_state(m)
                    if state.winner_user_id:
                        await hub.send_local(room_id, user_id, {"type": "ludo:error", "error": "Game finished"})
                        continue
                    if state.current().user_id != user_id:
                        await hub.send_local(room_id, user_id, {"type": "ludo:error", "error": "Not your turn"})
                        continue
                    if state.dice_rolled:
                        await hub.send_local(room_id, user_id, {"type": "ludo:error", "error": "Already rolled"})
                        continue
                    roll = begin_roll(state)
                    moves = ludo_legal_moves(state, roll)
                    _save_ludo_state(db_l, m, state)
                    await hub.publish(room_id, {"type": "ludo:rolled", "user_id": user_id, "roll": roll, "legal_moves": moves, "state": ludo_state_to_dict(state)})
                finally:
                    db_l.close()

            elif mtype == "ludo:move":
                try:
                    token_index = int(msg.get("token_index"))
                except (TypeError, ValueError):
                    continue
                db_l2: Session = SessionLocal()
                try:
                    m = db_l2.query(Match).filter(Match.room_id == room_id, Match.game_slug == "ludo", Match.status == "playing").first()
                    if not m or not m.state_json:
                        continue
                    state = _load_ludo_state(m)
                    if state.current().user_id != user_id or not state.awaiting_token_choice:
                        await hub.send_local(room_id, user_id, {"type": "ludo:error", "error": "Not your move"})
                        continue
                    roll = state.last_roll
                    if roll is None:
                        continue
                    result = apply_move(state, token_index, roll)
                    if not result.ok:
                        await hub.send_local(room_id, user_id, {"type": "ludo:error", "error": result.error or "Illegal move"})
                        continue
                    _save_ludo_state(db_l2, m, state)
                    await hub.publish(room_id, {
                        "type": "ludo:moved", "user_id": user_id, "token_index": token_index, "roll": roll,
                        "captured": result.captured, "entered_home": result.entered_home, "extra_turn": result.extra_turn,
                        "next_turn_user_id": result.next_turn_user_id, "winner_user_id": result.winner_user_id, "state": ludo_state_to_dict(state),
                    })
                    if result.winner_user_id:
                        xp_rewards = _settle_match(db_l2, m, result.winner_user_id)
                        try:
                            _room = db_l2.get(Room, room_id)
                            if _room and _room.tournament_match_id:
                                advance_winner(db_l2, _room.tournament_match_id, result.winner_user_id)
                        except Exception as _e:
                            print(f"[tournament advance error] {_e}")
                        await hub.publish(room_id, {"type": "ludo:end", "winner_user_id": result.winner_user_id, "wager": m.wager, "pot": m.wager * 2, "xp": xp_rewards})
                finally:
                    db_l2.close()

            # --- CHESS ---
            elif mtype == "chess:move":
                uci = (msg.get("uci") or "").strip().lower()
                if not uci:
                    continue
                db_c: Session = SessionLocal()
                try:
                    m = db_c.query(Match).filter(Match.room_id == room_id, Match.game_slug == "chess", Match.status == "playing").first()
                    if not m or not m.state_json:
                        await hub.send_local(room_id, user_id, {"type": "chess:error", "error": "No active chess game"})
                        continue
                    st = _load_chess_state(m)
                    board = from_fen(st["fen"])
                    my_color = "w" if st["white_id"] == user_id else ("b" if st["black_id"] == user_id else None)
                    if not my_color:
                        await hub.send_local(room_id, user_id, {"type": "chess:error", "error": "You are not in this match"})
                        continue
                    if board.turn != my_color:
                        await hub.send_local(room_id, user_id, {"type": "chess:error", "error": "Not your turn"})
                        continue
                    mv = _find_legal_move_by_uci(board, uci)
                    if not mv:
                        await hub.send_local(room_id, user_id, {"type": "chess:error", "error": "Illegal move"})
                        continue
                    san = mv.to_san(board)
                    new_board = make_move(board, mv)
                    st["fen"] = to_fen(new_board)
                    st["moves"].append(uci)
                    st["sans"].append(san)
                    st["draw_offered_by"] = None
                    outcome = chess_result(new_board)
                    winner_id = st["white_id"] if outcome == "w" else (st["black_id"] if outcome == "b" else None)
                    _save_chess_state(db_c, m, st)
                    await hub.publish(room_id, {"type": "chess:moved", "user_id": user_id, "uci": uci, "san": san, "board": chess_state_to_dict(new_board)})
                    if outcome is not None:
                        xp_rewards = _settle_match(db_c, m, winner_id)
                        elo_result = _update_chess_elo(db_c, st, outcome)
                        await hub.publish(room_id, {"type": "chess:end", "result": outcome, "winner_id": winner_id, "wager": m.wager, "pot": m.wager * 2, "xp": xp_rewards, "elo": elo_result})
                finally:
                    db_c.close()

            elif mtype == "chess:offer_draw":
                db_cd: Session = SessionLocal()
                try:
                    m = db_cd.query(Match).filter(Match.room_id == room_id, Match.game_slug == "chess", Match.status == "playing").first()
                    if not m or not m.state_json:
                        continue
                    st = _load_chess_state(m)
                    if user_id not in (st["white_id"], st["black_id"]):
                        continue
                    if st.get("draw_offered_by"):
                        await hub.send_local(room_id, user_id, {"type": "chess:error", "error": "Draw already offered"})
                        continue
                    st["draw_offered_by"] = user_id
                    _save_chess_state(db_cd, m, st)
                    opponent_id = st["black_id"] if user_id == st["white_id"] else st["white_id"]
                    await hub.send_to_user(room_id, opponent_id, {"type": "chess:draw_offered", "from_user_id": user_id})
                    await hub.send_local(room_id, user_id, {"type": "chess:draw_offered_sent"})
                finally:
                    db_cd.close()

            elif mtype == "chess:respond_draw":
                accept = bool(msg.get("accept", False))
                db_cd2: Session = SessionLocal()
                try:
                    m = db_cd2.query(Match).filter(Match.room_id == room_id, Match.game_slug == "chess", Match.status == "playing").first()
                    if not m or not m.state_json:
                        continue
                    st = _load_chess_state(m)
                    offerer = st.get("draw_offered_by")
                    if not offerer or offerer == user_id:
                        await hub.send_local(room_id, user_id, {"type": "chess:error", "error": "No pending draw offer"})
                        continue
                    if accept:
                        st["draw_offered_by"] = None
                        _save_chess_state(db_cd2, m, st)
                        xp_rewards = _settle_match(db_cd2, m, None)
                        elo_result = _update_chess_elo(db_cd2, st, "draw")
                        await hub.publish(room_id, {"type": "chess:end", "result": "draw", "winner_id": None, "wager": m.wager, "pot": 0, "xp": xp_rewards, "elo": elo_result})
                    else:
                        st["draw_offered_by"] = None
                        _save_chess_state(db_cd2, m, st)
                        await hub.publish(room_id, {"type": "chess:draw_declined"})
                finally:
                    db_cd2.close()

            elif mtype == "chess:resign":
                db_cr: Session = SessionLocal()
                try:
                    m = db_cr.query(Match).filter(Match.room_id == room_id, Match.game_slug == "chess", Match.status == "playing").first()
                    if not m or not m.state_json:
                        continue
                    st = _load_chess_state(m)
                    if user_id not in (st["white_id"], st["black_id"]):
                        continue
                    if st.get("resigned_by"):
                        continue
                    st["resigned_by"] = user_id
                    _save_chess_state(db_cr, m, st)
                    winner_id = st["black_id"] if user_id == st["white_id"] else st["white_id"]
                    outcome = "b" if winner_id == st["black_id"] else "w"
                    xp_rewards = _settle_match(db_cr, m, winner_id)
                    elo_result = _update_chess_elo(db_cr, st, outcome)
                    await hub.publish(room_id, {"type": "chess:end", "result": outcome, "winner_id": winner_id, "wager": m.wager, "pot": m.wager * 2, "resigned": True, "xp": xp_rewards, "elo": elo_result})
                finally:
                    db_cr.close()

            # --- WHOT ---
            elif mtype == "whot:play":
                try:
                    card_index = int(msg.get("card_index"))
                except (TypeError, ValueError):
                    continue
                chosen_shape = msg.get("chosen_shape")
                db_w: Session = SessionLocal()
                try:
                    m = db_w.query(Match).filter(Match.room_id == room_id, Match.game_slug == "whot", Match.status == "playing").first()
                    if not m or not m.state_json:
                        continue
                    state = _load_whot_state(m)
                    if state.winner_user_id:
                        continue
                    result = whot_play_card(state, user_id, card_index, chosen_shape)
                    if not result.get("ok"):
                        await hub.send_local(room_id, user_id, {"type": "whot:error", "error": result.get("error")})
                        continue
                    
                    _save_whot_state(db_w, m, state)
                    
                    for member in db_w.query(RoomMember).filter(RoomMember.room_id == room_id).all():
                        state_dict = whot_state_to_dict(state, member.user_id)
                        await hub.send_to_user(room_id, member.user_id, {
                            "type": "whot:played", "user_id": user_id, "state": state_dict
                        })
                    
                    spec_state = whot_state_to_dict(state, "spectator")
                    for spec_id in hub.spectators.get(room_id, set()):
                        await hub.send_to_user(room_id, spec_id, {
                            "type": "whot:played", "user_id": user_id, "state": spec_state
                        })

                    if result.get("winner"):
                        xp_rewards = _settle_match(db_w, m, user_id)
                        await hub.publish(room_id, {"type": "whot:end", "winner_user_id": user_id, "wager": m.wager, "pot": m.wager * 2, "xp": xp_rewards})
                finally:
                    db_w.close()

            elif mtype == "whot:draw":
                db_wd: Session = SessionLocal()
                try:
                    m = db_wd.query(Match).filter(Match.room_id == room_id, Match.game_slug == "whot", Match.status == "playing").first()
                    if not m or not m.state_json:
                        continue
                    state = _load_whot_state(m)
                    if state.winner_user_id:
                        continue
                    result = whot_draw_card(state, user_id)
                    if not result.get("ok"):
                        await hub.send_local(room_id, user_id, {"type": "whot:error", "error": result.get("error")})
                        continue
                    
                    _save_whot_state(db_wd, m, state)
                    
                    for member in db_wd.query(RoomMember).filter(RoomMember.room_id == room_id).all():
                        state_dict = whot_state_to_dict(state, member.user_id)
                        await hub.send_to_user(room_id, member.user_id, {
                            "type": "whot:played", "user_id": user_id, "state": state_dict
                        })

                    spec_state = whot_state_to_dict(state, "spectator")
                    for spec_id in hub.spectators.get(room_id, set()):
                        await hub.send_to_user(room_id, spec_id, {
                            "type": "whot:played", "user_id": user_id, "state": spec_state
                        })
                finally:
                    db_wd.close()

    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(room_id, user_id)
        if not spectator:
            db_off: Session = SessionLocal()
            try:
                await presence_svc.mark_offline(db_off, room_id, user_id)
            finally:
                db_off.close()
            await hub.publish(room_id, {"type": "room:player_disconnected", "user_id": user_id})

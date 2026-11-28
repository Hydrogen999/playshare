"""Tournament engine — single elimination brackets."""

import json
import math
import random
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.room import Room, RoomMember
from app.models.social import Notification
from app.models.tournament import Tournament, TournamentMatch, TournamentPlayer
from app.models.user import User
from app.services.ledger import (
    ESCROW_ACCOUNT, LedgerError, get_balance, post_transaction,
)

PRIZE_1ST = 0.70
PRIZE_2ND = 0.20
PRIZE_3RD = 0.05  # each semifinal loser


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _rounds_for(max_players: int) -> int:
    return int(math.log2(max_players))


def _notify(db: Session, user_id: str, kind: str, payload: dict):
    db.add(Notification(
        user_id=user_id,
        type=kind,
        payload=json.dumps(payload),
    ))


# ---------- Create / Join ----------

def create_tournament(
    db: Session,
    creator_id: str,
    name: str,
    entry_fee: int,
    max_players: int = 8,
) -> dict:
    if entry_fee < 10 or entry_fee > 5000:
        return {"ok": False, "error": "Entry fee must be 10–5000"}
    if max_players not in (4, 8, 16):
        return {"ok": False, "error": "Size must be 4, 8, or 16"}
    if get_balance(db, creator_id) < entry_fee:
        return {"ok": False, "error": "Not enough PlayCoins"}

    name = (name or "Ludo Tournament").strip()[:60]

    t = Tournament(
        name=name,
        creator_id=creator_id,
        entry_fee=entry_fee,
        max_players=max_players,
        status="waiting",
        prize_pool=0,
    )
    db.add(t)
    db.flush()

    # Auto-join creator
    result = join_tournament(db, t.id, creator_id)
    if not result["ok"]:
        db.rollback()
        return result
    return {"ok": True, "tournament_id": t.id}


def join_tournament(db: Session, tournament_id: str, user_id: str) -> dict:
    t = db.get(Tournament, tournament_id)
    if not t:
        return {"ok": False, "error": "Tournament not found"}
    if t.status != "waiting":
        return {"ok": False, "error": "Tournament already started"}

    existing = db.get(TournamentPlayer, (tournament_id, user_id))
    if existing:
        return {"ok": False, "error": "Already registered"}

    player_count = (
        db.query(TournamentPlayer)
        .filter(TournamentPlayer.tournament_id == tournament_id)
        .count()
    )
    if player_count >= t.max_players:
        return {"ok": False, "error": "Tournament is full"}

    if get_balance(db, user_id) < t.entry_fee:
        return {"ok": False, "error": "Not enough PlayCoins"}

    # Lock entry fee → escrow
    try:
        post_transaction(
            db,
            tx_type="tournament_entry",
            entries=[(user_id, -t.entry_fee), (ESCROW_ACCOUNT, +t.entry_fee)],
            idempotency_key=f"tournament_entry:{tournament_id}:{user_id}",
            notes=f"Entry for {t.name}",
        )
    except LedgerError as e:
        return {"ok": False, "error": str(e)}

    db.add(TournamentPlayer(tournament_id=tournament_id, user_id=user_id))
    t.prize_pool += t.entry_fee
    db.commit()

    # Start if now full
    updated_count = (
        db.query(TournamentPlayer)
        .filter(TournamentPlayer.tournament_id == tournament_id)
        .count()
    )
    if updated_count >= t.max_players:
        _start_tournament(db, t)

    return {"ok": True}


def leave_tournament(db: Session, tournament_id: str, user_id: str) -> dict:
    """Only allowed before the tournament starts."""
    t = db.get(Tournament, tournament_id)
    if not t:
        return {"ok": False, "error": "Not found"}
    if t.status != "waiting":
        return {"ok": False, "error": "Tournament already started"}

    p = db.get(TournamentPlayer, (tournament_id, user_id))
    if not p:
        return {"ok": False, "error": "Not registered"}

    # Refund from escrow
    try:
        post_transaction(
            db,
            tx_type="tournament_refund",
            entries=[(ESCROW_ACCOUNT, -t.entry_fee), (user_id, +t.entry_fee)],
            idempotency_key=f"tournament_refund:{tournament_id}:{user_id}",
            notes=f"Refund for {t.name}",
        )
    except LedgerError:
        pass

    db.delete(p)
    t.prize_pool -= t.entry_fee
    db.commit()
    return {"ok": True}


# ---------- Bracket ----------

def _start_tournament(db: Session, t: Tournament) -> None:
    players = (
        db.query(TournamentPlayer)
        .filter(TournamentPlayer.tournament_id == t.id)
        .all()
    )
    ids = [p.user_id for p in players]
    random.shuffle(ids)

    t.status = "active"
    t.started_at = _now()

    total_rounds = _rounds_for(t.max_players)

    # Round 1 — pair up players
    r1_matches = t.max_players // 2
    for p in range(r1_matches):
        m = TournamentMatch(
            tournament_id=t.id,
            round=1,
            position=p,
            player_a=ids[2 * p],
            player_b=ids[2 * p + 1],
            status="pending",
        )
        db.add(m)
        db.flush()
        _start_match_room(db, t, m)

    # Later rounds — empty placeholders
    for r in range(2, total_rounds + 1):
        matches_in_round = t.max_players // (2 ** r)
        for p in range(matches_in_round):
            db.add(TournamentMatch(
                tournament_id=t.id,
                round=r,
                position=p,
                status="pending",
            ))

    db.commit()

    # Notify all players
    for uid in ids:
        _notify(db, uid, "tournament_started", {
            "tournament_id": t.id,
            "tournament_name": t.name,
        })
    db.commit()


def _start_match_room(db: Session, t: Tournament, m: TournamentMatch) -> None:
    """Create a Room for the match, add both players."""
    if not m.player_a or not m.player_b:
        return
    room = Room(
        game_slug="ludo",
        status="waiting",
        wager=0,
        created_by="tournament",
        tournament_match_id=m.id,
    )
    db.add(room)
    db.flush()
    db.add(RoomMember(room_id=room.id, user_id=m.player_a))
    db.add(RoomMember(room_id=room.id, user_id=m.player_b))
    m.room_id = room.id
    m.status = "active"

    for uid in (m.player_a, m.player_b):
        _notify(db, uid, "tournament_match", {
            "tournament_id": t.id,
            "tournament_name": t.name,
            "room_id": room.id,
            "round": m.round,
        })


def advance_winner(db: Session, match_id: str, winner_id: str) -> None:
    """Called when a tournament match's Ludo game finishes."""
    m = db.get(TournamentMatch, match_id)
    if not m or m.winner_id:
        return

    m.winner_id = winner_id
    m.status = "finished"
    m.finished_at = _now()

    t = db.get(Tournament, m.tournament_id)
    if not t:
        db.commit()
        return

    total_rounds = _rounds_for(t.max_players)

    # Mark loser eliminated
    loser = m.player_a if m.winner_id == m.player_b else m.player_b
    if loser:
        lp = db.get(TournamentPlayer, (t.id, loser))
        if lp:
            lp.eliminated = True

    if m.round >= total_rounds:
        _finalize_tournament(db, t, winner_id, m)
        db.commit()
        return

    # Advance winner to next round
    next_round = m.round + 1
    next_position = m.position // 2
    next_m = (
        db.query(TournamentMatch)
        .filter(
            TournamentMatch.tournament_id == t.id,
            TournamentMatch.round == next_round,
            TournamentMatch.position == next_position,
        )
        .first()
    )
    if not next_m:
        db.commit()
        return

    if m.position % 2 == 0:
        next_m.player_a = winner_id
    else:
        next_m.player_b = winner_id

    if next_m.player_a and next_m.player_b and next_m.status == "pending":
        _start_match_room(db, t, next_m)
        for uid in (next_m.player_a, next_m.player_b):
            _notify(db, uid, "tournament_match", {
                "tournament_id": t.id,
                "tournament_name": t.name,
                "room_id": next_m.room_id,
                "round": next_m.round,
            })

    db.commit()


def _finalize_tournament(
    db: Session,
    t: Tournament,
    winner_id: str,
    final_match: TournamentMatch,
) -> None:
    t.status = "finished"
    t.winner_id = winner_id
    t.finished_at = _now()

    total = t.prize_pool
    runner_up = (
        final_match.player_a
        if final_match.winner_id == final_match.player_b
        else final_match.player_b
    )

    # Semifinal losers
    total_rounds = _rounds_for(t.max_players)
    semi_losers: list[str] = []
    if total_rounds >= 2:
        semis = (
            db.query(TournamentMatch)
            .filter(
                TournamentMatch.tournament_id == t.id,
                TournamentMatch.round == total_rounds - 1,
            )
            .all()
        )
        for sm in semis:
            if sm.winner_id:
                loser = sm.player_a if sm.winner_id == sm.player_b else sm.player_b
                if loser:
                    semi_losers.append(loser)

    # Payout amounts
    p1 = int(total * PRIZE_1ST)
    p2 = int(total * PRIZE_2ND) if runner_up else 0
    p3 = int(total * PRIZE_3RD)
    payouts: list[tuple[str, int]] = [(winner_id, p1)]
    if runner_up:
        payouts.append((runner_up, p2))
    for uid in semi_losers:
        payouts.append((uid, p3))

    total_paid = sum(a for _, a in payouts)
    treasury_cut = total - total_paid

    entries = [(ESCROW_ACCOUNT, -total)]
    if treasury_cut > 0:
        entries.append(("treasury", +treasury_cut))
    for uid, amt in payouts:
        if amt > 0:
            entries.append((uid, +amt))

    try:
        post_transaction(
            db,
            tx_type="tournament_payout",
            entries=entries,
            idempotency_key=f"tournament_payout:{t.id}",
            notes=f"Prize payout for {t.name}",
        )
    except LedgerError as e:
        print(f"[tournament payout error] {e}")

    # Placements
    for uid, amt in payouts:
        tp = db.get(TournamentPlayer, (t.id, uid))
        if not tp:
            continue
        if uid == winner_id:
            tp.placement = 1
        elif uid == runner_up:
            tp.placement = 2
        else:
            tp.placement = 3
        _notify(db, uid, "tournament_win", {
            "tournament_id": t.id,
            "tournament_name": t.name,
            "placement": tp.placement,
            "prize": amt,
        })


# ---------- Query ----------

def list_open(db: Session) -> list[dict]:
    rows = (
        db.query(Tournament)
        .filter(Tournament.status == "waiting")
        .order_by(Tournament.created_at.desc())
        .limit(50)
        .all()
    )
    out = []
    for t in rows:
        count = (
            db.query(TournamentPlayer)
            .filter(TournamentPlayer.tournament_id == t.id)
            .count()
        )
        creator = db.get(User, t.creator_id)
        out.append({
            "id": t.id,
            "name": t.name,
            "creator_id": t.creator_id,
            "creator_username": creator.username if creator else "unknown",
            "entry_fee": t.entry_fee,
            "max_players": t.max_players,
            "player_count": count,
            "prize_pool": t.prize_pool,
            "created_at": t.created_at.isoformat(),
        })
    return out


def detail(db: Session, tournament_id: str, viewer_id: str) -> dict | None:
    t = db.get(Tournament, tournament_id)
    if not t:
        return None

    players = (
        db.query(TournamentPlayer)
        .filter(TournamentPlayer.tournament_id == t.id)
        .all()
    )
    user_ids = [p.user_id for p in players]
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

    player_list = []
    for p in players:
        u = users.get(p.user_id)
        player_list.append({
            "user_id": p.user_id,
            "username": u.username if u else "unknown",
            "avatar_id": u.profile.avatar_id if u and u.profile else "fox",
            "level": u.profile.level if u and u.profile else 1,
            "eliminated": p.eliminated,
            "placement": p.placement,
        })

    matches = (
        db.query(TournamentMatch)
        .filter(TournamentMatch.tournament_id == t.id)
        .order_by(TournamentMatch.round.asc(), TournamentMatch.position.asc())
        .all()
    )
    match_list = []
    for m in matches:
        match_list.append({
            "id": m.id,
            "round": m.round,
            "position": m.position,
            "player_a": m.player_a,
            "player_b": m.player_b,
            "room_id": m.room_id,
            "winner_id": m.winner_id,
            "status": m.status,
        })

    return {
        "id": t.id,
        "name": t.name,
        "creator_id": t.creator_id,
        "entry_fee": t.entry_fee,
        "max_players": t.max_players,
        "status": t.status,
        "prize_pool": t.prize_pool,
        "winner_id": t.winner_id,
        "created_at": t.created_at.isoformat(),
        "started_at": t.started_at.isoformat() if t.started_at else None,
        "finished_at": t.finished_at.isoformat() if t.finished_at else None,
        "players": player_list,
        "matches": match_list,
        "viewer_id": viewer_id,
    }


def my_tournaments(db: Session, user_id: str) -> list[dict]:
    rows = (
        db.query(TournamentPlayer)
        .filter(TournamentPlayer.user_id == user_id)
        .all()
    )
    tids = [r.tournament_id for r in rows]
    if not tids:
        return []
    tourns = (
        db.query(Tournament)
        .filter(Tournament.id.in_(tids))
        .order_by(Tournament.created_at.desc())
        .limit(50)
        .all()
    )
    out = []
    for t in tourns:
        tp = db.get(TournamentPlayer, (t.id, user_id))
        out.append({
            "id": t.id,
            "name": t.name,
            "entry_fee": t.entry_fee,
            "max_players": t.max_players,
            "status": t.status,
            "prize_pool": t.prize_pool,
            "placement": tp.placement if tp else None,
            "winner_id": t.winner_id,
        })
    return out
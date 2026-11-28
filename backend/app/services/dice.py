"""Server-authoritative dice game.

The server rolls. The client cannot influence the outcome.
Uses secrets.randbelow for cryptographic RNG.
"""

import json
import secrets

from sqlalchemy.orm import Session

from app.models.match import Match
from app.models.room import Room
from app.services.ledger import LedgerError, lock_wager, refund_wager, settle_winner


class DiceError(Exception):
    pass


def roll_die() -> int:
    """Return 1..6."""
    return secrets.randbelow(6) + 1


def roll_two_dice() -> tuple[int, int, int]:
    """Return (d1, d2, total)."""
    d1 = roll_die()
    d2 = roll_die()
    return d1, d2, d1 + d2


def play_match(db: Session, match_id: str) -> dict:
    """Run a dice match end-to-end. Idempotent on match_id via ledger keys."""
    match = db.get(Match, match_id)
    if not match:
        raise DiceError("Match not found")

    # If already played, return cached result (idempotent)
    if match.status == "finished" and match.result_json:
        return json.loads(match.result_json)

    if match.status == "playing":
        raise DiceError("Match already in progress")

    room = db.get(Room, match.room_id)
    if not room:
        raise DiceError("Room not found")

    wager = match.wager
    if wager < 0:
        raise DiceError("Invalid wager")

    # Lock the wager (moves both players' coins to escrow)
    if wager > 0:
        try:
            lock_wager(db, match.id, match.player_a, match.player_b, wager)
        except LedgerError as e:
            raise DiceError(str(e))

    match.status = "playing"
    db.flush()

    # Roll
    a1, a2, a_total = roll_two_dice()
    b1, b2, b_total = roll_two_dice()

    match.roll_a = a_total
    match.roll_b = b_total

    # Determine winner
    if a_total > b_total:
        winner = match.player_a
        result = "win_a"
    elif b_total > a_total:
        winner = match.player_b
        result = "win_b"
    else:
        winner = None
        result = "draw"

    # Settle
    if wager > 0:
        if winner is None:
            refund_wager(db, match.id, match.player_a, match.player_b, wager)
        else:
            settle_winner(db, match.id, winner, wager)

    from datetime import datetime, timezone
    match.winner_id = winner
    match.result = result
    match.status = "finished"
    match.finished_at = datetime.now(timezone.utc)

    payload = {
        "match_id": match.id,
        "game": "dice",
        "wager": wager,
        "player_a": match.player_a,
        "player_b": match.player_b,
        "roll_a": {"dice": [a1, a2], "total": a_total},
        "roll_b": {"dice": [b1, b2], "total": b_total},
        "winner_id": winner,
        "result": result,
        "pot": wager * 2,
    }
    match.result_json = json.dumps(payload)

    db.commit()
    return payload
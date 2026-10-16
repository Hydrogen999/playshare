"""Ludo game engine (supports 2, 3, or 4 players)."""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# BOARD GEOMETRY
# ---------------------------------------------------------------------------

OUTER_LOOP: list[tuple[int, int]] = [
    (6, 1), (6, 2), (6, 3), (6, 4), (6, 5),
    (5, 6), (4, 6), (3, 6), (2, 6), (1, 6), (0, 6),
    (0, 7), (0, 8),
    (1, 8), (2, 8), (3, 8), (4, 8), (5, 8),
    (6, 9), (6, 10), (6, 11), (6, 12), (6, 13), (6, 14),
    (7, 14),
    (8, 14), (8, 13), (8, 12), (8, 11), (8, 10), (8, 9),
    (9, 8), (10, 8), (11, 8), (12, 8), (13, 8), (14, 8),
    (14, 7),
    (14, 6), (13, 6), (12, 6), (11, 6), (10, 6), (9, 6),
    (8, 5), (8, 4), (8, 3), (8, 2), (8, 1), (8, 0),
    (7, 0),
    (6, 0),
]

LOOP_LEN = 52
TOKENS_PER_PLAYER = 4
HOME_POS = 56

SAFE_INDICES: set[int] = {0, 8, 13, 21, 26, 34, 39, 47}


@dataclass(frozen=True)
class PlayerColor:
    name: str
    start_index: int
    home_column: list[tuple[int, int]]
    home_cell: tuple[int, int]

    def relative_to_absolute(self, rel_pos: int):
        if rel_pos < 0:
            return None
        if rel_pos == HOME_POS:
            return self.home_cell
        if 0 <= rel_pos <= 50:
            return OUTER_LOOP[(self.start_index + rel_pos) % LOOP_LEN]
        if 51 <= rel_pos <= 55:
            return self.home_column[rel_pos - 51]
        raise ValueError(f"Invalid relative position: {rel_pos}")


RED = PlayerColor(
    name="red", start_index=0,
    home_column=[(7, 1), (7, 2), (7, 3), (7, 4), (7, 5)],
    home_cell=(7, 6),
)
GREEN = PlayerColor(
    name="green", start_index=13,
    home_column=[(1, 7), (2, 7), (3, 7), (4, 7), (5, 7)],
    home_cell=(6, 7),
)
YELLOW = PlayerColor(
    name="yellow", start_index=26,
    home_column=[(7, 13), (7, 12), (7, 11), (7, 10), (7, 9)],
    home_cell=(7, 8),
)
BLUE = PlayerColor(
    name="blue", start_index=39,
    home_column=[(13, 7), (12, 7), (11, 7), (10, 7), (9, 7)],
    home_cell=(8, 7),
)

ALL_COLORS: dict[str, PlayerColor] = {
    "red": RED, "green": GREEN, "yellow": YELLOW, "blue": BLUE,
}
TWO_PLAYER_COLORS = ("red", "yellow")
THREE_PLAYER_COLORS = ("red", "green", "yellow")
FOUR_PLAYER_COLORS = ("red", "green", "yellow", "blue")


# ---------------------------------------------------------------------------
# STATE
# ---------------------------------------------------------------------------


@dataclass
class PlayerState:
    user_id: str
    color: str
    tokens: list[int] = field(default_factory=lambda: [-1] * TOKENS_PER_PLAYER)

    @property
    def finished_count(self) -> int:
        return sum(1 for t in self.tokens if t == HOME_POS)

    @property
    def has_won(self) -> bool:
        return self.finished_count == TOKENS_PER_PLAYER


@dataclass
class LudoState:
    players: list[PlayerState]
    current_player_index: int = 0
    last_roll: int | None = None
    dice_rolled: bool = False
    awaiting_token_choice: bool = False
    winner_user_id: str | None = None
    turn_number: int = 1
    consecutive_sixes: int = 0

    def current(self) -> PlayerState:
        return self.players[self.current_player_index]

    def opponent(self) -> PlayerState:
        return self.players[(self.current_player_index + 1) % len(self.players)]


# ---------------------------------------------------------------------------
# RNG
# ---------------------------------------------------------------------------


def roll_dice() -> int:
    return secrets.randbelow(6) + 1


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _abs_idx(player_color: str, rel_pos: int) -> int | None:
    if rel_pos < 0 or rel_pos > 50:
        return None
    start = ALL_COLORS[player_color].start_index
    return (start + rel_pos) % LOOP_LEN


def _tokens_on(state: LudoState, abs_index: int) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for player in state.players:
        for i, rel in enumerate(player.tokens):
            if rel < 0 or rel > 50:
                continue
            if _abs_idx(player.color, rel) == abs_index:
                out.setdefault(player.user_id, []).append(i)
    return out


def _is_blocked(state: LudoState, mover: PlayerState, new_rel: int) -> bool:
    if new_rel < 0 or new_rel > 50:
        return False
    idx = _abs_idx(mover.color, new_rel)
    if idx is None:
        return False
    occupancy = _tokens_on(state, idx)
    for uid, tokens in occupancy.items():
        if uid == mover.user_id:
            continue
        if len(tokens) >= 2:
            return True
    return False


# ---------------------------------------------------------------------------
# MOVES
# ---------------------------------------------------------------------------


def legal_moves(state: LudoState, roll: int) -> list[int]:
    player = state.current()
    moves: list[int] = []

    for i, rel in enumerate(player.tokens):
        if rel == HOME_POS:
            continue

        if rel == -1:
            if roll == 6 and not _is_blocked(state, player, 0):
                moves.append(i)
            continue

        new_rel = rel + roll
        if new_rel > HOME_POS:
            continue

        if new_rel >= 51:
            moves.append(i)
            continue

        if _is_blocked(state, player, new_rel):
            continue

        moves.append(i)

    return moves


def _capture_opponents(state: LudoState, mover: PlayerState, new_rel: int):
    if new_rel < 0 or new_rel > 50:
        return []
    idx = _abs_idx(mover.color, new_rel)
    if idx in SAFE_INDICES:
        return []

    killed: list[tuple[str, int]] = []
    for opp in state.players:
        if opp.user_id == mover.user_id:
            continue
        for j, rel in enumerate(opp.tokens):
            if rel < 0 or rel > 50:
                continue
            if _abs_idx(opp.color, rel) == idx:
                opp.tokens[j] = -1
                killed.append((opp.user_id, j))
    return killed


@dataclass
class MoveResult:
    ok: bool
    error: str | None = None
    captured: list[tuple[str, int]] = field(default_factory=list)
    entered_home: bool = False
    extra_turn: bool = False
    next_turn_user_id: str | None = None
    winner_user_id: str | None = None


def apply_move(state: LudoState, token_index: int, roll: int) -> MoveResult:
    if not state.awaiting_token_choice:
        return MoveResult(ok=False, error="Not waiting for a token choice")
    if state.last_roll != roll:
        return MoveResult(ok=False, error="Roll mismatch")
    if token_index < 0 or token_index >= TOKENS_PER_PLAYER:
        return MoveResult(ok=False, error="Invalid token index")

    player = state.current()
    rel = player.tokens[token_index]

    if rel == HOME_POS:
        return MoveResult(ok=False, error="Token already home")
    if rel == -1 and roll != 6:
        return MoveResult(ok=False, error="Need 6 to leave base")

    new_rel = 0 if rel == -1 else rel + roll
    if new_rel > HOME_POS:
        return MoveResult(ok=False, error="Overshoot home")

    player.tokens[token_index] = new_rel

    captured = _capture_opponents(state, player, new_rel)
    entered_home = new_rel == HOME_POS
    extra_turn = (roll == 6) or bool(captured)

    state.awaiting_token_choice = False
    state.dice_rolled = False
    state.last_roll = None

    result = MoveResult(
        ok=True, captured=captured,
        entered_home=entered_home, extra_turn=extra_turn,
    )

    if player.has_won:
        state.winner_user_id = player.user_id
        result.winner_user_id = player.user_id
        result.next_turn_user_id = None
        return result

    if extra_turn:
        result.next_turn_user_id = player.user_id
    else:
        state.consecutive_sixes = 0
        state.current_player_index = (state.current_player_index + 1) % len(state.players)
        state.turn_number += 1
        result.next_turn_user_id = state.current().user_id

    return result


def begin_roll(state: LudoState) -> int:
    if state.winner_user_id:
        raise ValueError("Game already finished")
    if state.dice_rolled:
        raise ValueError("Already rolled this turn")

    roll = roll_dice()
    state.last_roll = roll
    state.dice_rolled = True

    if roll == 6:
        state.consecutive_sixes += 1
    else:
        state.consecutive_sixes = 0

    if state.consecutive_sixes >= 3:
        state.dice_rolled = False
        state.last_roll = None
        state.awaiting_token_choice = False
        state.consecutive_sixes = 0
        state.current_player_index = (state.current_player_index + 1) % len(state.players)
        state.turn_number += 1
        return roll

    moves = legal_moves(state, roll)
    if not moves:
        state.dice_rolled = False
        state.last_roll = None
        state.awaiting_token_choice = False
        if roll != 6:
            state.consecutive_sixes = 0
            state.current_player_index = (state.current_player_index + 1) % len(state.players)
            state.turn_number += 1
    else:
        state.awaiting_token_choice = True

    return roll


# ---------------------------------------------------------------------------
# SERIALIZATION
# ---------------------------------------------------------------------------


def state_to_dict(state: LudoState) -> dict:
    return {
        "current_player_index": state.current_player_index,
        "current_user_id": state.current().user_id,
        "last_roll": state.last_roll,
        "dice_rolled": state.dice_rolled,
        "awaiting_token_choice": state.awaiting_token_choice,
        "turn_number": state.turn_number,
        "winner_user_id": state.winner_user_id,
        "consecutive_sixes": state.consecutive_sixes,
        "players": [
            {
                "user_id": p.user_id,
                "color": p.color,
                "tokens": list(p.tokens),
                "finished_count": p.finished_count,
            }
            for p in state.players
        ],
    }


# ---------------------------------------------------------------------------
# CONSTRUCTORS
# ---------------------------------------------------------------------------


def new_two_player_game(user_a: str, user_b: str) -> LudoState:
    colors = TWO_PLAYER_COLORS
    p1 = PlayerState(user_id=user_a, color=colors[0])
    p2 = PlayerState(user_id=user_b, color=colors[1])
    return LudoState(players=[p1, p2])


def new_three_player_game(user_a: str, user_b: str, user_c: str) -> LudoState:
    colors = THREE_PLAYER_COLORS
    p1 = PlayerState(user_id=user_a, color=colors[0])
    p2 = PlayerState(user_id=user_b, color=colors[1])
    p3 = PlayerState(user_id=user_c, color=colors[2])
    return LudoState(players=[p1, p2, p3])


def new_four_player_game(user_a: str, user_b: str, user_c: str, user_d: str) -> LudoState:
    colors = FOUR_PLAYER_COLORS
    p1 = PlayerState(user_id=user_a, color=colors[0])
    p2 = PlayerState(user_id=user_b, color=colors[1])
    p3 = PlayerState(user_id=user_c, color=colors[2])
    p4 = PlayerState(user_id=user_d, color=colors[3])
    return LudoState(players=[p1, p2, p3, p4])


def new_ludo_game(user_ids: list[str]) -> LudoState:
    """Build a ludo game for 2, 3, or 4 players based on count."""
    n = len(user_ids)
    if n == 2:
        return new_two_player_game(user_ids[0], user_ids[1])
    if n == 3:
        return new_three_player_game(user_ids[0], user_ids[1], user_ids[2])
    if n == 4:
        return new_four_player_game(user_ids[0], user_ids[1], user_ids[2], user_ids[3])
    raise ValueError(f"Ludo requires 2-4 players, got {n}")
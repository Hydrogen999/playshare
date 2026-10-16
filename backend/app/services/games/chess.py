"""Chess engine — full rules.

Board: 8x8. Rank 1 at bottom (a1), rank 8 at top (a8).
Pieces: uppercase = White (P N B R Q K), lowercase = Black (p n b r q k), '.' = empty.

Supports:
  - All standard moves
  - Castling (kingside / queenside, with all restrictions)
  - En passant
  - Pawn promotion (Q/R/B/N)
  - Check / checkmate / stalemate detection
  - Fifty-move rule (draw)
  - FEN import/export
"""

from __future__ import annotations

from dataclasses import dataclass, field
from copy import deepcopy
from typing import Optional


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

FILES = "abcdefgh"
RANKS = "12345678"

# Direction vectors (row_delta, col_delta)
KNIGHT_DELTAS = [(-2, -1), (-2, 1), (-1, -2), (-1, 2),
                 (1, -2), (1, 2), (2, -1), (2, 1)]
BISHOP_DIRS = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
ROOK_DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]
QUEEN_DIRS = BISHOP_DIRS + ROOK_DIRS
KING_DIRS = QUEEN_DIRS


# ---------------------------------------------------------------------------
# BOARD
# ---------------------------------------------------------------------------


@dataclass
class Board:
    """8x8 board. board[0] = rank 8 (top), board[7] = rank 1 (bottom)."""
    squares: list[list[str]] = field(default_factory=lambda: [["."] * 8 for _ in range(8)])
    turn: str = "w"                    # "w" or "b"
    castling: str = "KQkq"             # any of KQkq, "-" if none
    en_passant: Optional[tuple[int, int]] = None   # (row, col) of ep target square
    halfmove_clock: int = 0            # for fifty-move rule
    fullmove_number: int = 1


# ---------------------------------------------------------------------------
# FEN
# ---------------------------------------------------------------------------


def from_fen(fen: str) -> Board:
    parts = fen.strip().split()
    if len(parts) < 6:
        raise ValueError("Invalid FEN")

    rows = parts[0].split("/")
    if len(rows) != 8:
        raise ValueError("FEN must have 8 ranks")

    squares: list[list[str]] = []
    for row in rows:
        line: list[str] = []
        for ch in row:
            if ch.isdigit():
                line.extend(["."] * int(ch))
            else:
                line.append(ch)
        if len(line) != 8:
            raise ValueError("FEN row must have 8 files")
        squares.append(line)

    turn = parts[1]
    castling = parts[2]
    ep_str = parts[3]
    halfmove = int(parts[4])
    fullmove = int(parts[5])

    ep: Optional[tuple[int, int]] = None
    if ep_str != "-" and len(ep_str) == 2:
        col = FILES.index(ep_str[0])
        row = 8 - int(ep_str[1])
        ep = (row, col)

    return Board(
        squares=squares,
        turn=turn,
        castling=castling,
        en_passant=ep,
        halfmove_clock=halfmove,
        fullmove_number=fullmove,
    )


def to_fen(b: Board) -> str:
    rows = []
    for r in range(8):
        row_str = ""
        empty = 0
        for c in range(8):
            ch = b.squares[r][c]
            if ch == ".":
                empty += 1
            else:
                if empty:
                    row_str += str(empty)
                    empty = 0
                row_str += ch
        if empty:
            row_str += str(empty)
        rows.append(row_str)

    ep_str = "-"
    if b.en_passant:
        ep_str = FILES[b.en_passant[1]] + str(8 - b.en_passant[0])

    castling = b.castling or "-"

    return f"{'/'.join(rows)} {b.turn} {castling} {ep_str} {b.halfmove_clock} {b.fullmove_number}"


def new_game() -> Board:
    return from_fen(START_FEN)


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _in_bounds(r: int, c: int) -> bool:
    return 0 <= r < 8 and 0 <= c < 8


def _is_white(piece: str) -> bool:
    return piece.isupper() and piece != "."


def _is_black(piece: str) -> bool:
    return piece.islower() and piece != "."


def _same_color(piece: str, color: str) -> bool:
    if piece == ".":
        return False
    if color == "w":
        return _is_white(piece)
    return _is_black(piece)


def _opp_color(piece: str, color: str) -> bool:
    if piece == ".":
        return False
    return not _same_color(piece, color)


def _find_king(b: Board, color: str) -> Optional[tuple[int, int]]:
    target = "K" if color == "w" else "k"
    for r in range(8):
        for c in range(8):
            if b.squares[r][c] == target:
                return (r, c)
    return None


def square_name(r: int, c: int) -> str:
    return FILES[c] + str(8 - r)


# ---------------------------------------------------------------------------
# ATTACK DETECTION
# ---------------------------------------------------------------------------


def is_square_attacked(b: Board, r: int, c: int, by_color: str) -> bool:
    """Is square (r,c) attacked by any piece of `by_color`?"""
    # Pawn attacks
    pawn_dir = -1 if by_color == "w" else 1  # white pawns attack "up" (negative rows)
    pawn = "P" if by_color == "w" else "p"
    for dc in (-1, 1):
        pr, pc = r - pawn_dir, c + dc
        if _in_bounds(pr, pc) and b.squares[pr][pc] == pawn:
            return True

    # Knight attacks
    knight = "N" if by_color == "w" else "n"
    for dr, dc in KNIGHT_DELTAS:
        nr, nc = r + dr, c + dc
        if _in_bounds(nr, nc) and b.squares[nr][nc] == knight:
            return True

    # King attacks
    king = "K" if by_color == "w" else "k"
    for dr, dc in KING_DIRS:
        nr, nc = r + dr, c + dc
        if _in_bounds(nr, nc) and b.squares[nr][nc] == king:
            return True

    # Sliding: rook/queen along rows/cols
    rook = "R" if by_color == "w" else "r"
    queen = "Q" if by_color == "w" else "q"
    for dr, dc in ROOK_DIRS:
        nr, nc = r + dr, c + dc
        while _in_bounds(nr, nc):
            piece = b.squares[nr][nc]
            if piece != ".":
                if piece == rook or piece == queen:
                    return True
                break
            nr += dr
            nc += dc

    # Sliding: bishop/queen along diagonals
    bishop = "B" if by_color == "w" else "b"
    for dr, dc in BISHOP_DIRS:
        nr, nc = r + dr, c + dc
        while _in_bounds(nr, nc):
            piece = b.squares[nr][nc]
            if piece != ".":
                if piece == bishop or piece == queen:
                    return True
                break
            nr += dr
            nc += dc

    return False


def in_check(b: Board, color: str) -> bool:
    king = _find_king(b, color)
    if not king:
        return False
    opp = "b" if color == "w" else "w"
    return is_square_attacked(b, king[0], king[1], opp)


# ---------------------------------------------------------------------------
# MOVE GENERATION (pseudo-legal)
# ---------------------------------------------------------------------------


@dataclass
class Move:
    from_r: int
    from_c: int
    to_r: int
    to_c: int
    piece: str
    captured: str = "."                # piece on target (may be empty, or captured piece)
    promotion: Optional[str] = None    # "Q" / "R" / "B" / "N" (color-lowercased by engine)
    is_castle: Optional[str] = None    # "K" (kingside) or "Q" (queenside)
    is_en_passant: bool = False

    def to_uci(self) -> str:
        s = square_name(self.from_r, self.from_c) + square_name(self.to_r, self.to_c)
        if self.promotion:
            s += self.promotion.lower()
        return s

    def to_san(self, board: Board) -> str:
        """Simple SAN-ish for UI. Not fully standard but readable."""
        if self.is_castle == "K":
            return "O-O"
        if self.is_castle == "Q":
            return "O-O-O"
        piece = self.piece.upper()
        src = square_name(self.from_r, self.from_c)
        dst = square_name(self.to_r, self.to_c)
        if piece == "P":
            if self.captured != "." or self.is_en_passant:
                return f"{FILES[self.from_c]}x{dst}"
            return dst + (f"={self.promotion}" if self.promotion else "")
        cap = "x" if self.captured != "." else ""
        return f"{piece}{cap}{dst}"


def _pawn_moves(b: Board, r: int, c: int, color: str) -> list[Move]:
    moves: list[Move] = []
    direction = -1 if color == "w" else 1
    start_row = 6 if color == "w" else 1
    promo_row = 0 if color == "w" else 7
    piece = b.squares[r][c]

    # Single step forward
    nr, nc = r + direction, c
    if _in_bounds(nr, nc) and b.squares[nr][nc] == ".":
        if nr == promo_row:
            for promo in ("Q", "R", "B", "N"):
                moves.append(Move(r, c, nr, nc, piece, ".", promo))
        else:
            moves.append(Move(r, c, nr, nc, piece, "."))
        # Double step from start row
        if r == start_row:
            nr2 = r + 2 * direction
            if b.squares[nr2][nc] == ".":
                moves.append(Move(r, c, nr2, nc, piece, "."))

    # Captures
    for dc in (-1, 1):
        nr, nc = r + direction, c + dc
        if not _in_bounds(nr, nc):
            continue
        target = b.squares[nr][nc]
        if _opp_color(target, color):
            if nr == promo_row:
                for promo in ("Q", "R", "B", "N"):
                    moves.append(Move(r, c, nr, nc, piece, target, promo))
            else:
                moves.append(Move(r, c, nr, nc, piece, target))
        elif (nr, nc) == b.en_passant and target == ".":
            moves.append(Move(r, c, nr, nc, piece, "p" if color == "w" else "P",
                              is_en_passant=True))

    return moves


def _knight_moves(b: Board, r: int, c: int, color: str) -> list[Move]:
    moves: list[Move] = []
    piece = b.squares[r][c]
    for dr, dc in KNIGHT_DELTAS:
        nr, nc = r + dr, c + dc
        if not _in_bounds(nr, nc):
            continue
        target = b.squares[nr][nc]
        if target == "." or _opp_color(target, color):
            moves.append(Move(r, c, nr, nc, piece, target))
    return moves


def _sliding_moves(b: Board, r: int, c: int, color: str, dirs: list[tuple[int, int]]) -> list[Move]:
    moves: list[Move] = []
    piece = b.squares[r][c]
    for dr, dc in dirs:
        nr, nc = r + dr, c + dc
        while _in_bounds(nr, nc):
            target = b.squares[nr][nc]
            if target == ".":
                moves.append(Move(r, c, nr, nc, piece, "."))
            elif _opp_color(target, color):
                moves.append(Move(r, c, nr, nc, piece, target))
                break
            else:
                break
            nr += dr
            nc += dc
    return moves


def _king_moves(b: Board, r: int, c: int, color: str) -> list[Move]:
    moves: list[Move] = []
    piece = b.squares[r][c]
    for dr, dc in KING_DIRS:
        nr, nc = r + dr, c + dc
        if not _in_bounds(nr, nc):
            continue
        target = b.squares[nr][nc]
        if target == "." or _opp_color(target, color):
            moves.append(Move(r, c, nr, nc, piece, target))

    # Castling — only if not in check
    opp = "b" if color == "w" else "w"
    if is_square_attacked(b, r, c, opp):
        return moves

    home_row = 7 if color == "w" else 0
    if r != home_row or c != 4:
        return moves

    # Kingside
    k_right = "K" if color == "w" else "k"
    if k_right in b.castling:
        # f and g must be empty, king not passing through attacked square
        if (b.squares[home_row][5] == "." and b.squares[home_row][6] == "."
                and not is_square_attacked(b, home_row, 5, opp)
                and not is_square_attacked(b, home_row, 6, opp)):
            # rook must be present
            if b.squares[home_row][7] == ("R" if color == "w" else "r"):
                moves.append(Move(r, c, home_row, 6, piece, ".", is_castle="K"))

    # Queenside
    q_right = "Q" if color == "w" else "q"
    if q_right in b.castling:
        if (b.squares[home_row][3] == "." and b.squares[home_row][2] == "."
                and b.squares[home_row][1] == "."
                and not is_square_attacked(b, home_row, 3, opp)
                and not is_square_attacked(b, home_row, 2, opp)):
            if b.squares[home_row][0] == ("R" if color == "w" else "r"):
                moves.append(Move(r, c, home_row, 2, piece, ".", is_castle="Q"))

    return moves


def pseudo_legal_moves(b: Board, color: Optional[str] = None) -> list[Move]:
    if color is None:
        color = b.turn
    moves: list[Move] = []
    for r in range(8):
        for c in range(8):
            piece = b.squares[r][c]
            if piece == "." or not _same_color(piece, color):
                continue
            kind = piece.upper()
            if kind == "P":
                moves.extend(_pawn_moves(b, r, c, color))
            elif kind == "N":
                moves.extend(_knight_moves(b, r, c, color))
            elif kind == "B":
                moves.extend(_sliding_moves(b, r, c, color, BISHOP_DIRS))
            elif kind == "R":
                moves.extend(_sliding_moves(b, r, c, color, ROOK_DIRS))
            elif kind == "Q":
                moves.extend(_sliding_moves(b, r, c, color, QUEEN_DIRS))
            elif kind == "K":
                moves.extend(_king_moves(b, r, c, color))
    return moves


# ---------------------------------------------------------------------------
# MAKE MOVE
# ---------------------------------------------------------------------------


def _update_castling_rights(b: Board, move: Move) -> None:
    rights = set(b.castling) if b.castling != "-" else set()

    # King moved
    if move.piece == "K":
        rights.discard("K"); rights.discard("Q")
    elif move.piece == "k":
        rights.discard("k"); rights.discard("q")

    # Rook moved from home
    if move.piece == "R":
        if move.from_c == 0 and move.from_r == 7: rights.discard("Q")
        if move.from_c == 7 and move.from_r == 7: rights.discard("K")
    elif move.piece == "r":
        if move.from_c == 0 and move.from_r == 0: rights.discard("q")
        if move.from_c == 7 and move.from_r == 0: rights.discard("k")

    # Rook captured on home square
    if move.to_r == 7 and move.to_c == 0: rights.discard("Q")
    if move.to_r == 7 and move.to_c == 7: rights.discard("K")
    if move.to_r == 0 and move.to_c == 0: rights.discard("q")
    if move.to_r == 0 and move.to_c == 7: rights.discard("k")

    b.castling = "".join(sorted(rights)) if rights else "-"


def make_move(b: Board, move: Move, validate: bool = False) -> Board:
    """Return a new Board with the move applied. Does not mutate input."""
    if validate:
        legal = legal_moves(b)
        if move.to_uci() not in {m.to_uci() for m in legal}:
            raise ValueError(f"Illegal move: {move.to_uci()}")

    nb = deepcopy(b)

    # En passant capture
    if move.is_en_passant:
        cap_row = move.to_r + (1 if nb.turn == "w" else -1)
        nb.squares[cap_row][move.to_c] = "."

    # Move the piece
    nb.squares[move.to_r][move.to_c] = move.piece
    nb.squares[move.from_r][move.from_c] = "."

    # Promotion
    if move.promotion:
        promo = move.promotion if nb.turn == "w" else move.promotion.lower()
        nb.squares[move.to_r][move.to_c] = promo

    # Castling — move the rook too
    if move.is_castle == "K":
        rook = "R" if nb.turn == "w" else "r"
        nb.squares[move.to_r][5] = rook
        nb.squares[move.to_r][7] = "."
    elif move.is_castle == "Q":
        rook = "R" if nb.turn == "w" else "r"
        nb.squares[move.to_r][3] = rook
        nb.squares[move.to_r][0] = "."

    # Update castling rights
    _update_castling_rights(nb, move)

    # Set new en-passant target if pawn double-stepped
    nb.en_passant = None
    if move.piece.upper() == "P" and abs(move.to_r - move.from_r) == 2:
        ep_row = (move.from_r + move.to_r) // 2
        nb.en_passant = (ep_row, move.from_c)

    # Halfmove clock
    if move.piece.upper() == "P" or move.captured != "." or move.is_en_passant:
        nb.halfmove_clock = 0
    else:
        nb.halfmove_clock = b.halfmove_clock + 1

    # Fullmove number: increments after black's move
    if nb.turn == "b":
        nb.fullmove_number = b.fullmove_number + 1

    # Flip turn
    nb.turn = "b" if nb.turn == "w" else "w"

    return nb


# ---------------------------------------------------------------------------
# LEGAL MOVES
# ---------------------------------------------------------------------------


def legal_moves(b: Board, color: Optional[str] = None) -> list[Move]:
    """Pseudo-legal filtered by: king not left in check."""
    if color is None:
        color = b.turn
    out: list[Move] = []
    for m in pseudo_legal_moves(b, color):
        # Apply move to a copy and check own king
        nb = make_move(b, m)
        if not in_check(nb, color):
            out.append(m)
    return out


def moves_for_square(b: Board, r: int, c: int) -> list[Move]:
    """Legal moves from a specific square."""
    piece = b.squares[r][c]
    if piece == "." or not _same_color(piece, b.turn):
        return []
    return [m for m in legal_moves(b) if m.from_r == r and m.from_c == c]


# ---------------------------------------------------------------------------
# GAME STATE
# ---------------------------------------------------------------------------


def result(b: Board) -> Optional[str]:
    """Return None if game ongoing. Otherwise:
    'w' or 'b' for winner (opponent in checkmate), 'draw' for stalemate or 50-move."""
    legal = legal_moves(b)
    checked = in_check(b, b.turn)

    if not legal:
        if checked:
            return "b" if b.turn == "w" else "w"   # opponent wins
        return "draw"                                # stalemate

    if b.halfmove_clock >= 100:
        return "draw"                                # fifty-move rule

    return None


def is_checkmate(b: Board) -> bool:
    return not legal_moves(b) and in_check(b, b.turn)


def is_stalemate(b: Board) -> bool:
    return not legal_moves(b) and not in_check(b, b.turn)


def state_to_dict(b: Board) -> dict:
    """Serializable state for WebSocket."""
    legal = legal_moves(b)
    return {
        "squares": [row[:] for row in b.squares],
        "turn": b.turn,
        "castling": b.castling,
        "en_passant": list(b.en_passant) if b.en_passant else None,
        "halfmove_clock": b.halfmove_clock,
        "fullmove_number": b.fullmove_number,
        "in_check": in_check(b, b.turn),
        "legal_moves": [m.to_uci() for m in legal],
        "result": result(b),
        "fen": to_fen(b),
    }


# ---------------------------------------------------------------------------
# SMOKE TEST
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    b = new_game()
    print("Start FEN:", to_fen(b))
    print("Legal moves from start:", len(legal_moves(b)))  # should be 20
    print("In check:", in_check(b, "w"))                    # False
    print("Result:", result(b))                              # None
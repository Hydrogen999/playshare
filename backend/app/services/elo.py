"""Elo rating system for chess.

Standard Elo (K=32 for first 30 games, K=16 for established players).
Starting rating: 1200 (same as chess.com's default).

Tiers:
  0-999     -> Bronze
  1000-1399 -> Silver
  1400-1799 -> Gold
  1800-2199 -> Diamond
  2200+     -> Grandmaster
"""

START_RATING = 1200
K_PROVISIONAL = 32   # first 30 games
K_ESTABLISHED = 16   # after 30 games
PROVISIONAL_GAMES = 30
MIN_RATING = 100
MAX_RATING = 3500


def _k_for(games: int) -> int:
    return K_PROVISIONAL if games < PROVISIONAL_GAMES else K_ESTABLISHED


def expected_score(rating_a: int, rating_b: int) -> float:
    """Probability that A beats B."""
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))


def new_ratings(
    rating_a: int, rating_b: int, games_a: int, games_b: int, outcome: str
) -> tuple[int, int]:
    """Return new (rating_a, rating_b).

    outcome:
      "a_win"  — A won
      "b_win"  — B won
      "draw"
    """
    if outcome == "a_win":
        score_a = 1.0
    elif outcome == "b_win":
        score_a = 0.0
    else:
        score_a = 0.5

    exp_a = expected_score(rating_a, rating_b)
    exp_b = 1.0 - exp_a

    k_a = _k_for(games_a)
    k_b = _k_for(games_b)

    new_a = round(rating_a + k_a * (score_a - exp_a))
    new_b = round(rating_b + k_b * ((1.0 - score_a) - exp_b))

    new_a = max(MIN_RATING, min(MAX_RATING, new_a))
    new_b = max(MIN_RATING, min(MAX_RATING, new_b))
    return new_a, new_b


def tier_for(rating: int) -> str:
    if rating < 1000:
        return "bronze"
    if rating < 1400:
        return "silver"
    if rating < 1800:
        return "gold"
    if rating < 2200:
        return "diamond"
    return "grandmaster"


TIER_META = {
    "bronze":      {"label": "Bronze",       "icon": "🥉", "color": "#cd7f32", "min": 0},
    "silver":      {"label": "Silver",       "icon": "🥈", "color": "#c0c0c0", "min": 1000},
    "gold":        {"label": "Gold",         "icon": "🥇", "color": "#facc15", "min": 1400},
    "diamond":     {"label": "Diamond",      "icon": "💎", "color": "#60a5fa", "min": 1800},
    "grandmaster": {"label": "Grandmaster",  "icon": "👑", "color": "#a855f7", "min": 2200},
}


def progress_to_next_tier(rating: int) -> dict:
    """Return dict with current tier, next tier, progress 0-1."""
    tier = tier_for(rating)
    order = ["bronze", "silver", "gold", "diamond", "grandmaster"]
    idx = order.index(tier)
    if idx == len(order) - 1:
        return {
            "tier": tier,
            "next_tier": None,
            "next_min": None,
            "progress": 1.0,
            "games_needed": 0,
        }
    next_tier = order[idx + 1]
    current_min = TIER_META[tier]["min"]
    next_min = TIER_META[next_tier]["min"]
    span = next_min - current_min
    progress = (rating - current_min) / span if span > 0 else 0.0
    return {
        "tier": tier,
        "next_tier": next_tier,
        "next_min": next_min,
        "progress": max(0.0, min(1.0, progress)),
        "points_needed": max(0, next_min - rating),
    }


# ---------------------------------------------------------------------------
# BOARD SKINS (unlocked by tier)
# ---------------------------------------------------------------------------

BOARD_SKINS: list[dict] = [
    # Tier-locked (unlock by rating)
    {"id": "board_classic",   "name": "Classic",     "light": "#ead9b8", "dark": "#b58863", "tier": "bronze",      "price": 0},
    {"id": "board_blue",      "name": "Ocean",       "light": "#dbeafe", "dark": "#3b82f6", "tier": "silver",      "price": 0},
    {"id": "board_green",     "name": "Forest",      "light": "#dcfce7", "dark": "#16a34a", "tier": "gold",        "price": 0},
    {"id": "board_purple",    "name": "Royal",       "light": "#ede9fe", "dark": "#7c3aed", "tier": "diamond",     "price": 0},
    {"id": "board_black",     "name": "Void",        "light": "#334155", "dark": "#0f172a", "tier": "grandmaster", "price": 0},
]

SKIN_BY_ID = {s["id"]: s for s in BOARD_SKINS}


def available_skins(rating: int) -> list[dict]:
    """Return all skins with locked/unlocked status for a given rating."""
    my_tier = tier_for(rating)
    order = ["bronze", "silver", "gold", "diamond", "grandmaster"]
    my_idx = order.index(my_tier)
    out = []
    for s in BOARD_SKINS:
        skin_idx = order.index(s["tier"])
        out.append({**s, "unlocked": skin_idx <= my_idx})
    return out
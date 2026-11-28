"""Pure privacy / birthday rules (no database, no web framework)."""

from __future__ import annotations

from datetime import date

MIN_AGE = 13

# key -> (column, allowed values, default)
PRIVACY = {
    "birthday":        ("p_birthday", ("friends", "everyone", "nobody"), "friends"),
    "last_seen":       ("p_last_seen", ("friends", "nobody"), "friends"),
    "online_status":   ("p_online", ("friends", "nobody"), "friends"),
    "who_can_add":     ("p_add", ("everyone", "nobody"), "everyone"),
    "who_can_message": ("p_message", ("everyone", "friends", "nobody"), "everyone"),
    "who_can_call":    ("p_call", ("friends", "nobody"), "friends"),
}


def allowed(setting: str, is_friend: bool) -> bool:
    """May someone with this relationship do the thing? Unknown values fail closed."""
    if setting == "everyone":
        return True
    if setting == "friends":
        return is_friend
    return False


def parse_birthday(month: int, day: int, year: int, today: date | None = None) -> date:
    today = today or date.today()
    try:
        d = date(year, month, day)
    except (ValueError, TypeError):
        raise ValueError("That is not a valid date.") from None
    if year < 1900 or d > today:
        raise ValueError("That is not a valid date.")
    age = today.year - d.year - ((today.month, today.day) < (d.month, d.day))
    if age < MIN_AGE:
        raise ValueError(f"You must be at least {MIN_AGE} years old.")
    return d

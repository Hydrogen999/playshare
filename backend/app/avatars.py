"""Avatar catalog. Kept in code for MVP — no DB table yet."""

AVATARS: list[dict] = [
    {"id": "fox",     "name": "Fox",     "emoji": "🦊", "bg": "#f97316"},
    {"id": "tiger",   "name": "Tiger",   "emoji": "🐯", "bg": "#eab308"},
    {"id": "panda",   "name": "Panda",   "emoji": "🐼", "bg": "#64748b"},
    {"id": "lion",    "name": "Lion",    "emoji": "🦁", "bg": "#d97706"},
    {"id": "frog",    "name": "Frog",    "emoji": "🐸", "bg": "#22c55e"},
    {"id": "octopus", "name": "Octopus", "emoji": "🐙", "bg": "#ec4899"},
    {"id": "unicorn", "name": "Unicorn", "emoji": "🦄", "bg": "#a855f7"},
    {"id": "dragon",  "name": "Dragon",  "emoji": "🐲", "bg": "#ef4444"},
    {"id": "alien",   "name": "Alien",   "emoji": "👾", "bg": "#10b981"},
    {"id": "robot",   "name": "Robot",   "emoji": "🤖", "bg": "#06b6d4"},
    {"id": "ghost",   "name": "Ghost",   "emoji": "👻", "bg": "#94a3b8"},
    {"id": "wolf",    "name": "Wolf",    "emoji": "🐺", "bg": "#475569"},
]

AVATAR_IDS = {a["id"] for a in AVATARS}
DEFAULT_AVATAR_ID = "fox"


def is_valid_avatar(avatar_id: str) -> bool:
    return avatar_id in AVATAR_IDS
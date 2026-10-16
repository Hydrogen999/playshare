"""Cosmetics catalog and shop logic."""

from sqlalchemy.orm import Session

from app.models.cosmetic import UserCosmetic
from app.services.ledger import (
    ESCROW_ACCOUNT, LedgerError, get_balance, post_transaction,
)

CATALOG: list[dict] = [
    {"id": "frame_bronze",  "name": "Bronze Ring",  "category": "frame", "price": 200,   "style": "#cd7f32", "description": "A warm bronze frame"},
    {"id": "frame_silver",  "name": "Silver Ring",  "category": "frame", "price": 400,   "style": "#c0c0c0", "description": "Classic silver frame"},
    {"id": "frame_gold",    "name": "Gold Ring",    "category": "frame", "price": 800,   "style": "#ffd700", "description": "Pure gold frame — flex on them"},
    {"id": "frame_neon",    "name": "Neon Ring",    "category": "frame", "price": 1500,  "style": "#00ff88", "description": "Glowing neon green"},
    {"id": "frame_fire",    "name": "Fire Ring",    "category": "frame", "price": 2500,  "style": "#ff4500", "description": "Burning hot frame"},
    {"id": "frame_galaxy",  "name": "Galaxy Ring",  "category": "frame", "price": 5000,  "style": "#a855f7", "description": "Cosmic purple — legendary"},
    {"id": "frame_void",    "name": "Void Ring",    "category": "frame", "price": 10000, "style": "#111827", "description": "Darkness itself. Endgame flex."},
]

CATALOG_BY_ID = {item["id"]: item for item in CATALOG}
FRAME_STYLE_BY_ID = {
    item["id"]: item["style"] for item in CATALOG if item["category"] == "frame"
}


def get_item(item_id: str) -> dict | None:
    return CATALOG_BY_ID.get(item_id)


def list_catalog() -> list[dict]:
    return CATALOG


def list_owned(db: Session, user_id: str) -> dict:
    rows = db.query(UserCosmetic).filter(UserCosmetic.user_id == user_id).all()
    owned = {r.item_id for r in rows}
    equipped = next((r.item_id for r in rows if r.equipped), None)
    return {"owned": owned, "equipped": equipped}


def buy_item(db: Session, user_id: str, item_id: str) -> dict:
    item = get_item(item_id)
    if not item:
        return {"ok": False, "error": "Item not found"}

    existing = (
        db.query(UserCosmetic)
        .filter(UserCosmetic.user_id == user_id, UserCosmetic.item_id == item_id)
        .first()
    )
    if existing:
        return {"ok": False, "error": "You already own this"}

    price = item["price"]
    if get_balance(db, user_id) < price:
        return {"ok": False, "error": "Not enough PlayCoins"}

    try:
        post_transaction(
            db,
            tx_type="cosmetic_purchase",
            entries=[(user_id, -price), ("treasury", +price)],
            idempotency_key=f"buy_cosmetic:{user_id}:{item_id}",
            notes=f"Bought {item['name']}",
        )
    except LedgerError as e:
        return {"ok": False, "error": str(e)}

    db.add(UserCosmetic(user_id=user_id, item_id=item_id, equipped=False))
    db.commit()
    return {"ok": True, "item": item, "new_balance": get_balance(db, user_id)}


def equip_item(db: Session, user_id: str, item_id: str | None) -> dict:
    rows = db.query(UserCosmetic).filter(UserCosmetic.user_id == user_id).all()
    for r in rows:
        r.equipped = False

    if item_id is None:
        db.commit()
        return {"ok": True, "equipped": None}

    target = next((r for r in rows if r.item_id == item_id), None)
    if not target:
        db.rollback()
        return {"ok": False, "error": "You don't own this item"}

    target.equipped = True
    db.commit()
    return {"ok": True, "equipped": item_id}


def get_equipped(db: Session, user_id: str) -> str | None:
    row = (
        db.query(UserCosmetic)
        .filter(UserCosmetic.user_id == user_id, UserCosmetic.equipped.is_(True))
        .first()
    )
    return row.item_id if row else None


def get_frame_style(db: Session, user_id: str) -> str | None:
    """Return the equipped frame's color hex, or None."""
    item_id = get_equipped(db, user_id)
    if not item_id:
        return None
    return FRAME_STYLE_BY_ID.get(item_id)


def get_frame_styles_bulk(db: Session, user_ids: list[str]) -> dict[str, str | None]:
    """Bulk: {user_id: frame_color or None} for many users at once."""
    if not user_ids:
        return {}
    rows = (
        db.query(UserCosmetic)
        .filter(
            UserCosmetic.user_id.in_(user_ids),
            UserCosmetic.equipped.is_(True),
        )
        .all()
    )
    out = {uid: None for uid in user_ids}
    for r in rows:
        out[r.user_id] = FRAME_STYLE_BY_ID.get(r.item_id)
    return out
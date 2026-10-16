from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.cosmetics import (
    buy_item, equip_item, get_item, list_catalog, list_owned,
)

router = APIRouter(prefix="/api/v1/shop", tags=["shop"])


class BuyIn(BaseModel):
    item_id: str


class EquipIn(BaseModel):
    item_id: str | None = None


@router.get("")
def shop_catalog(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return the full catalog with ownership/equipped status for this user."""
    owned_info = list_owned(db, me.id)
    owned = owned_info["owned"]
    equipped = owned_info["equipped"]

    items = []
    for item in list_catalog():
        items.append({
            **item,
            "owned": item["id"] in owned,
            "equipped": item["id"] == equipped,
        })
    return {"items": items}


@router.get("/inventory")
def shop_inventory(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    owned_info = list_owned(db, me.id)
    owned_items = [
        {**item, "equipped": item["id"] == owned_info["equipped"]}
        for item in list_catalog() if item["id"] in owned_info["owned"]
    ]
    return {"items": owned_items, "equipped": owned_info["equipped"]}


@router.post("/buy")
def shop_buy(
    data: BuyIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = buy_item(db, me.id, data.item_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/equip")
def shop_equip(
    data: EquipIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = equip_item(db, me.id, data.item_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result
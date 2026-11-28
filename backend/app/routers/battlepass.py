from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.battlepass import BattlePassPurchase
from app.models.user import User
from app.services.battlepass import (
    claim_all, claim_tier, initialize_purchase, overview, verify_purchase,
)

router = APIRouter(prefix="/api/v1/battlepass", tags=["battlepass"])


class ClaimIn(BaseModel):
    tier: int
    track: str


@router.get("")
def get_battlepass(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return overview(db, me.id)


@router.post("/claim")
def claim(
    data: ClaimIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    r = claim_tier(db, me.id, data.tier, data.track)
    if not r["ok"]:
        raise HTTPException(status_code=400, detail=r["error"])
    return r


@router.post("/claim-all/{track}")
def claim_all_tiers(
    track: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    r = claim_all(db, me.id, track)
    if not r["ok"]:
        raise HTTPException(status_code=400, detail=r["error"])
    return r


@router.post("/purchase")
async def purchase(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    r = await initialize_purchase(db, me.id, me.email)
    if not r["ok"]:
        raise HTTPException(status_code=400, detail=r["error"])
    return r


@router.get("/verify/{reference}")
async def verify(
    reference: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = (
        db.query(BattlePassPurchase)
        .filter(BattlePassPurchase.reference == reference)
        .first()
    )
    if not row or row.user_id != me.id:
        raise HTTPException(status_code=404, detail="Not found")
    r = await verify_purchase(db, reference)
    if not r["ok"]:
        raise HTTPException(status_code=400, detail=r["error"])
    return 
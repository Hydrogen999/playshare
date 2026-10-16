import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.premium import PremiumSubscription
from app.models.user import User
from app.services.premium import (
    initialize_subscription, list_plans, premium_status, verify_subscription,
)
from app.services.payments import verify_webhook_signature

router = APIRouter(prefix="/api/v1/premium", tags=["premium"])


class SubscribeIn(BaseModel):
    plan_id: str


@router.get("/plans")
def get_plans(me: User = Depends(get_current_user)):
    return {"plans": list_plans()}


@router.get("/status")
def get_status(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return premium_status(db, me.id)


@router.post("/subscribe")
async def subscribe(
    data: SubscribeIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = await initialize_subscription(db, me.id, me.email, data.plan_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/verify/{reference}")
async def verify(
    reference: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = (
        db.query(PremiumSubscription)
        .filter(PremiumSubscription.reference == reference)
        .first()
    )
    if not sub or sub.user_id != me.id:
        raise HTTPException(status_code=404, detail="Not found")

    result = await verify_subscription(db, reference)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result
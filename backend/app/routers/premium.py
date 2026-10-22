import json
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.models.premium import PremiumSubscription
from app.models.user import User
from app.services.premium import (
    get_plan, initialize_subscription, list_plans, premium_status, verify_subscription,
)

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


# --- PAYSTACK (NGN) ---
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


# --- FLUTTERWAVE (USD/Global) ---
@router.post("/subscribe/flw")
async def subscribe_flw(
    data: SubscribeIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = get_plan(data.plan_id)
    if not plan:
        raise HTTPException(status_code=400, detail="Invalid plan")

    if not settings.FLW_SECRET_KEY:
        raise HTTPException(status_code=400, detail="Global payments not configured")

    # Flutterwave prices in USD (Monthly = $5, Yearly = $50)
    usd_price = "5.00" if data.plan_id == "monthly" else "50.00"
    
    reference = f"psm_flw_{uuid.uuid4().hex[:20]}"

    sub = PremiumSubscription(
        user_id=me.id,
        plan=data.plan_id,
        reference=reference,
        amount_kobo=int(float(usd_price) * 100), # Cents
        currency="USD",
        status="pending",
    )
    db.add(sub)
    db.commit()

    callback = settings.FLW_CALLBACK_URL.replace("/buy/flw-callback", "/premium/callback")

    body = {
        "tx_ref": reference,
        "amount": usd_price,
        "currency": "USD",
        "redirect_url": callback,
        "customer": {"email": me.email, "name": me.username},
        "customizations": {"title": "PlaySphere Premium", "description": plan["label"]},
        "meta": {"user_id": me.id, "plan_id": data.plan_id, "type": "premium"},
    }
    headers = {
        "Authorization": f"Bearer {settings.FLW_SECRET_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"{settings.FLW_BASE_URL}/payments",
                json=body,
                headers=headers,
            )
            res_data = r.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Flutterwave error: {e}")

    if res_data.get("status") != "success":
        raise HTTPException(status_code=400, detail=res_data.get("message", "Init failed"))

    return {
        "ok": True,
        "reference": reference,
        "authorization_url": res_data["data"]["link"],
    }

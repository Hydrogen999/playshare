from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_admin
from app.models.user import User
from app.services.ads import claim_rewarded, config_for_user, update_settings

router = APIRouter(prefix="/api/v1/ads", tags=["ads"])


class UpdateIn(BaseModel):
    enabled: bool | None = None
    banner_code: str | None = None
    rewarded_code: str | None = None
    rewarded_coins: int | None = None
    rewarded_daily_limit: int | None = None


@router.get("/config")
def config(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return config_for_user(db, me.id)


@router.post("/rewarded/claim")
def rewarded_claim(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return claim_rewarded(db, me.id)


@router.post("/admin/update")
def admin_update(
    data: UpdateIn,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    s = update_settings(
        db,
        enabled=data.enabled,
        banner_code=data.banner_code,
        rewarded_code=data.rewarded_code,
        rewarded_coins=data.rewarded_coins,
        rewarded_daily_limit=data.rewarded_daily_limit,
    )
    return {"enabled": s.enabled, "rewarded_coins": s.rewarded_coins}
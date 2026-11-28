from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.xp import progress_to_next

router = APIRouter(prefix="/api/v1/me", tags=["xp"])


class XPOut(BaseModel):
    xp_total: int
    level: int
    xp_in_level: int
    xp_needed: int
    xp_next_level: int
    percent: float


@router.get("/xp", response_model=XPOut)
def my_xp(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = me.profile
    info = progress_to_next(p.xp)
    return XPOut(
        xp_total=info["xp_total"],
        level=info["level"],
        xp_in_level=info["xp_in_level"],
        xp_needed=info["xp_needed"],
        xp_next_level=info["xp_next_level"],
        percent=info["percent"],
    )
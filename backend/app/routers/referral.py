from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.referral import stats_for

router = APIRouter(prefix="/api/v1/referral", tags=["referral"])


@router.get("/me")
def my_referral(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return stats_for(db, me.id)
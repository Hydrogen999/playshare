from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.elo import (
    BOARD_SKINS, TIER_META, available_skins,
    progress_to_next_tier, tier_for,
)

router = APIRouter(prefix="/api/v1/chess", tags=["chess"])


@router.get("/tier")
def my_tier(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = me.profile
    rating = getattr(p, "elo_rating", 1200) or 1200
    return {
        "rating": rating,
        "tier": tier_for(rating),
        "tier_meta": TIER_META,
        "progress": progress_to_next_tier(rating),
        "games_played": getattr(p, "chess_games_played", 0) or 0,
        "wins": getattr(p, "chess_wins", 0) or 0,
        "losses": getattr(p, "chess_losses", 0) or 0,
        "draws": getattr(p, "chess_draws", 0) or 0,
        "skins": available_skins(rating),
    }


@router.get("/skins")
def my_skins(
    me: User = Depends(get_current_user),
):
    rating = getattr(me.profile, "elo_rating", 1200) or 1200
    return {"skins": available_skins(rating)}
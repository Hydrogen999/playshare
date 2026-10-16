from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.match import Match
from app.models.user import User

router = APIRouter(prefix="/api/v1/me", tags=["stats"])


class RecentMatchOut(BaseModel):
    id: str
    game_slug: str
    result: str
    opponent_username: str
    opponent_avatar_id: str
    wager: int
    ended_at: str | None


class StatsOut(BaseModel):
    wins: int
    losses: int
    draws: int
    games_played: int
    win_rate: float
    recent_matches: list[RecentMatchOut]


@router.get("/stats", response_model=StatsOut)
def my_stats(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    matches = (
        db.query(Match)
        .filter(
            or_(Match.player_a == me.id, Match.player_b == me.id),
            Match.status == "finished",
        )
        .order_by(Match.finished_at.desc().nullslast())
        .limit(100)
        .all()
    )

    wins = losses = draws = 0
    recent: list[RecentMatchOut] = []

    for m in matches[:20]:
        opponent_id = m.player_b if m.player_a == me.id else m.player_a
        opponent = db.get(User, opponent_id)
        opp_username = opponent.username if opponent else "unknown"
        opp_avatar = opponent.profile.avatar_id if opponent and opponent.profile else "fox"

        if m.winner_id is None:
            outcome = "draw"
            draws += 1
        elif m.winner_id == me.id:
            outcome = "win"
            wins += 1
        else:
            outcome = "loss"
            losses += 1

        recent.append(
            RecentMatchOut(
                id=m.id,
                game_slug=m.game_slug,
                result=outcome,
                opponent_username=opp_username,
                opponent_avatar_id=opp_avatar,
                wager=m.wager,
                ended_at=m.finished_at.isoformat() if m.finished_at else None,
            )
        )

    for m in matches[20:]:
        if m.winner_id is None:
            draws += 1
        elif m.winner_id == me.id:
            wins += 1
        else:
            losses += 1

    games_played = wins + losses + draws
    win_rate = (wins / games_played) if games_played > 0 else 0.0

    return StatsOut(
        wins=wins,
        losses=losses,
        draws=draws,
        games_played=games_played,
        win_rate=round(win_rate, 3),
        recent_matches=recent,
    )
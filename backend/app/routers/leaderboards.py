from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.match import Match
from app.models.social import Friendship
from app.models.user import Profile, User
from app.services.cosmetics import get_frame_styles_bulk
from app.services.premium import premium_bulk

router = APIRouter(prefix="/api/v1/leaderboards", tags=["leaderboards"])

CATEGORIES = {"xp", "tokens", "wins", "win_rate", "chess"}


class Entry(BaseModel):
    rank: int
    user_id: str
    username: str
    avatar_id: str
    level: int
    frame_color: str | None = None
    is_premium: bool = False
    value: float
    value_label: str


class MeRank(BaseModel):
    rank: int | None
    value: float
    value_label: str
    total_players: int
    in_top: bool


class Out(BaseModel):
    category: str
    scope: str
    entries: list[Entry]
    me: MeRank


def _friend_ids(db: Session, me_id: str) -> set[str]:
    rows = db.query(Friendship).filter(
        Friendship.status == "accepted",
        or_(Friendship.requester_id == me_id, Friendship.addressee_id == me_id),
    ).all()
    ids: set[str] = set()
    for r in rows:
        ids.add(r.addressee_id if r.requester_id == me_id else r.requester_id)
    return ids


def _label(category: str, value: float) -> str:
    if category == "xp":
        return f"{int(value)} XP"
    if category == "tokens":
        return f"{int(value)} PC"
    if category == "wins":
        return f"{int(value)} wins"
    if category == "win_rate":
        return f"{round(value, 1)}%"
    if category == "chess":
        return f"{int(value)} Elo"
    return str(value)


def _compute_rows(db: Session, category: str, allowed_ids: list[str] | None = None):
    if category == "xp":
        q = db.query(Profile.user_id, Profile.xp).join(
            User, User.id == Profile.user_id
        ).filter(User.is_banned.is_(False))
        if allowed_ids is not None:
            q = q.filter(Profile.user_id.in_(allowed_ids))
        rows = q.all()
        data = [{"user_id": r[0], "value": float(r[1] or 0)} for r in rows]

    elif category == "tokens":
        q = db.query(Profile.user_id, Profile.tokens_cached).join(
            User, User.id == Profile.user_id
        ).filter(User.is_banned.is_(False))
        if allowed_ids is not None:
            q = q.filter(Profile.user_id.in_(allowed_ids))
        rows = q.all()
        data = [{"user_id": r[0], "value": float(r[1] or 0)} for r in rows]

    elif category == "wins":
        counts = dict(
            db.query(Match.winner_id, func.count(Match.id))
            .filter(Match.status == "finished", Match.winner_id.isnot(None))
            .group_by(Match.winner_id)
            .all()
        )
        q = db.query(Profile.user_id).join(
            User, User.id == Profile.user_id
        ).filter(User.is_banned.is_(False))
        if allowed_ids is not None:
            q = q.filter(Profile.user_id.in_(allowed_ids))
        rows = q.all()
        data = [{"user_id": r[0], "value": float(counts.get(r[0], 0))} for r in rows]

    elif category == "chess":
        q = db.query(
            Profile.user_id, Profile.elo_rating, Profile.chess_games_played
        ).join(
            User, User.id == Profile.user_id
        ).filter(User.is_banned.is_(False))
        if allowed_ids is not None:
            q = q.filter(Profile.user_id.in_(allowed_ids))
        rows = q.all()
        data = []
        for uid, rating, games in rows:
            if (games or 0) < 3:
                continue
            data.append({"user_id": uid, "value": float(rating or 1200)})

    elif category == "win_rate":
        wins = dict(
            db.query(Match.winner_id, func.count(Match.id))
            .filter(Match.status == "finished", Match.winner_id.isnot(None))
            .group_by(Match.winner_id)
            .all()
        )
        a_rows = (
            db.query(Match.player_a, func.count(Match.id))
            .filter(Match.status == "finished")
            .group_by(Match.player_a)
            .all()
        )
        b_rows = (
            db.query(Match.player_b, func.count(Match.id))
            .filter(Match.status == "finished")
            .group_by(Match.player_b)
            .all()
        )
        totals: dict[str, int] = {}
        for uid, c in a_rows:
            totals[uid] = totals.get(uid, 0) + c
        for uid, c in b_rows:
            totals[uid] = totals.get(uid, 0) + c

        data = []
        for uid, total in totals.items():
            if total < 3:
                continue
            if allowed_ids is not None and uid not in allowed_ids:
                continue
            w = wins.get(uid, 0)
            rate = (w / total) * 100.0
            data.append({"user_id": uid, "value": rate})

    else:
        data = []

    data.sort(key=lambda x: -x["value"])
    return data


@router.get("/{category}", response_model=Out)
def get_leaderboard(
    category: str,
    scope: str = Query("global"),
    limit: int = Query(50, le=200),
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if category not in CATEGORIES:
        category = "xp"
    if scope not in ("global", "friends"):
        scope = "global"

    allowed_ids = None
    if scope == "friends":
        ids = _friend_ids(db, me.id)
        ids.add(me.id)
        allowed_ids = list(ids)

    all_rows = _compute_rows(db, category, allowed_ids)

    my_rank = None
    my_value = 0.0
    for i, r in enumerate(all_rows):
        if r["user_id"] == me.id:
            my_rank = i + 1
            my_value = r["value"]
            break
    total = len(all_rows)

    top = all_rows[:limit]
    top_ids = [r["user_id"] for r in top]

    users = {}
    if top_ids:
        users = {u.id: u for u in db.query(User).filter(User.id.in_(top_ids)).all()}
    frames = get_frame_styles_bulk(db, top_ids)
    premiums = premium_bulk(db, top_ids)

    entries: list[Entry] = []
    for i, r in enumerate(top):
        u = users.get(r["user_id"])
        if not u:
            continue
        entries.append(Entry(
            rank=i + 1,
            user_id=u.id,
            username=u.username,
            avatar_id=u.profile.avatar_id if u.profile else "fox",
            level=u.profile.level if u.profile else 1,
            frame_color=frames.get(u.id),
            is_premium=premiums.get(u.id, False),
            value=r["value"],
            value_label=_label(category, r["value"]),
        ))

    return Out(
        category=category,
        scope=scope,
        entries=entries,
        me=MeRank(
            rank=my_rank,
            value=my_value,
            value_label=_label(category, my_value),
            total_players=total,
            in_top=(my_rank is not None and my_rank <= limit),
        ),
    )
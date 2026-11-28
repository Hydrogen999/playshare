from pydantic import BaseModel


class RoomMemberOut(BaseModel):
    user_id: str
    username: str
    avatar_id: str
    level: int
    ready: bool


class RoomOut(BaseModel):
    id: str
    game_slug: str
    status: str
    wager: int
    members: list[RoomMemberOut]
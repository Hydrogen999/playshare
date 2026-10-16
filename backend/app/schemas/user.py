from pydantic import BaseModel, Field


class ProfileOut(BaseModel):
    avatar_id: str
    level: int
    xp: int
    tokens: int
    bio: str
    country: str
    frame_color: str | None = None
    is_premium: bool = False
    premium_expires_at: str | None = None
    elo_rating: int = 1200
    chess_games_played: int = 0
    chess_wins: int = 0
    chess_losses: int = 0
    chess_draws: int = 0
    chess_tier: str = "bronze"


class PublicProfileOut(BaseModel):
    avatar_id: str
    level: int
    xp: int
    bio: str
    country: str
    frame_color: str | None = None
    is_premium: bool = False
    elo_rating: int = 1200
    chess_tier: str = "bronze"


class ProfileUpdateIn(BaseModel):
    avatar_id: str | None = Field(default=None, max_length=32)
    bio: str | None = Field(default=None, max_length=280)
    country: str | None = Field(default=None, max_length=2)


class MeOut(BaseModel):
    id: str
    email: str
    username: str
    role: str
    profile: ProfileOut


class PublicUserOut(BaseModel):
    id: str
    username: str
    role: str
    profile: PublicProfileOut
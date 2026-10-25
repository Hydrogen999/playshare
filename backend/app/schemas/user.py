from pydantic import BaseModel


class ProfileOut(BaseModel):
    avatar_id: str
    level: int
    xp: int
    tokens: int
    bio: str
    country: str
    chat_retention_days: int = 1
    is_premium: bool = False
    frame_color: str | None = None
    premium_expires_at: str | None = None


class ProfileUpdateIn(BaseModel):
    avatar_id: str | None = None
    bio: str | None = None
    country: str | None = None
    chat_retention_days: int | None = None


class MeOut(BaseModel):
    id: str
    email: str
    username: str
    role: str
    profile: ProfileOut


class PublicProfileOut(BaseModel):
    avatar_id: str
    level: int
    xp: int
    bio: str
    country: str
    is_premium: bool = False


class PublicUserOut(BaseModel):
    id: str
    username: str
    role: str
    profile: PublicProfileOut

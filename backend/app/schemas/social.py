from pydantic import BaseModel, Field


class UserSearchOut(BaseModel):
    id: str
    username: str
    avatar_id: str
    level: int
    relationship: str
    frame_color: str | None = None
    is_premium: bool = False


class FriendOut(BaseModel):
    id: str
    username: str
    avatar_id: str
    level: int
    online: bool
    frame_color: str | None = None
    is_premium: bool = False


class FriendRequestOut(BaseModel):
    request_id: str
    user_id: str
    username: str
    avatar_id: str
    level: int
    created_at: str
    frame_color: str | None = None
    is_premium: bool = False


class DMOut(BaseModel):
    id: str
    sender_id: str
    recipient_id: str
    content: str
    read: bool
    created_at: str


class SendDMIn(BaseModel):
    content: str = Field(min_length=1, max_length=1000)


class ConversationOut(BaseModel):
    user_id: str
    username: str
    avatar_id: str
    last_message: str
    last_at: str
    unread_count: int
    frame_color: str | None = None
    is_premium: bool = False


class NotificationOut(BaseModel):
    id: str
    type: str
    payload: dict
    read: bool
    created_at: str
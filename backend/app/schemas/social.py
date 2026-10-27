from pydantic import BaseModel


class FriendOut(BaseModel):
    id: str
    username: str
    avatar_id: str
    level: int
    online: bool
    frame_color: str | None = None
    is_premium: bool = False
    streak_count: int = 0


class FriendRequestOut(BaseModel):
    request_id: str
    user_id: str
    username: str
    avatar_id: str
    level: int
    created_at: str
    frame_color: str | None = None
    is_premium: bool = False


class ConversationOut(BaseModel):
    user_id: str
    username: str
    avatar_id: str
    last_message: str
    last_at: str
    unread_count: int
    frame_color: str | None = None
    is_premium: bool = False
    streak: int = 0


class DMOut(BaseModel):
    id: str
    sender_id: str
    recipient_id: str
    content: str
    read: bool
    created_at: str


class SendDMIn(BaseModel):
    content: str


class NotificationOut(BaseModel):
    id: str
    type: str
    payload: str
    read: bool
    created_at: str


# --- THIS IS WHAT WAS MISSING ---
class UserSearchOut(BaseModel):
    id: str
    username: str
    avatar_id: str
    level: int
    relationship: str
    frame_color: str | None = None
    is_premium: bool = False

class DMOut(BaseModel):
    id: str
    sender_id: str
    recipient_id: str
    content: str
    media_url: str | None = None
    reply_to_id: str | None = None # <-- MUST BE HERE
    read: bool
    created_at: str

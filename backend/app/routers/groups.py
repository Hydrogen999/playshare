from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List
import uuid
from datetime import datetime

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.social import ChatGroup, ChatGroupMember, DirectMessage
from app.services.safety import blocked_ids, is_friend
from app.ws.dm import dm_hub  # <-- Import the hub to send live updates!

router = APIRouter(prefix="/api/v1/groups", tags=["groups"])

class GroupCreateIn(BaseModel):
    name: str
    member_ids: List[str]

@router.post("")
async def create_group(data: GroupCreateIn, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    name = data.name.strip()
    if len(name) < 3 or len(name) > 64:
        raise HTTPException(400, "Group name must be 3-64 characters")
    # Only people you are friends with (and who have not blocked you) can be added.
    hidden = blocked_ids(db, me.id)
    member_ids = []
    for uid in dict.fromkeys(data.member_ids):
        if uid == me.id or uid in hidden:
            continue
        if not is_friend(db, me.id, uid):
            raise HTTPException(403, "You can only add your friends to a group")
        member_ids.append(uid)
    if len(member_ids) > 49:
        raise HTTPException(400, "A group can have up to 50 members")
    data.name, data.member_ids = name, member_ids
    
    # 1. Create the group
    group = ChatGroup(id=str(uuid.uuid4()), name=data.name, creator_id=me.id)
    db.add(group)
    db.add(ChatGroupMember(group_id=group.id, user_id=me.id))
    
    for uid in data.member_ids:
        if uid != me.id:
            db.add(ChatGroupMember(group_id=group.id, user_id=uid))
            
    db.flush() # Flush to get the group ID before committing

    # 2. Create a system message so the chat isn't empty
    sys_msg = DirectMessage(
        group_id=group.id,
        sender_id=me.id,
        content=f"{me.username} created the group and added you."
    )
    db.add(sys_msg)
    db.commit()

    # 3. NOTIFY EVERYONE VIA WEBSOCKET
    # This tells the frontend "Update your Groups list immediately!"
    notify_payload = {
        "type": "group:created",
        "group": {
            "id": group.id,
            "name": group.name,
            "member_count": len(data.member_ids) + 1,
            "creator_id": me.id
        }
    }
    
    # Send to me + all members
    all_members = [me.id] + data.member_ids
    for uid in all_members:
        await dm_hub.send_to_user(uid, notify_payload)

    return {"id": group.id, "name": group.name}

@router.get("")
def list_groups(me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    memberships = db.query(ChatGroupMember).filter(ChatGroupMember.user_id == me.id).all()
    group_ids = [m.group_id for m in memberships]
    
    groups = db.query(ChatGroup).filter(ChatGroup.id.in_(group_ids)).all()
    
    out = []
    for g in groups:
        count = db.query(ChatGroupMember).filter(ChatGroupMember.group_id == g.id).count()
        out.append({
            "id": g.id,
            "name": g.name,
            "member_count": count,
            "creator_id": g.creator_id
        })
    return out

@router.get("/{group_id}/messages")
def get_group_messages(group_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    member = db.query(ChatGroupMember).filter(
        ChatGroupMember.group_id == group_id,
        ChatGroupMember.user_id == me.id
    ).first()
    if not member:
        raise HTTPException(403, "You are not a member of this group")

    messages = db.query(DirectMessage).filter(
        DirectMessage.group_id == group_id
    ).order_by(DirectMessage.created_at.asc()).limit(100).all()

    out = []
    for m in messages:
        sender = db.get(User, m.sender_id)
        out.append({
            "id": m.id,
            "sender_id": m.sender_id,
            "sender_username": sender.username if sender else "Unknown",
            "content": m.content,
            "media_url": m.media_url,
            "created_at": m.created_at.isoformat()
        })
    return out

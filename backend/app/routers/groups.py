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

router = APIRouter(prefix="/api/v1/groups", tags=["groups"])

class GroupCreateIn(BaseModel):
    name: str
    member_ids: List[str]

@router.post("")
def create_group(data: GroupCreateIn, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if len(data.name) < 3:
        raise HTTPException(400, "Group name too short")
    
    group = ChatGroup(id=str(uuid.uuid4()), name=data.name, creator_id=me.id)
    db.add(group)
    
    # Add creator
    db.add(ChatGroupMember(group_id=group.id, user_id=me.id))
    
    # Add members
    for uid in data.member_ids:
        if uid != me.id:
            db.add(ChatGroupMember(group_id=group.id, user_id=uid))
            
    db.commit()
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

# --- THIS IS THE MISSING ENDPOINT ---
@router.get("/{group_id}/messages")
def get_group_messages(group_id: str, me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # 1. Check if user is a member of this group
    member = db.query(ChatGroupMember).filter(
        ChatGroupMember.group_id == group_id,
        ChatGroupMember.user_id == me.id
    ).first()
    if not member:
        raise HTTPException(403, "You are not a member of this group")

    # 2. Fetch messages
    messages = db.query(DirectMessage).filter(
        DirectMessage.group_id == group_id
    ).order_by(DirectMessage.created_at.asc()).limit(100).all()

    # 3. Format output
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

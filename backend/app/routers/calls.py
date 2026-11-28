from fastapi import APIRouter, Depends

from app.deps import get_current_user
from app.models.user import User
from app.services.ice import build_ice_servers

router = APIRouter(prefix="/api/v1/calls", tags=["calls"])


@router.get("/ice")
def ice_servers(me: User = Depends(get_current_user)):
    """STUN/TURN servers for a call. TURN credentials are created per user and expire."""
    return {"ice_servers": build_ice_servers(me.id)}

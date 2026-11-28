from fastapi import APIRouter

from app.avatars import AVATARS

router = APIRouter(prefix="/api/v1/avatars", tags=["avatars"])


@router.get("")
def list_avatars():
    return {"avatars": AVATARS}
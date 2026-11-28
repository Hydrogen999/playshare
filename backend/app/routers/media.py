from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.safety import MediaFile
from app.models.user import User
from app.services.media import MAX_ANY, BadMedia, parse_range, save_media

router = APIRouter(tags=["media"])

_SAFE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes",
}


@router.get("/media/{name}")
def get_media(name: str, request: Request, db: Session = Depends(get_db)):
    mid = name.split(".")[0]
    if len(mid) != 32 or not all(c in "0123456789abcdef" for c in mid):
        raise HTTPException(404, "Not found")
    row = db.get(MediaFile, mid)
    if not row:
        raise HTTPException(404, "Not found")
    data, size = row.data, row.size
    rng = parse_range(request.headers.get("range"), size)
    if rng:   # video/audio players need partial content (esp. on iPhone)
        a, b = rng
        return Response(content=data[a:b + 1], status_code=206, media_type=row.mime,
                        headers={**_SAFE_HEADERS, "Content-Range": f"bytes {a}-{b}/{size}"})
    return Response(content=data, media_type=row.mime, headers=_SAFE_HEADERS)


@router.post("/api/v1/media")
async def upload_media(file: UploadFile = File(...), me: User = Depends(get_current_user), db: Session = Depends(get_db)):
    data = await file.read(MAX_ANY + 1)
    try:
        url = save_media(db, me.id, data, file.filename or "")
    except BadMedia as e:
        raise HTTPException(400, str(e))
    db.commit()
    return {"url": url}

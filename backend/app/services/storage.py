import hashlib
import os
import re
import shutil
import time
import uuid

import httpx
from fastapi import HTTPException, UploadFile

from app.config import settings

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
UPLOAD_DIR = os.path.join(BASE_DIR, "frontend", "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def cloud_enabled() -> bool:
    return bool(
        settings.CLOUDINARY_CLOUD_NAME and settings.CLOUDINARY_API_KEY and settings.CLOUDINARY_API_SECRET
    )


def save_upload(
    file: UploadFile,
    allowed: tuple = ("image/", "audio/", "video/"),
    max_mb: int = 60,
) -> str:
    """Save an uploaded file and return its public URL.

    Uses Cloudinary when configured (files are kept forever), otherwise the
    server disk (files are lost whenever Render restarts).
    """
    ctype = file.content_type or ""
    if not ctype.startswith(allowed):
        raise HTTPException(status_code=400, detail="Invalid file type")

    data = file.file.read(max_mb * 1024 * 1024 + 1)
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File is too large (max {max_mb} MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    if cloud_enabled():
        ts = str(int(time.time()))
        sig = hashlib.sha1(f"timestamp={ts}{settings.CLOUDINARY_API_SECRET}".encode()).hexdigest()
        try:
            r = httpx.post(
                f"https://api.cloudinary.com/v1_1/{settings.CLOUDINARY_CLOUD_NAME}/auto/upload",
                data={"api_key": settings.CLOUDINARY_API_KEY, "timestamp": ts, "signature": sig},
                files={"file": (file.filename or "upload", data, ctype)},
                timeout=120,
            )
        except Exception as e:  # noqa: BLE001
            print(f"[UPLOAD ERROR] cloudinary: {e}")
            raise HTTPException(status_code=502, detail="Could not upload right now") from e
        if r.status_code != 200:
            print(f"[UPLOAD ERROR] cloudinary {r.status_code}: {r.text[:200]}")
            raise HTTPException(status_code=502, detail="Could not upload right now")
        return r.json()["secure_url"]

    ext = (file.filename or "bin").rsplit(".", 1)[-1] if "." in (file.filename or "") else "bin"
    ext = re.sub(r"[^A-Za-z0-9]", "", ext)[:8] or "bin"
    name = f"{uuid.uuid4().hex}.{ext}"
    try:
        with open(os.path.join(UPLOAD_DIR, name), "wb") as out:
            out.write(data)
    except Exception as e:  # noqa: BLE001
        print(f"[UPLOAD ERROR] {e}")
        raise HTTPException(status_code=500, detail="Could not save file") from e
    return f"/static/uploads/{name}"

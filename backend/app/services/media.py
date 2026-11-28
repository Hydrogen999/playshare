"""Safe upload storage.

* The real file type is detected from the file's bytes. The filename and the
  content type sent by the client are never trusted, so an HTML/SVG/script
  file can never be stored and then served from your domain.
* Files live in the database (table media_files), so they survive restarts.
* Served from /media/<id>.<ext> with nosniff + a locked-down CSP.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

MAX_IMAGE = 8 * 1024 * 1024
MAX_AUDIO = 12 * 1024 * 1024
MAX_VIDEO = 30 * 1024 * 1024
MAX_ANY = MAX_VIDEO
UPLOADS_PER_DAY = 150

_MP4_VIDEO_BRANDS = (b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"qt  ", b"3gp4", b"3gp5", b"3gp6", b"3g2a", b"dash", b"M4V ")


class BadMedia(Exception):
    pass


def sniff_media(data: bytes, filename: str = "") -> tuple[str, str, str]:
    """Return (mime, ext, kind) where kind is image|audio|video.
    Raises BadMedia for anything that is not a known safe type."""
    if not data or len(data) < 12:
        raise BadMedia("The file is empty or damaged.")
    hint = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    head = data[:16]

    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg", "image"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", "png", "image"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif", "image"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp", "webp", "image"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav", "wav", "audio"
    if head[:4] == b"OggS":
        return "audio/ogg", "ogg", "audio"
    if head[:5] == b"#!AMR":
        return "audio/amr", "amr", "audio"
    if head[:3] == b"ID3":
        return "audio/mpeg", "mp3", "audio"
    if head[0] == 0xFF and (head[1] & 0xF6) == 0xF0:
        return "audio/aac", "aac", "audio"
    if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and ((head[1] >> 1) & 3) != 0:
        return "audio/mpeg", "mp3", "audio"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm", "webm", "video"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        # An mp4-family container is audio when it says so (M4A brand) or when
        # the app named it .m4a/.aac (voice notes); otherwise it is video.
        if brand in (b"M4A ", b"M4B ") or hint in ("m4a", "aac"):
            return "audio/mp4", "m4a", "audio"
        if brand == b"qt  ":
            return "video/quicktime", "mov", "video"
        return "video/mp4", "mp4", "video"
    raise BadMedia("Unsupported file type. Use a photo, voice note or video.")


def _limit_for(kind: str) -> int:
    return {"image": MAX_IMAGE, "audio": MAX_AUDIO, "video": MAX_VIDEO}[kind]


def save_media(db: Session, owner_id: str, data: bytes, filename: str = "", *, only: tuple[str, ...] | None = None) -> str:
    """Validate and store a file. Returns its URL path (e.g. /media/ab12...jpg).
    `only` restricts the allowed kinds (e.g. ("image",) for profile photos)."""
    from app.models.safety import MediaFile  # local import keeps the module testable

    if len(data) > MAX_ANY:
        raise BadMedia("The file is too large.")
    mime, ext, kind = sniff_media(data, filename)
    if only and kind not in only:
        raise BadMedia("That file type is not allowed here.")
    if len(data) > _limit_for(kind):
        raise BadMedia(f"The {kind} is too large.")

    since = datetime.now(timezone.utc) - timedelta(days=1)
    n = db.query(MediaFile).filter(MediaFile.owner_id == owner_id, MediaFile.created_at >= since).count()
    if n >= UPLOADS_PER_DAY:
        raise BadMedia("Daily upload limit reached. Try again tomorrow.")

    mid = secrets.token_hex(16)
    db.add(MediaFile(id=mid, owner_id=owner_id, mime=mime, ext=ext, size=len(data), data=data))
    db.flush()
    return f"/media/{mid}.{ext}"


def is_own_media_url(url: str | None) -> bool:
    """Chat messages may only point at files we stored (or legacy uploads)."""
    if not isinstance(url, str) or len(url) > 120:
        return False
    return url.startswith("/media/") or url.startswith("/static/uploads/")


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Parse 'bytes=a-b' into an inclusive (start, end) or None when absent/invalid."""
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    a, _, b = header[6:].partition("-")
    try:
        if a == "":                      # suffix: last N bytes
            n = int(b)
            if n <= 0:
                return None
            start, end = max(size - n, 0), size - 1
        else:
            start = int(a)
            end = int(b) if b else size - 1
    except ValueError:
        return None
    end = min(end, size - 1)
    if start < 0 or start > end:
        return None
    return start, end

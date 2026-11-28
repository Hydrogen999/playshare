"""Tiny in-memory rate limiter (one server instance). Protects login, signup
and code endpoints from brute force."""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits: dict[str, deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")) or "?"


def hit(key: str, limit: int, window_sec: int) -> bool:
    """Record an attempt. Returns False when the limit is exceeded."""
    now = time.monotonic()
    q = _hits[key]
    while q and now - q[0] > window_sec:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    if len(_hits) > 20000:           # keep memory bounded
        for k in list(_hits)[:5000]:
            if not _hits[k]:
                del _hits[k]
    return True


def guard(request: Request, name: str, limit: int, window_sec: int, extra: str = "") -> None:
    if not hit(f"{name}:{client_ip(request)}:{extra}", limit, window_sec):
        raise HTTPException(status_code=429, detail="Too many attempts. Please wait a few minutes and try again.")

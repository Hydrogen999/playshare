from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import models  # noqa: F401
from app.config import settings
from app.database import Base, SessionLocal, engine
from app.routers import (
    achievements, ads, auth, avatars, battlepass, chess, daily, dm,
    friends, leaderboards, matches, me, notifications, payments,
    premium, push, referral, rooms, shop, stats, tokens, tournaments,
    users, xp,
)
from app.services.ledger import bootstrap_ledger
from app.ws import lobby as ws_lobby
from app.ws import room as ws_room
from app.ws import dm as ws_dm  # <-- Imported correctly here

Base.metadata.create_all(bind=engine)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = SessionLocal()
    try:
        bootstrap_ledger(db)
        if settings.admin_usernames:
            from app.models.user import User as _User
            for uname in settings.admin_usernames:
                u = db.query(_User).filter(_User.username == uname).first()
                if u and u.role != "admin":
                    u.role = "admin"
                    print(f"[bootstrap] Promoted {uname} to admin")
            db.commit()
    finally:
        db.close()
    yield


app = FastAPI(title=settings.APP_NAME, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API ROUTERS ---
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(me.router)
app.include_router(avatars.router)
app.include_router(rooms.router)
app.include_router(tokens.router)
app.include_router(stats.router)
app.include_router(xp.router)
app.include_router(daily.router)
app.include_router(friends.router)
app.include_router(dm.router)
app.include_router(notifications.router)
app.include_router(matches.router)
app.include_router(shop.router)
app.include_router(premium.router)
app.include_router(tournaments.router)
app.include_router(leaderboards.router)
app.include_router(referral.router)
app.include_router(achievements.router)
app.include_router(battlepass.router)
app.include_router(payments.router)
app.include_router(ads.router)
app.include_router(push.router)
app.include_router(chess.router)

# --- WEBSOCKET ROUTERS ---
app.include_router(ws_lobby.router)
app.include_router(ws_room.router)
app.include_router(ws_dm.router)  # <-- Added correctly at the bottom

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
STATIC_DIR = FRONTEND_DIR / "static"


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}


@app.get("/api/v1/stats/live")
async def live_stats():
    try:
        from app.redis_client import get_redis
        r = get_redis()
        count = await r.hlen("playsphere:lobby:players")
        return {"online": count}
    except Exception:
        return {"online": 0}


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _serve(filename: str):
    page = FRONTEND_DIR / filename
    if not page.exists():
        return JSONResponse({"error": f"{filename} not found"}, status_code=500)
    return FileResponse(page)


@app.get("/")
def root():
    return _serve("landing.html")


@app.get("/login")
def login_page():
    return _serve("login.html")


@app.get("/dashboard")
def dashboard():
    return _serve("dashboard.html")


@app.get("/profile")
def profile_page():
    return _serve("profile.html")


@app.get("/lobby")
def lobby_page():
    return _serve("lobby.html")


@app.get("/room")
def room_page():
    return _serve("room.html")


@app.get("/user")
def user_page():
    return _serve("user.html")


@app.get("/friends")
def friends_page():
    return _serve("friends.html")


@app.get("/shop")
def shop_page():
    return _serve("shop.html")


@app.get("/tournaments")
def tournaments_page():
    return _serve("tournaments.html")


@app.get("/buy")
def buy_page():
    return _serve("buy.html")


@app.get("/buy/callback")
def buy_callback():
    return _serve("buy.html")


@app.get("/buy/flw-callback")
def buy_flw_callback():
    return _serve("buy.html")    


@app.get("/premium")
def premium_page():
    return _serve("premium.html")


@app.get("/premium/callback")
def premium_callback():
    return _serve("premium.html")


@app.get("/leaderboards")
def leaderboards_page():
    return _serve("leaderboards.html")


@app.get("/referral")
def referral_page():
    return _serve("referral.html")


@app.get("/achievements")
def achievements_page():
    return _serve("achievements.html")


@app.get("/battlepass")
def battlepass_page():
    return _serve("battlepass.html")


@app.get("/battlepass/callback")
def battlepass_callback():
    return _serve("battlepass.html")


@app.get("/settings")
def settings_page():
    return _serve("settings.html")


@app.get("/terms")
def terms_page():
    return _serve("terms.html")


@app.get("/privacy")
def privacy_page():
    return _serve("privacy.html")


@app.get("/refund")
def refund_page():
    return _serve("refund.html")


@app.get("/admin/ads")
def admin_ads_page():
    return _serve("admin-ads.html")

from app.routers import (
    # ... existing ...
    groups, # <-- Add this
)

# ... later ...
app.include_router(groups.router) # <-- Add this


@app.get("/join")
def join_page():
    return _serve("join.html")

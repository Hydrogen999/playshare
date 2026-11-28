from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


url = settings.DATABASE_URL

# Neon URLs sometimes include channel_binding which psycopg2 doesn't understand
if "channel_binding" in url:
    url = url.split("channel_binding")[0].rstrip("&?")

if url.startswith("sqlite"):
    engine = create_engine(
        url,
        connect_args={"check_same_thread": False},
        future=True,
    )
elif url.startswith("postgresql"):
    engine = create_engine(
        url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        pool_recycle=280,
        future=True,
    )
else:
    engine = create_engine(url, future=True)


SessionLocal = sessionmaker(
    bind=engine, autoflush=False, autocommit=False, future=True
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
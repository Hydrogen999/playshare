import asyncio
from app.redis_client import get_redis


async def main():
    r = get_redis()
    pong = await r.ping()
    print("Redis PING:", pong)
    await r.set("playsphere:test", "hello")
    val = await r.get("playsphere:test")
    print("Redis GET:", val)
    await r.aclose()


if __name__ == "__main__":
    asyncio.run(main())
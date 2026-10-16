from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "PlaySphere"
    SECRET_KEY: str = "dev-secret-change-me-in-production-please"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    DATABASE_URL: str = "sqlite:///./playsphere.db"
    CORS_ORIGINS: str = "http://localhost:8000,http://127.0.0.1:8000"
    REDIS_URL: str = "redis://localhost:6379/0"

    ADMIN_USERNAMES: str = ""

    # Paystack (Nigeria — NGN)
    PAYSTACK_SECRET_KEY: str = ""
    PAYSTACK_PUBLIC_KEY: str = ""
    PAYSTACK_BASE_URL: str = "https://api.paystack.co"
    PAYSTACK_CALLBACK_URL: str = "http://localhost:8000/buy/callback"

    # Flutterwave (Global — USD/EUR/GBP)
    FLW_SECRET_KEY: str = ""
    FLW_PUBLIC_KEY: str = ""
    FLW_SECRET_HASH: str = ""
    FLW_BASE_URL: str = "https://api.flutterwave.com/v3"
    FLW_CALLBACK_URL: str = "http://localhost:8000/buy/flw-callback"

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def admin_usernames(self) -> list[str]:
        return [u.strip() for u in self.ADMIN_USERNAMES.split(",") if u.strip()]


settings = Settings()
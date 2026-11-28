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

    # Account verification (paid badge)
    VERIFICATION_RETURN_URL: str = ""   # page shown after Flutterwave checkout; default = <site>/verification/done

    # Calls: optional TURN relay so calls connect on mobile data / strict NATs.
    # Option A (coturn "static-auth-secret"): TURN_URLS + TURN_SECRET
    # Option B (fixed login, e.g. Metered/Twilio): TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
    TURN_URLS: str = ""                 # comma separated, e.g. turn:turn.example.com:3478,turns:turn.example.com:5349
    TURN_SECRET: str = ""
    TURN_USERNAME: str = ""
    TURN_CREDENTIAL: str = ""

    # Email codes (signup + password reset) sent through Resend's HTTPS API
    # (Render's free plan blocks SMTP). Leave empty to disable email codes.
    RESEND_API_KEY: str = ""
    MAIL_FROM: str = ""                 # e.g. "Zuno <no-reply@yourdomain.com>"

    # Push notifications (Firebase Cloud Messaging, HTTP v1). Paste the whole
    # service-account JSON (Firebase console > Project settings > Service accounts)
    # into this one environment variable. Empty = pushes are skipped.
    FCM_SERVICE_ACCOUNT_JSON: str = ""

    @property
    def turn_list(self) -> list[str]:
        return [u.strip() for u in self.TURN_URLS.split(",") if u.strip()]

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def admin_usernames(self) -> list[str]:
        return [u.strip() for u in self.ADMIN_USERNAMES.split(",") if u.strip()]


settings = Settings()
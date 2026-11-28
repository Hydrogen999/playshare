from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=24, pattern=r"^[A-Za-z0-9_]+$")
    password: str = Field(min_length=8, max_length=128)
    ref_code: str | None = Field(default=None, max_length=16)
    date_of_birth: str | None = Field(default=None, max_length=10)   # YYYY-MM-DD
    email_code: str | None = Field(default=None, max_length=8)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
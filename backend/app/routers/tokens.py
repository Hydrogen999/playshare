from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_admin
from app.models.token import LedgerEntry, LedgerTransaction
from app.models.user import User
from app.services.ledger import get_balance, grant_tokens

router = APIRouter(prefix="/api/v1/me", tags=["tokens"])


class BalanceOut(BaseModel):
    balance: int


class LedgerEntryOut(BaseModel):
    id: str
    transaction_id: str
    account_id: str
    delta: int
    balance_after: int
    created_at: str


class GrantIn(BaseModel):
    amount: int
    user_id: str | None = None  # admin can grant to another user


@router.get("/tokens", response_model=BalanceOut)
def my_balance(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return BalanceOut(balance=get_balance(db, me.id))


@router.get("/ledger", response_model=list[LedgerEntryOut])
def my_ledger(
    limit: int = 50,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(LedgerEntry)
        .filter(LedgerEntry.account_id == me.id)
        .order_by(LedgerEntry.created_at.desc())
        .limit(min(limit, 200))
        .all()
    )
    return [
        LedgerEntryOut(
            id=r.id,
            transaction_id=r.transaction_id,
            account_id=r.account_id,
            delta=r.delta,
            balance_after=r.balance_after,
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]


@router.post("/dev/grant", response_model=BalanceOut)
def dev_grant(
    data: GrantIn,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """ADMIN ONLY. Grants tokens to a user (or to the admin themselves)."""
    if data.amount <= 0 or data.amount > 10000:
        raise HTTPException(status_code=400, detail="Amount must be 1–10000")

    target_id = data.user_id or admin.id
    target = db.get(User, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found")

    grant_tokens(db, target_id, data.amount, reason=f"admin_grant_by_{admin.username}")
    db.commit()
    return BalanceOut(balance=get_balance(db, target_id))
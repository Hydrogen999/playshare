"""Double-entry token ledger."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.token import LedgerEntry, LedgerTransaction, TokenAccount
from app.models.user import Profile, User

ESCROW_ACCOUNT = "escrow"
TREASURY_ACCOUNT = "treasury"
SYSTEM_ACCOUNTS = {ESCROW_ACCOUNT, TREASURY_ACCOUNT}


class LedgerError(Exception):
    pass


def _ensure_account(db: Session, account_id: str, initial: int = 0) -> TokenAccount:
    acc = db.get(TokenAccount, account_id)
    if not acc:
        acc = TokenAccount(user_id=account_id, balance=initial)
        db.add(acc)
        db.flush()
    return acc


def _get_account_locked(db: Session, account_id: str) -> TokenAccount:
    stmt = (
        select(TokenAccount)
        .where(TokenAccount.user_id == account_id)
        .with_for_update()
    )
    acc = db.execute(stmt).scalar_one_or_none()
    if not acc:
        raise LedgerError(f"Account not found: {account_id}")
    return acc


def _sync_cached_balance(db: Session, account_id: str, new_balance: int) -> None:
    profile = db.get(Profile, account_id)
    if profile:
        profile.tokens_cached = new_balance


def get_balance(db: Session, account_id: str) -> int:
    acc = db.get(TokenAccount, account_id)
    return acc.balance if acc else 0


def post_transaction(
    db: Session,
    tx_type: str,
    entries: list[tuple[str, int]],
    idempotency_key: str | None = None,
    notes: str | None = None,
    created_by: str | None = None,
) -> LedgerTransaction:
    if idempotency_key:
        existing = (
            db.query(LedgerTransaction)
            .filter(LedgerTransaction.idempotency_key == idempotency_key)
            .first()
        )
        if existing:
            return existing

    total = sum(delta for _, delta in entries)
    if total != 0:
        raise LedgerError(f"Entries must sum to 0, got {total}")

    for account_id, _ in entries:
        _ensure_account(db, account_id)

    tx = LedgerTransaction(
        type=tx_type,
        idempotency_key=idempotency_key,
        notes=notes,
        created_by=created_by,
    )
    db.add(tx)
    db.flush()

    for account_id, delta in entries:
        acc = _get_account_locked(db, account_id)
        new_balance = acc.balance + delta

        # System accounts (treasury, escrow) can go negative — they're not real users
        if account_id not in SYSTEM_ACCOUNTS and new_balance < 0:
            raise LedgerError(
                f"Insufficient balance for {account_id}: "
                f"has {acc.balance}, needs {abs(delta)}"
            )

        acc.balance = new_balance
        db.add(
            LedgerEntry(
                transaction_id=tx.id,
                account_id=account_id,
                delta=delta,
                balance_after=new_balance,
            )
        )
        _sync_cached_balance(db, account_id, new_balance)

    db.flush()
    return tx


def grant_tokens(
    db: Session,
    user_id: str,
    amount: int,
    reason: str = "grant",
    idempotency_key: str | None = None,
) -> LedgerTransaction:
    if amount <= 0:
        raise LedgerError("Amount must be positive")
    return post_transaction(
        db,
        tx_type="grant",
        entries=[
            (TREASURY_ACCOUNT, -amount),
            (user_id, +amount),
        ],
        idempotency_key=idempotency_key,
        notes=reason,
    )


def lock_wager(db, match_id, user_a, user_b, wager):
    if wager <= 0:
        raise LedgerError("Wager must be positive")
    return post_transaction(
        db,
        tx_type="wager_lock",
        entries=[
            (user_a, -wager),
            (user_b, -wager),
            (ESCROW_ACCOUNT, 2 * wager),
        ],
        idempotency_key=f"wager_lock:{match_id}",
        notes=f"Wager for match {match_id}",
    )


def settle_winner(db, match_id, winner_id, wager):
    pot = 2 * wager
    return post_transaction(
        db,
        tx_type="settle",
        entries=[
            (ESCROW_ACCOUNT, -pot),
            (winner_id, +pot),
        ],
        idempotency_key=f"settle:{match_id}",
        notes=f"Winner payout for match {match_id}",
    )


def refund_wager(db, match_id, user_a, user_b, wager):
    return post_transaction(
        db,
        tx_type="refund",
        entries=[
            (ESCROW_ACCOUNT, -2 * wager),
            (user_a, +wager),
            (user_b, +wager),
        ],
        idempotency_key=f"refund:{match_id}",
        notes=f"Refund for match {match_id}",
    )


def bootstrap_ledger(db: Session) -> None:
    _ensure_account(db, ESCROW_ACCOUNT)
    _ensure_account(db, TREASURY_ACCOUNT)

    users = db.query(User).all()
    for u in users:
        if not db.get(TokenAccount, u.id):
            initial = u.profile.tokens_cached if u.profile else 0
            db.add(TokenAccount(user_id=u.id, balance=initial))

    db.commit()
"""Pure rules for the Verified Account feature (no database, no web framework).

Everything security-relevant that can be decided without I/O lives here so it
can be unit-tested on its own.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

# ---- money: set by the SERVER only. The client can never choose the amount.
FEE_CENTS = 5000
FEE_CURRENCY = "USD"

# ---- statuses
PAYMENT_PENDING = "payment_pending"
UNDER_REVIEW = "under_review"
MORE_INFO = "more_info_required"
APPROVED = "approved"
REJECTED = "rejected"
REVOKED = "revoked"

ALL_STATUSES = (PAYMENT_PENDING, UNDER_REVIEW, MORE_INFO, APPROVED, REJECTED, REVOKED)
# A user may have at most ONE application in these statuses at a time.
ACTIVE_STATUSES = (PAYMENT_PENDING, UNDER_REVIEW, MORE_INFO, APPROVED)
# While in these, the applicant may edit details and upload evidence.
EDITABLE_STATUSES = (PAYMENT_PENDING, MORE_INFO)

CATEGORIES = (
    "public_figure",
    "content_creator",
    "influencer",
    "business",
    "other_notable",
)

_TRANSITIONS = {
    (PAYMENT_PENDING, "payment_confirmed"): UNDER_REVIEW,
    (UNDER_REVIEW, "approve"): APPROVED,
    (UNDER_REVIEW, "reject"): REJECTED,
    (UNDER_REVIEW, "request_info"): MORE_INFO,
    (MORE_INFO, "resubmit"): UNDER_REVIEW,
    (MORE_INFO, "reject"): REJECTED,
    (APPROVED, "revoke"): REVOKED,
}


class InvalidTransition(Exception):
    pass


def next_status(current: str, action: str) -> str:
    """Return the new status or raise InvalidTransition."""
    try:
        return _TRANSITIONS[(current, action)]
    except KeyError:
        raise InvalidTransition(f"Cannot {action} an application that is {current}") from None


# ---- uploads --------------------------------------------------------------
MAX_DOCS_PER_APPLICATION = 5
MAX_DOC_BYTES = 8 * 1024 * 1024


def sniff_mime(data: bytes) -> str | None:
    """Detect the REAL file type from its first bytes (never trust the filename
    or the client-supplied content type). Only jpeg, png, webp and pdf allowed."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:5] == b"%PDF-":
        return "application/pdf"
    return None


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---- application fields ---------------------------------------------------
_USERNAME = re.compile(r"^[A-Za-z0-9_.]{3,30}$")
_URL = re.compile(r"^https?://[^\s]+\.[^\s]+$", re.IGNORECASE)


@dataclass
class ApplicationInput:
    full_name: str
    username: str
    category: str
    reason: str
    website: str = ""
    social_links: tuple = ()
    notes: str = ""


def validate_application(raw: dict) -> ApplicationInput:
    """Validate and normalise client input. Raises ValueError with a
    user-readable message."""
    full_name = str(raw.get("full_name", "")).strip()
    username = str(raw.get("username", "")).strip().lstrip("@")
    category = str(raw.get("category", "")).strip()
    reason = str(raw.get("reason", "")).strip()
    website = str(raw.get("website", "") or "").strip()
    notes = str(raw.get("notes", "") or "").strip()
    links = raw.get("social_links") or []

    if not (2 <= len(full_name) <= 120):
        raise ValueError("Enter your full legal name.")
    if not _USERNAME.match(username):
        raise ValueError("Enter a valid username.")
    if category not in CATEGORIES:
        raise ValueError("Choose an account category.")
    if not (20 <= len(reason) <= 2000):
        raise ValueError("Explain in at least 20 characters why you should be verified.")
    if website and (len(website) > 300 or not _URL.match(website)):
        raise ValueError("The website must start with http:// or https://")
    if not isinstance(links, (list, tuple)) or len(links) > 8:
        raise ValueError("You can add up to 8 social links.")
    clean_links = []
    for link in links:
        link = str(link).strip()
        if not link:
            continue
        if len(link) > 300 or not _URL.match(link):
            raise ValueError("Each social link must start with http:// or https://")
        clean_links.append(link)
    if len(notes) > 2000:
        raise ValueError("Additional information is too long.")
    return ApplicationInput(full_name, username, category, reason, website, tuple(clean_links), notes)


# ---- payments -------------------------------------------------------------
def payment_matches_fee(amount_cents: int, currency: str) -> bool:
    """A webhook only counts as the verification fee if amount AND currency
    match what the server expects."""
    return int(amount_cents) == FEE_CENTS and str(currency).upper() == FEE_CURRENCY

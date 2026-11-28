from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_admin
from app.models.user import User
from app.services import verification as svc
from app.services.verification_rules import MAX_DOC_BYTES

router = APIRouter(prefix="/api/v1/verification", tags=["verification"])


def _run(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except svc.VerificationError as e:
        raise HTTPException(e.status_code, e.message)


class ApplicationIn(BaseModel):
    full_name: str
    username: str
    category: str
    reason: str
    website: str = ""
    social_links: list[str] = []
    notes: str = ""


@router.get("/status")
def status(db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    return svc.get_status(db, me.id)


@router.post("/applications")
def save_application(body: ApplicationIn, db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    return _run(svc.save_application, db, me, body.model_dump())


@router.post("/applications/{app_id}/documents")
async def upload_document(app_id: str, file: UploadFile = File(...), db: Session = Depends(get_db),
                          me: User = Depends(get_current_user)):
    data = await file.read(MAX_DOC_BYTES + 1)
    return _run(svc.add_document, db, me.id, app_id, file.filename or "", data)


@router.delete("/applications/{app_id}/documents/{doc_id}")
def delete_document(app_id: str, doc_id: str, db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    return _run(svc.delete_document, db, me.id, app_id, doc_id)


@router.post("/applications/{app_id}/pay")
def pay(app_id: str, db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    return _run(svc.start_payment, db, me, app_id)


@router.post("/applications/{app_id}/sync")
def sync(app_id: str, db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    """Re-check the payment with Flutterwave (the app calls this after checkout)."""
    return _run(svc.sync_payment, db, me.id, app_id)


@router.post("/applications/{app_id}/resubmit")
def resubmit(app_id: str, db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    return _run(svc.resubmit, db, me.id, app_id)


# ------------------------------------------------------------------ admin
class DecisionIn(BaseModel):
    reason: str = ""


@router.get("/admin/whoami")
def admin_whoami(admin: User = Depends(require_admin)):
    return {"is_admin": True}


@router.get("/admin/applications")
def admin_list(status: str | None = None, limit: int = 50, offset: int = 0,
               db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return svc.admin_list(db, status, limit, offset)


@router.get("/admin/applications/{app_id}")
def admin_detail(app_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return _run(svc.admin_detail, db, app_id)


@router.get("/admin/documents/{doc_id}")
def admin_document(doc_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    data, mime = _run(svc.admin_document, db, admin.id, doc_id)
    return Response(content=data, media_type=mime, headers={
        "Content-Disposition": 'attachment; filename="document"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })


@router.post("/admin/applications/{app_id}/{action}")
def admin_decide(app_id: str, action: str, body: DecisionIn,
                 db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    # action: approve | reject | request-info | revoke
    return _run(svc.admin_decide, db, admin.id, app_id, action.replace("-", "_"), body.reason)

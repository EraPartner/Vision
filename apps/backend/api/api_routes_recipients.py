"""
API routes for recipient management

Handles all recipient-related endpoints.
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.api_schemas import RecipientResponse, RecipientCreate, RecipientUpdate
from config.logging_config import setup_logging
from database.connection import get_db
from services.recipient_service import RecipientService

router = APIRouter(prefix="/api", tags=["recipients"])
logger = setup_logging(__name__)


@router.get("/recipients", response_model=List[RecipientResponse])
async def get_recipients(
        search: str = Query(None, description="Search by name"),
        with_accounts: bool = Query(False, description="Only recipients with account numbers"),
        db: Session = Depends(get_db)
):
    """Get list of all recipients with optional search and filter for account numbers"""
    try:
        query = db.query(Recipient).filter(Recipient.is_active == True)

        if search:
            query = query.filter(Recipient.name.ilike(f"%{search}%"))
        if with_accounts:
            query = query.filter(Recipient.account_number.isnot(None))

        recipients = query.all()

        logger.info(f"Retrieved {len(recipients)} recipients")

        return [RecipientResponse.model_validate(r) for r in recipients]
    except Exception as e:
        logger.error(f"Error retrieving recipients: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving recipients")


@router.post("/recipients", response_model=RecipientResponse)
async def create_recipient(
        recipient: RecipientCreate,
        db: Session = Depends(get_db)
):
    """Create a new recipient"""
    try:
        service = RecipientService(db)
        new_recipient = service.create(
            name=recipient.name,
            account_number=recipient.account_number
        )
        return RecipientResponse.model_validate(new_recipient)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating recipient: {str(e)}")
        raise HTTPException(status_code=500, detail="Error creating recipient")


@router.get("/recipients/{recipient_id}", response_model=RecipientResponse)
async def get_recipient(
        recipient_id: int,
        db: Session = Depends(get_db)
):
    """Get a specific recipient"""
    try:
        service = RecipientService(db)
        recipient = service.get_by_id(recipient_id)
        if not recipient:
            raise HTTPException(status_code=404, detail="Recipient not found")

        return RecipientResponse.model_validate(recipient)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving recipient {recipient_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving recipient")


@router.put("/recipients/{recipient_id}", response_model=RecipientResponse)
async def update_recipient(
        recipient_id: int,
        recipient_update: RecipientUpdate,
        db: Session = Depends(get_db)
):
    """Update a recipient with support for clearing fields.

    Updates the specified recipient with new values. Supports clearing fields by
    setting them to null and updating default category and notes.

    Args:
        recipient_id (int): The ID of the recipient to update.
        recipient_update (RecipientUpdate): Updated recipient data including name,
            account_number, category_id, and notes.
        db (Session): Database session dependency.

    Returns:
        RecipientResponse: The updated recipient.

    Raises:
        HTTPException: 404 error if recipient not found.
        HTTPException: 500 error if update fails.
    """
    try:
        service = RecipientService(db)
        recipient = service.update(
            recipient_id=recipient_id,
            name=recipient_update.name,
            account_number=recipient_update.account_number,
            default_category_id=recipient_update.category_id,
            notes=recipient_update.notes
        )
        if not recipient:
            raise HTTPException(status_code=404, detail="Recipient not found")
        return RecipientResponse.model_validate(recipient)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating recipient {recipient_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error updating recipient")


@router.delete("/recipients/{recipient_id}")
async def delete_recipient(recipient_id: int, db: Session = Depends(get_db)):
    """Delete a recipient (soft delete - mark as inactive).

    Performs a soft delete by marking the recipient as inactive rather than removing
    it from the database. This preserves historical transaction data integrity.

    Args:
        recipient_id (int): The ID of the recipient to delete.
        db (Session): Database session dependency.

    Returns:
        dict: Success message confirming deletion.

    Raises:
        HTTPException: 404 error if recipient not found.
        HTTPException: 500 error if deletion fails.
    """
    try:
        service = RecipientService(db)
        if not service.delete(recipient_id):
            raise HTTPException(status_code=404, detail="Recipient not found")
        return {"message": "Recipient deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting recipient {recipient_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error deleting recipient")

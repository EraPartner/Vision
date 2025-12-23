"""
API routes for transaction management

Handles all transaction-related endpoints.
"""
import os
import tempfile
from datetime import date
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from api.api_schemas import (
    TransactionFrontend, ExportCSVRequest, ExportCSVResponse
)
from config.logging_config import setup_logging
from database.connection import get_db

router = APIRouter(prefix="/api", tags=["transactions"])
logger = setup_logging(__name__)


@router.get("/transactions", response_model=List[TransactionFrontend])
async def get_transactions_frontend(
        limit: int = Query(1000, ge=1, le=5000),
        offset: int = Query(0, ge=0),
        start_date: Optional[str] = Query(None),
        end_date: Optional[str] = Query(None),
        bank_account: Optional[str] = Query(None),
        category_id: Optional[int] = Query(None),
        recipient_id: Optional[int] = Query(None),
        recipient_name: Optional[str] = Query(None),
        db: Session = Depends(get_db)
):
    """Get transactions with CLI-like filters"""
    try:
        service = TransactionImportService(db)
        s_date = date.fromisoformat(start_date) if start_date else None
        e_date = date.fromisoformat(end_date) if end_date else None
        rows = service.list_transactions_frontend(
            limit=limit,
            offset=offset,
            start_date=s_date,
            end_date=e_date,
            bank_account=bank_account,
            category_id=category_id,
            recipient_id=recipient_id,
            recipient_name=recipient_name,
        )
        return [TransactionFrontend(**row) for row in rows]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format; use YYYY-MM-DD")
    except Exception as e:
        logger.error(f"Error retrieving transactions: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving transactions")


@router.get("/export-csv")
async def export_transactions_csv_frontend(
        from_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD format)"),
        to_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD format)"),
        bank_account: Optional[str] = Query(None, description="Filter by specific bank account"),
        db: Session = Depends(get_db)
):
    """Export transactions to CSV file"""
    # Parse dates if provided
    from_date_obj = None
    to_date_obj = None

    if from_date:
        try:
            from_date_obj = date.fromisoformat(from_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid from_date format. Use YYYY-MM-DD")

    if to_date:
        try:
            to_date_obj = date.fromisoformat(to_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid to_date format. Use YYYY-MM-DD")

    # Create temporary file for export
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.csv') as tmp_file:
        tmp_file_path = tmp_file.name

    try:
        # Export transactions
        service = TransactionImportService(db)
        result = service.export_transactions_to_csv(
            file_path=tmp_file_path,
            from_date=from_date_obj,
            to_date=to_date_obj,
            bank_account=bank_account,
            category_id=None
        )

        if not result['success']:
            os.unlink(tmp_file_path)
            raise HTTPException(status_code=404, detail=result['message'])

        # Generate filename
        filename = f"transactions_export_{date.today().isoformat()}.csv"
        if from_date_obj:
            filename = f"transactions_{from_date_obj.isoformat()}_to_{to_date_obj or date.today()}.csv"

        logger.info(f"Exported transactions to {filename}")

        return FileResponse(
            path=tmp_file_path,
            media_type='text/csv',
            filename=filename,
            background=None
        )

    except HTTPException:
        raise
    except Exception as e:
        if os.path.exists(tmp_file_path):
            os.unlink(tmp_file_path)
        logger.error(f"Error exporting transactions: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error exporting transactions: {str(e)}")


@router.post("/transactions/export", response_model=ExportCSVResponse)
async def export_transactions_to_file(request: ExportCSVRequest, db: Session = Depends(get_db)):
    """Export transactions to a specified server-side file path (CLI export)"""
    try:
        service = TransactionExportService(db)
        from_date_obj = date.fromisoformat(request.from_date) if request.from_date else None
        to_date_obj = date.fromisoformat(request.to_date) if request.to_date else None

        result = service.export_to_csv(
            file_path=request.output,
            from_date=from_date_obj,
            to_date=to_date_obj,
            bank_account=request.bank_account,
            category_id=request.category_id,
        )
        if not result.get('success'):
            raise HTTPException(status_code=400, detail=result.get('message', 'Export failed'))
        return ExportCSVResponse(**result)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format; use YYYY-MM-DD")
    except Exception as e:
        logger.error(f"Error exporting transactions: {str(e)}")
        raise HTTPException(status_code=500, detail="Error exporting transactions")


@router.get("/transactions/view")
async def view_transactions(
        limit: int = Query(20, ge=1, le=1000),
        batch_id: Optional[int] = Query(None),
        db: Session = Depends(get_db)
):
    """View transactions with joined recipient and category info (CLI view)"""
    try:
        service = TransactionImportService(db)
        return service.view_transactions_joined(limit=limit, batch_id=batch_id)
    except Exception as e:
        logger.error(f"Error viewing transactions: {str(e)}")
        raise HTTPException(status_code=500, detail="Error viewing transactions")


@router.delete("/transactions/by-recipient")
async def delete_transactions_by_recipient(
        recipient_id: Optional[int] = Query(None),
        recipient_name: Optional[str] = Query(None),
        delete_recipient: bool = Query(False),
        db: Session = Depends(get_db)
):
    """Delete transactions by recipient (CLI delete-transactions)"""
    try:
        service = TransactionImportService(db)
        result = service.delete_transactions_by_recipient(
            recipient_id=recipient_id,
            recipient_name=recipient_name,
            delete_recipient=delete_recipient
        )
        if result.get('not_found'):
            raise HTTPException(status_code=404, detail="Recipient not found")
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error deleting transactions: {str(e)}")
        raise HTTPException(status_code=500, detail="Error deleting transactions")

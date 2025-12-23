"""
API routes for statistics and reporting

Handles all statistics and reporting endpoints.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.api_schemas import BankListResponse, StatisticsResponse, CategoryStats
from config.logging_config import setup_logging
from database.connection import get_db
from services.statistics_service import StatisticsService

router = APIRouter(prefix="/api/statistics", tags=["statistics"])
logger = setup_logging(__name__)


@router.get("", response_model=StatisticsResponse)
async def get_statistics(db: Session = Depends(get_db)):
    """Get overview statistics for the dashboard"""
    try:
        service = StatisticsService(db)
        stats = service.get_statistics()

        return StatisticsResponse(
            total_transactions=stats["total_transactions"],
            categories=[CategoryStats(**cat) for cat in stats["categories"]]
        )
    except Exception as e:
        logger.error(f"Error retrieving statistics: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving statistics")


@router.get("/banks", response_model=BankListResponse)
async def get_banks(db: Session = Depends(get_db)):
    """Get list of all bank accounts/sources in the database"""
    try:
        service = StatisticsService(db)
        bank_list = service.get_banks()
        return BankListResponse(banks=bank_list)
    except Exception as e:
        logger.error(f"Error retrieving banks: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving banks")


@router.get("/import-history")
async def get_import_history(
        limit: int = Query(10, ge=1, le=100),
        db: Session = Depends(get_db)
):
    """Get recent import batch history"""
    try:
        service = StatisticsService(db)
        return service.get_import_history(limit=limit)
    except Exception as e:
        logger.error(f"Error retrieving import history: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving import history")


@router.get("/transaction-summary")
async def get_transaction_summary(
        bank_account: Optional[str] = Query(None),
        start_date: Optional[str] = Query(None),
        end_date: Optional[str] = Query(None),
        db: Session = Depends(get_db)
):
    """Get transaction summary with filters"""
    try:
        # Parse dates if provided
        start = None
        end = None

        if start_date:
            try:
                start = date.fromisoformat(start_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format")

        if end_date:
            try:
                end = date.fromisoformat(end_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_date format")

        service = StatisticsService(db)
        return service.get_transaction_summary(
            bank_account=bank_account,
            start_date=start,
            end_date=end
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving transaction summary: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving transaction summary")

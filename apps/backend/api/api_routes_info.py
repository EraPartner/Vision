"""
API routes for statistics and reporting

Handles all statistics and reporting endpoints.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import BankListResponse, StatisticsResponse, CategoryStats, TransactionCountResponse, \
    MonthlyFinancialSummaryResponse, Link, OptionsResponse, MethodInfo
from api.hateoas_links import get_base_url
from config.logging_config import setup_logging
from database.connection import get_db
from services.info_service import InfoService

router = APIRouter(prefix="/api/info", tags=["info"])
logger = setup_logging(__name__)


# ==================== Helper Functions ====================

def get_info_links(request: Request) -> list[Link]:
    """
    Generate HATEOAS links for info/statistics resources.

    Args:
        request: FastAPI Request object for constructing absolute URLs

    Returns:
        List of Link objects describing available info endpoints
    """
    base_url = get_base_url(request)
    return [
        Link(
            rel="self",
            href=HttpUrl(f"{base_url}/api/info"),
            method="GET",
            title="Get overview statistics"
        ),
        Link(
            rel="banks",
            href=HttpUrl(f"{base_url}/api/info/banks"),
            method="GET",
            title="List all bank accounts"
        ),
        Link(
            rel="transaction-count",
            href=HttpUrl(f"{base_url}/api/info/transaction-count"),
            method="GET",
            title="Get total transaction count"
        ),
        Link(
            rel="transaction-summary",
            href=HttpUrl(f"{base_url}/api/info/transaction-summary"),
            method="GET",
            title="Get transaction summary with filters"
        ),
        Link(
            rel="monthly-summary",
            href=HttpUrl(f"{base_url}/api/info/monthly-summary"),
            method="GET",
            title="Get monthly financial summary (past 6 months)"
        ),
    ]


# ==================== Level 3 REST API Endpoints (HATEOAS) ====================


@router.options("", response_model=OptionsResponse, description="Discover available methods on info endpoint")
async def info_options(request: Request):
    """
    OPTIONS method for info endpoint discovery.

    Allows clients to discover what HTTP methods and sub-endpoints are available
    on the info/statistics endpoint. This supports REST Level 3 (HATEOAS) by
    enabling API discoverability.

    Returns:
        OptionsResponse: Available methods and HATEOAS links to all info sub-endpoints
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Get overview statistics for the dashboard"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=get_info_links(request)
    )


@router.get("", response_model=StatisticsResponse)
async def get_statistics(db: Session = Depends(get_db)):
    """Get overview statistics for the dashboard"""
    try:
        service = InfoService(db)
        stats = service.get_statistics()

        return StatisticsResponse(
            total_transactions=stats["total_transactions"],
            total_amount=stats["total_amount"],
            categories=[CategoryStats(**cat) for cat in stats["categories"]]
        )
    except Exception as e:
        logger.error(f"Error retrieving statistics: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving statistics")


@router.get("/banks", response_model=BankListResponse)
async def get_banks(db: Session = Depends(get_db)):
    """Get list of all bank accounts/sources in the database"""
    try:
        service = InfoService(db)
        bank_list = service.get_banks()
        return BankListResponse(banks=bank_list)
    except Exception as e:
        logger.error(f"Error retrieving banks: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving banks")


@router.get("/transaction-count", response_model=TransactionCountResponse)
async def get_transaction_count(db: Session = Depends(get_db)):
    """Get total count of transactions in the database"""
    try:
        service = InfoService(db)
        count = service.get_transaction_count()
        return TransactionCountResponse(total_transactions=count)
    except Exception as e:
        logger.error(f"Error retrieving transaction count: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving transaction count")


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

        service = InfoService(db)
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


@router.get("/monthly-summary", response_model=MonthlyFinancialSummaryResponse)
async def get_monthly_financial_summary(request: Request, db: Session = Depends(get_db)):
    """
    Get financial summary for the past 6 months, broken down month by month.

    Returns an array of monthly financial data for each of the last 6 months,
    along with an overall summary. This allows for trend analysis and
    month-over-month comparisons.

    Each month includes spending, income, net amount, and transaction count.
    """
    try:
        service = InfoService(db)
        data = service.get_monthly_financial_summary()

        base_url = get_base_url(request)
        links = [
            Link(
                rel="self",
                href=HttpUrl(f"{base_url}/api/info/monthly-summary"),
                method="GET",
                title="Get 6-month financial summary"
            ),
            Link(
                rel="parent",
                href=HttpUrl(f"{base_url}/api/info"),
                method="GET",
                title="View all info endpoints"
            ),
            Link(
                rel="transactions",
                href=HttpUrl(f"{base_url}/api/transactions"),
                method="GET",
                title="View all transactions"
            ),
        ]

        return MonthlyFinancialSummaryResponse(
            months=data["months"],
            summary=data["summary"],
            links=links
        )
    except Exception as e:
        logger.error(f"Error retrieving monthly financial summary: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving monthly financial summary")

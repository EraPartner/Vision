"""
API routes for statistics and reporting

Handles all statistics and reporting endpoints.
"""
from datetime import date
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import (
    BankListResponse,
    StatisticsResponse,
    CategoryStats,
    TransactionCountResponse,
    MonthlyFinancialSummaryResponse,
    Link,
    OptionsResponse,
    MethodInfo,
    PlannedExpensesNextMonthResponse,
    AverageVsCurrentSpendingResponse,
    SupportedAdaptersResponse,
    BankAdapterInfo
)
from api.hateoas_links import get_base_url
from config.logging_config import setup_logging
from database.connection import get_db
from services.bank_adapters import BANK_CONFIGURATIONS
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
            rel="supported-adapters",
            href=HttpUrl(f"{base_url}/api/info/supported-adapters"),
            method="GET",
            title="List all supported bank CSV parsers/adapters"
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
        Link(
            rel="planned-expenses-forecast",
            href=HttpUrl(f"{base_url}/api/info/planned-expenses-next-month"),
            method="GET",
            title="Get planned expenses forecast for next month"
        ),
        Link(
            rel="average-vs-current-spending",
            href=HttpUrl(f"{base_url}/api/info/average-vs-current-spending"),
            method="GET",
            title="Get average daily spending vs current month comparison"
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


@router.get("/supported-adapters", response_model=SupportedAdaptersResponse)
async def get_supported_adapters():
    """
    Get list of all supported bank CSV parsers/adapters.

    Returns information about all bank adapters configured in the system,
    including their internal keys, human-readable names, and implementation
    class names. This endpoint does not require database access as it returns
    static configuration data.

    Returns:
        SupportedAdaptersResponse: List of supported adapters with metadata
    """
    try:
        # Build adapter info list from BANK_CONFIGURATIONS
        adapters = [
            BankAdapterInfo(
                key=key,
                name=config["bank_name"],
                adapter_class=config["adapter_class"]
            )
            for key, config in BANK_CONFIGURATIONS.items()
        ]

        logger.info(
            "Retrieved supported bank adapters",
            extra={
                "operation": "get_supported_adapters",
                "resource_type": "adapter_configuration",
                "adapter_count": len(adapters)
            }
        )

        return SupportedAdaptersResponse(
            adapters=adapters,
            total_count=len(adapters)
        )
    except Exception as e:
        logger.error(
            "Error retrieving supported adapters",
            extra={
                "operation": "get_supported_adapters",
                "resource_type": "adapter_configuration",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving supported adapters")


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

        if start_date and start_date.strip():
            try:
                start = date.fromisoformat(start_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format")

        if end_date and end_date.strip():
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
async def get_monthly_financial_summary(
        request: Request,
        excluded_category_ids: Optional[List[int]] = Query(
            None,
            description="Category IDs to exclude from calculations (e.g., transfers). Defaults to [9, 22]"
        ),
        db: Session = Depends(get_db)
):
    """
    Get financial summary for the past 6 months, broken down month by month.

    Returns an array of monthly financial data for each of the last 6 months,
    along with an overall summary. This allows for trend analysis and
    month-over-month comparisons.

    Each month includes spending, income, net amount, and transaction count.

    Query Parameters:
        excluded_category_ids: Optional list of category IDs to exclude from calculations.
                               Useful for filtering out internal transfers or specific categories.
                               Example: ?excluded_category_ids=9&excluded_category_ids=22
                               Default: [9, 22] (Intrabank transfers and internal transfers)
    """
    try:
        service = InfoService(db)
        data = service.get_monthly_financial_summary(
            excluded_category_ids=excluded_category_ids
        )

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


@router.get("/planned-expenses-next-month", response_model=PlannedExpensesNextMonthResponse)
async def get_planned_expenses_next_month(
        request: Request,
        db: Session = Depends(get_db)
):
    """
    Get planned expenses and income forecast for the following month.

    Returns all planned transactions scheduled for the next calendar month,
    grouped by date to visualise expected cash flow patterns. This endpoint
    is designed for dashboard graphs showing expected in/outflows.

    The response includes:
    - Daily breakdown of expected income and expenses
    - List of individual planned transactions for each day
    - Summary totals for the entire month
    - Information about recurring transactions
    """
    try:
        service = InfoService(db)
        data = service.get_planned_expenses_next_month()

        base_url = get_base_url(request)
        links = [
            Link(
                rel="self",
                href=HttpUrl(f"{base_url}/api/info/planned-expenses-next-month"),
                method="GET",
                title="Get planned expenses for next month"
            ),
            Link(
                rel="parent",
                href=HttpUrl(f"{base_url}/api/info"),
                method="GET",
                title="View all info endpoints"
            ),
            Link(
                rel="planned-transactions",
                href=HttpUrl(f"{base_url}/api/planned-transactions"),
                method="GET",
                title="View all planned transactions"
            ),
        ]

        return PlannedExpensesNextMonthResponse(
            month=data["month"],
            year=data["year"],
            period_start=data["period_start"],
            period_end=data["period_end"],
            daily_data=data["daily_data"],
            summary=data["summary"],
            links=links
        )
    except Exception as e:
        logger.error(f"Error retrieving planned expenses next month: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving planned expenses next month")


@router.get("/average-vs-current-spending", response_model=AverageVsCurrentSpendingResponse)
async def get_average_vs_current_spending(
        request: Request,
        db: Session = Depends(get_db)
):
    """
    Get average daily spending over the past 6 months compared to current month.

    This endpoint provides data for dashboard graphs comparing current spending
    patterns against historical averages. It calculates:
    - Average daily spending from the past 6 complete months (excluding current month)
    - Daily spending breakdown for the current month
    - Cumulative spending comparison showing actual vs expected
    - Variance metrics and projections

    The response enables visualisation of:
    1. How current month spending compares to the historical average
    2. Whether spending is tracking above or below the average
    3. Projected month-end total based on current pace

    This is useful for budget monitoring and identifying spending trends.
    """
    try:
        service = InfoService(db)
        data = service.get_average_vs_current_spending()

        base_url = get_base_url(request)
        links = [
            Link(
                rel="self",
                href=HttpUrl(f"{base_url}/api/info/average-vs-current-spending"),
                method="GET",
                title="Get average vs current spending comparison"
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
            Link(
                rel="monthly-summary",
                href=HttpUrl(f"{base_url}/api/info/monthly-summary"),
                method="GET",
                title="View 6-month financial summary"
            ),
        ]

        return AverageVsCurrentSpendingResponse(
            past_6_months=data["past_6_months"],
            current_month=data["current_month"],
            comparison=data["comparison"],
            links=links
        )
    except Exception as e:
        logger.error(f"Error retrieving average vs current spending: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving average vs current spending")

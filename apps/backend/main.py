import os
import tempfile
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database.connection import get_db, init_db
from services.bank_adapters import BankAdapterFactory
from services.transaction_service import TransactionImportService

app = FastAPI(
    title="Financial Transaction Manager",
    description="Import and manage financial transactions from various banks",
    version="1.0.0"
)


# Pydantic models for API
class TransactionResponse(BaseModel):
    id: int
    date: datetime
    bank_account: str
    recipient: str
    memo: Optional[str]
    amount: float
    currency: Optional[str]
    balance: Optional[float]
    category_id: Optional[int]
    created_at: datetime


class ImportResult(BaseModel):
    batch_id: str
    total_processed: int
    imported: int
    duplicates: int
    errors: int
    status: str
    error_message: Optional[str] = None


class TransactionSummary(BaseModel):
    total_transactions: int
    total_amount: float
    average_amount: float
    min_amount: float
    max_amount: float
    date_range: dict


class RecipientResponse(BaseModel):
    id: int
    name: str
    account_number: Optional[str]
    default_category_id: Optional[int]  # For future automatic categorization
    last_seen_date: datetime
    transaction_count: int


@app.on_event("startup")
async def startup_event():
    """Initialize database on startup"""
    init_db()


@app.get("/")
async def root():
    """Health check endpoint"""
    return {"message": "Financial Transaction Manager API", "status": "running"}


@app.get("/supported-banks")
async def get_supported_banks():
    """Get list of supported bank configurations"""
    return {"banks": BankAdapterFactory.get_supported_banks()}


@app.post("/import/csv", response_model=ImportResult)
async def import_csv_file(
        file: UploadFile = File(...),
        bank_name: str = Query(..., description="Name of the bank (e.g., 'chase', 'bank_of_america')"),
        db: Session = Depends(get_db)
):
    """Import transactions from a CSV file"""

    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="File must be a CSV")

    # Create temporary file
    with tempfile.NamedTemporaryFile(delete=False, suffix='.csv') as tmp_file:
        content = await file.read()
        tmp_file.write(content)
        tmp_file_path = tmp_file.name

    try:
        # Import transactions
        service = TransactionImportService(db)
        result = service.import_csv(tmp_file_path, bank_name)

        return ImportResult(**result)

    finally:
        # Clean up temporary file
        os.unlink(tmp_file_path)


@app.post("/import/csv/custom", response_model=ImportResult)
async def import_csv_custom_config(
        file: UploadFile = File(...),
        bank_name: str = Query(..., description="Custom bank name"),
        date_format: str = Query(..., description="Date format (e.g., '%m/%d/%Y')"),
        date_column: str = Query(..., description="Date column name"),
        recipient_column: str = Query(..., description="Recipient/Description column name"),
        amount_column: str = Query(..., description="Amount column name"),
        memo_column: Optional[str] = Query(None, description="Memo column name (optional)"),
        separator: str = Query(",", description="CSV separator"),
        encoding: str = Query("utf-8", description="File encoding"),
        skip_rows: int = Query(0, description="Number of rows to skip"),
        db: Session = Depends(get_db)
):
    """Import transactions with custom CSV configuration"""

    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="File must be a CSV")

    # Create custom configuration
    custom_config = {
        "bank_name": bank_name,
        "encoding": encoding,
        "separator": separator,
        "skip_rows": skip_rows,
        "date_format": date_format,
        "column_mapping": {
            "date": date_column,
            "recipient": recipient_column,
            "amount": amount_column,
            "memo": memo_column if memo_column else ""
        }
    }

    # Create temporary file
    with tempfile.NamedTemporaryFile(delete=False, suffix='.csv') as tmp_file:
        content = await file.read()
        tmp_file.write(content)
        tmp_file_path = tmp_file.name

    try:
        # Import transactions
        service = TransactionImportService(db)
        result = service.import_csv(tmp_file_path, bank_name, custom_config)

        return ImportResult(**result)

    finally:
        # Clean up temporary file
        os.unlink(tmp_file_path)


@app.get("/transactions", response_model=List[TransactionResponse])
async def get_transactions(
        bank_account: Optional[str] = Query(None, description="Filter by bank account"),
        start_date: Optional[datetime] = Query(None, description="Start date filter"),
        end_date: Optional[datetime] = Query(None, description="End date filter"),
        category_id: Optional[int] = Query(None, description="Filter by category ID"),
        limit: int = Query(100, description="Maximum number of results"),
        offset: int = Query(0, description="Number of results to skip"),
        db: Session = Depends(get_db)
):
    """Get transactions with optional filters"""

    service = TransactionImportService(db)
    transactions = service.get_transactions(
        bank_account=bank_account,
        start_date=start_date,
        end_date=end_date,
        category_id=category_id,
        limit=limit,
        offset=offset
    )

    return [
        TransactionResponse(
            id=t.id,
            date=t.date,
            bank_account=t.bank_account,
            recipient=t.recipient,
            memo=t.memo,
            amount=float(t.amount),
            category_id=t.category_id,
            created_at=t.created_at
        )
        for t in transactions
    ]


@app.get("/transactions/summary", response_model=TransactionSummary)
async def get_transaction_summary(
        bank_account: Optional[str] = Query(None, description="Filter by bank account"),
        start_date: Optional[datetime] = Query(None, description="Start date filter"),
        end_date: Optional[datetime] = Query(None, description="End date filter"),
        db: Session = Depends(get_db)
):
    """Get transaction summary statistics"""

    service = TransactionImportService(db)
    summary = service.get_transaction_summary(
        bank_account=bank_account,
        start_date=start_date,
        end_date=end_date
    )

    return TransactionSummary(**summary)


@app.put("/transactions/{transaction_id}/category")
async def update_transaction_category(
        transaction_id: int,
        category_id: int = Query(..., description="Category ID to assign"),
        db: Session = Depends(get_db)
):
    """Update category for a specific transaction"""

    service = TransactionImportService(db)
    success = service.update_transaction_category(transaction_id, category_id)

    if not success:
        raise HTTPException(status_code=404, detail="Transaction not found")

    return {"message": "Category updated successfully"}


@app.get("/banks")
async def get_bank_accounts(db: Session = Depends(get_db)):
    """Get list of all bank accounts in the database"""
    from database.models import Transaction

    banks = db.query(Transaction.bank_account).distinct().all()
    return {"banks": [bank[0] for bank in banks]}


@app.get("/recipients", response_model=List[RecipientResponse])
async def get_recipients(
        db: Session = Depends(get_db)
):
    """Get list of all recipients"""

    recipients = db.query(Recipient).all()

    return [
        RecipientResponse(
            id=r.id,
            name=r.name,
            account_number=r.account_number,
            first_seen_date=r.first_seen_date,
            default_category_id=r.default_category_id,  # Include default category ID
            transaction_count=r.transaction_count
        )
        for r in recipients
    ]


@app.get("/recipients/{recipient_id}", response_model=RecipientResponse)
async def get_recipient(
        recipient_id: int,
        db: Session = Depends(get_db)
):
    """Get details of a specific recipient"""

    recipient = db.query(Recipient).filter(Recipient.id == recipient_id).first()

    if recipient is None:
        raise HTTPException(status_code=404, detail="Recipient not found")

    return RecipientResponse(
        id=recipient.id,
        name=recipient.name,
        account_number=recipient.account_number,
        first_seen_date=recipient.first_seen_date,
        last_seen_date=recipient.last_seen_date,
        default_category_id=recipient.default_category_id,  # Include default category ID
        transaction_count=recipient.transaction_count


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

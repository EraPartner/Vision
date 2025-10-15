import os
import tempfile
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database.connection import get_db, init_db
from database.models import Recipient
from services.bank_adapters import BankAdapterFactory
from services.transaction_service import TransactionImportService

app = FastAPI(
    title="Financial Transaction Manager",
    description="Import and manage financial transactions from various banks",
    version="1.0.0"
)

# Add CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Pydantic models for frontend API compatibility
class TransactionFrontend(BaseModel):
    id: Optional[int] = None
    transaction_date: str
    description: str
    amount: float
    category: str
    bank_source: Optional[str] = None


class CSVImportRequest(BaseModel):
    csv_content: str
    bank_source: Optional[str] = None


class CSVImportResponse(BaseModel):
    imported: int
    message: str


# Pydantic models for API
class TransactionResponse(BaseModel):
    id: int
    date: datetime
    bank_account: str
    recipient: str
    memo: Optional[str]
    amount: float
    currency: Optional[str] = None
    balance: Optional[float] = None
    category_id: Optional[int]
    created_at: datetime

    class Config:
        from_attributes = True


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
    account_number: Optional[str] = None
    default_category_id: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


@app.on_event("startup")
async def startup_event():
    """Initialize database on startup"""
    init_db()


@app.get("/")
async def root():
    """Health check endpoint"""
    return {"message": "Financial Transaction Manager API", "status": "running"}


# Frontend API endpoints (with /api prefix)
@app.get("/api/transactions", response_model=List[TransactionFrontend])
async def get_transactions_frontend(db: Session = Depends(get_db)):
    """Get all transactions in frontend format"""
    from database.models import Transaction, Category

    transactions = db.query(Transaction).order_by(Transaction.date.desc()).limit(1000).all()

    result = []
    for t in transactions:
        category_name = "Uncategorized"
        if t.category_id:
            category = db.query(Category).filter(Category.id == t.category_id).first()
            if category:
                category_name = category.name

        result.append(TransactionFrontend(
            id=t.id,
            transaction_date=t.date.isoformat(),
            description=t.recipient.name if t.recipient else "Unknown",
            amount=float(t.amount),
            category=category_name,
            bank_source=t.bank_account
        ))

    return result


@app.post("/api/transactions", response_model=TransactionFrontend)
async def create_transaction_frontend(
        transaction: TransactionFrontend,
        db: Session = Depends(get_db)
):
    """Create a new transaction"""
    from database.models import Transaction, Recipient, Category
    from datetime import date

    # Find or create recipient
    recipient = db.query(Recipient).filter(Recipient.name == transaction.description).first()
    if not recipient:
        recipient = Recipient(name=transaction.description)
        db.add(recipient)
        db.flush()

    # Find or create category
    category = db.query(Category).filter(Category.name == transaction.category).first()
    if not category:
        category = Category(name=transaction.category)
        db.add(category)
        db.flush()

    # Create transaction
    new_transaction = Transaction(
        date=date.fromisoformat(transaction.transaction_date),
        amount=transaction.amount,
        recipient_id=recipient.id,
        category_id=category.id,
        bank_account=transaction.bank_source
    )

    db.add(new_transaction)
    db.commit()
    db.refresh(new_transaction)

    return TransactionFrontend(
        id=new_transaction.id,
        transaction_date=new_transaction.date.isoformat(),
        description=recipient.name,
        amount=float(new_transaction.amount),
        category=transaction.category,
        bank_source=new_transaction.bank_account
    )


@app.put("/api/transactions/{transaction_id}", response_model=TransactionFrontend)
async def update_transaction_frontend(
        transaction_id: int,
        transaction: TransactionFrontend,
        db: Session = Depends(get_db)
):
    """Update an existing transaction"""
    from database.models import Transaction, Recipient, Category
    from datetime import date

    db_transaction = db.query(Transaction).filter(Transaction.id == transaction_id).first()
    if not db_transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Update recipient if changed
    if transaction.description:
        recipient = db.query(Recipient).filter(Recipient.name == transaction.description).first()
        if not recipient:
            recipient = Recipient(name=transaction.description)
            db.add(recipient)
            db.flush()
        db_transaction.recipient_id = recipient.id

    # Update category if changed
    if transaction.category:
        category = db.query(Category).filter(Category.name == transaction.category).first()
        if not category:
            category = Category(name=transaction.category)
            db.add(category)
            db.flush()
        db_transaction.category_id = category.id

    # Update other fields
    db_transaction.date = date.fromisoformat(transaction.transaction_date)
    db_transaction.amount = transaction.amount
    db_transaction.bank_account = transaction.bank_source

    db.commit()
    db.refresh(db_transaction)

    return TransactionFrontend(
        id=db_transaction.id,
        transaction_date=db_transaction.date.isoformat(),
        description=db_transaction.recipient.name,
        amount=float(db_transaction.amount),
        category=transaction.category,
        bank_source=db_transaction.bank_account
    )


@app.delete("/api/transactions/{transaction_id}")
async def delete_transaction_frontend(transaction_id: int, db: Session = Depends(get_db)):
    """Delete a transaction"""
    from database.models import Transaction

    db_transaction = db.query(Transaction).filter(Transaction.id == transaction_id).first()
    if not db_transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")

    db.delete(db_transaction)
    db.commit()

    return {"message": "Transaction deleted successfully"}


@app.post("/api/import-csv", response_model=CSVImportResponse)
async def import_csv_frontend(
        request: CSVImportRequest,
        db: Session = Depends(get_db)
):
    """Import CSV content from frontend"""
    import tempfile
    import os

    # Create temporary file with CSV content
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.csv') as tmp_file:
        tmp_file.write(request.csv_content)
        tmp_file_path = tmp_file.name

    try:
        service = TransactionImportService(db)
        bank_source = request.bank_source or "unknown"
        result = service.import_csv(tmp_file_path, bank_source)

        return CSVImportResponse(
            imported=result.get('imported', 0),
            message=f"Successfully imported {result.get('imported', 0)} transactions"
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        os.unlink(tmp_file_path)


@app.get("/api/supported-banks")
async def get_supported_banks_frontend():
    """Get list of supported bank configurations for frontend"""
    return {"banks": BankAdapterFactory.get_supported_banks()}


# Original backend endpoints (keep for CLI compatibility)
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
            recipient=t.recipient.name if t.recipient else "Unknown",
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
            default_category_id=r.default_category_id,
            created_at=r.created_at,
            updated_at=r.updated_at
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
        default_category_id=recipient.default_category_id,
        created_at=recipient.created_at,
        updated_at=recipient.updated_at
    )


# Category endpoints for frontend
@app.get("/api/categories")
async def get_categories(db: Session = Depends(get_db)):
    """Get all categories"""
    from database.models import Category

    categories = db.query(Category).filter(Category.is_active == True).all()
    return [{
        "id": c.id,
        "name": c.name,
        "description": c.description,
        "color": c.color
    } for c in categories]


@app.post("/api/categories")
async def create_category(
        name: str = Body(...),
        description: str = Body(None),
        color: str = Body(None),
        db: Session = Depends(get_db)
):
    """Create a new category"""
    from database.models import Category

    # Check if category already exists
    existing = db.query(Category).filter(Category.name == name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Category already exists")

    category = Category(name=name, description=description, color=color)
    db.add(category)
    db.commit()
    db.refresh(category)

    return {
        "id": category.id,
        "name": category.name,
        "description": category.description,
        "color": category.color
    }


@app.get("/api/statistics")
async def get_statistics(db: Session = Depends(get_db)):
    """Get overview statistics for the dashboard"""
    from database.models import Transaction, Category
    from sqlalchemy import func

    total_transactions = db.query(func.count(Transaction.id)).scalar()
    total_amount = db.query(func.sum(Transaction.amount)).scalar() or 0

    # Get category breakdown
    category_stats = db.query(
        Category.name,
        func.count(Transaction.id).label('count'),
        func.sum(Transaction.amount).label('total')
    ).join(Transaction).group_by(Category.name).all()

    return {
        "total_transactions": total_transactions,
        "total_amount": float(total_amount),
        "categories": [
            {
                "name": stat[0],
                "count": stat[1],
                "total": float(stat[2] or 0)
            } for stat in category_stats
        ]
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

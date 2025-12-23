"""
API routes for CSV import functionality

Handles all CSV import-related endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session

from api.api_schemas import ImportResult
from config.logging_config import setup_logging
from database.connection import get_db
from services.bank_adapters import BankAdapterFactory
from services.csv_configuration_factory import CSVConfigurationFactory, CSVConfigurationError
from services.file_import_handler import FileImportHandler
from services.transaction_service import TransactionImportService

router = APIRouter(tags=["import"])
logger = setup_logging(__name__)


@router.get("/supported-banks")
async def get_supported_banks():
    """Get list of supported bank configurations"""
    try:
        banks = BankAdapterFactory.get_supported_banks()
        logger.info(f"Retrieved {len(banks)} supported banks")
        return {"banks": banks}
    except Exception as e:
        logger.error(f"Error retrieving supported banks: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving supported banks")


@router.post("/import/csv", response_model=ImportResult)
async def import_csv_file(
        file: UploadFile = File(...),
        bank_name: str = Query(..., description="Name of the bank (e.g., 'chase', 'belfius')"),
        db: Session = Depends(get_db)
):
    """Import transactions from a CSV file"""
    # Validate file type
    if not FileImportHandler.validate_csv_file(file.filename):
        raise HTTPException(status_code=400, detail="File must be a CSV")

    tmp_file_path = None
    try:
        # Read file content and save to temporary location
        content = await file.read()

        # Validate file size (50MB max)
        is_valid, error_msg = FileImportHandler.validate_file_size(len(content), max_size_mb=50)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)

        # Save to temporary file
        tmp_file_path = FileImportHandler.save_upload_to_temp(content, ".csv")

        # Perform import using service
        service = TransactionImportService(db)
        result = service.import_csv(tmp_file_path, bank_name)

        logger.info(
            f"CSV import completed: {result.get('imported', 0)} imported, {result.get('duplicates', 0)} duplicates")

        return ImportResult(**result)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error importing CSV: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        # Clean up temporary file
        if tmp_file_path:
            FileImportHandler.cleanup_temp_file(tmp_file_path)


@router.post("/import/csv/custom", response_model=ImportResult)
async def import_csv_custom_config(
        file: UploadFile = File(...),
        bank_name: str = Query(..., description="Custom bank name"),
        date_format: str = Query(..., description="Date format (e.g., '%m/%d/%Y')"),
        date_column: str = Query(..., description="Date column name"),
        recipient_column: str = Query(..., description="Recipient/Description column name"),
        amount_column: str = Query(..., description="Amount column name"),
        memo_column: str = Query(None, description="Memo column name (optional)"),
        separator: str = Query(",", description="CSV separator"),
        encoding: str = Query("utf-8", description="File encoding"),
        skip_rows: int = Query(0, description="Number of rows to skip"),
        db: Session = Depends(get_db)
):
    """Import transactions with custom CSV configuration"""
    # Validate file type
    if not FileImportHandler.validate_csv_file(file.filename):
        raise HTTPException(status_code=400, detail="File must be a CSV")

    tmp_file_path = None
    try:
        # Create and validate configuration using factory
        try:
            custom_config = CSVConfigurationFactory.create_custom_config(
                bank_name=bank_name,
                date_format=date_format,
                date_column=date_column,
                recipient_column=recipient_column,
                amount_column=amount_column,
                memo_column=memo_column,
                separator=separator,
                encoding=encoding,
                skip_rows=skip_rows
            )
        except CSVConfigurationError as e:
            raise HTTPException(status_code=400, detail=f"Invalid configuration: {str(e)}")

        # Read file content and save to temporary location
        content = await file.read()

        # Validate file size (50MB max)
        is_valid, error_msg = FileImportHandler.validate_file_size(len(content), max_size_mb=50)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)

        # Save to temporary file
        tmp_file_path = FileImportHandler.save_upload_to_temp(content, ".csv")

        # Perform import using service
        service = TransactionImportService(db)
        result = service.import_csv(tmp_file_path, bank_name, custom_config)

        logger.info(f"Custom CSV import completed: {result.get('imported', 0)} imported")

        return ImportResult(**result)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error importing CSV with custom config: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        # Clean up temporary file
        if tmp_file_path:
            FileImportHandler.cleanup_temp_file(tmp_file_path)

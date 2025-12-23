"""
API routes for category management

Handles all category-related endpoints.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.api_schemas import (
    CategoryResponse, CategoryCreate, AssignCategoryRequest, UncategorizedResponse
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.category_service import CategoryService

router = APIRouter(prefix="/api", tags=["categories"])
logger = setup_logging(__name__)


@router.get("/categories")
async def get_categories(db: Session = Depends(get_db)):
    """Get all categories"""
    try:
        service = CategoryService(db)
        categories = service.get_all_flat()
        logger.info(f"Retrieved {len(categories)} categories")
        return [{
            "id": c.id,
            "general": c.general,
            "detail": c.detail,
            "description": c.description,
            "color": c.color
        } for c in categories]
    except Exception as e:
        logger.error(f"Error retrieving categories: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving categories")


@router.post("/categories", response_model=CategoryResponse)
async def create_category(
        category: CategoryCreate,
        db: Session = Depends(get_db)
):
    """Create a new category in General:Detail format"""
    try:
        service = CategoryService(db)
        new_category = service.get_or_create_category(
            category_path=category.name,
            description=category.description,
            color=category.color
        )
        return CategoryResponse.model_validate(new_category)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error creating category")


@router.get("/categories/{category_id}", response_model=CategoryResponse)
async def get_category(
        category_id: int,
        db: Session = Depends(get_db)
):
    """Get a specific category"""
    try:
        service = CategoryService(db)
        category = service.get_by_id(category_id)
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category")


@router.put("/categories/{category_id}", response_model=CategoryResponse)
async def update_category(
        category_id: int,
        category_update: CategoryCreate,
        db: Session = Depends(get_db)
):
    """Update a category"""
    try:
        service = CategoryService(db)
        category = service.update(
            category_id=category_id,
            name=category_update.name,
            description=category_update.description,
            color=category_update.color
        )
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error updating category")


@router.delete("/categories/{category_id}")
async def delete_category(category_id: int, db: Session = Depends(get_db)):
    """Delete a category (soft delete - mark as inactive)"""
    try:
        service = CategoryService(db)
        if not service.delete(category_id):
            raise HTTPException(status_code=404, detail="Category not found")
        return {"message": "Category deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error deleting category")


@router.post("/categories/assign")
async def assign_category(request: AssignCategoryRequest, db: Session = Depends(get_db)):
    """Assign category to one or many recipients"""
    try:
        service = CategoryService(db)
        if request.recipient_id:
            # Get or create category and assign to recipient
            category = service.get_or_create_category(request.category_name)
            from database.models import Recipient
            recipient = db.query(Recipient).filter(Recipient.id == request.recipient_id).first()
            if not recipient:
                raise HTTPException(status_code=404, detail="Recipient not found")
            recipient.default_category_id = category.id
            db.commit()
            return {"updated": 1}
        elif request.recipient_ids:
            result = service.bulk_assign_category(request.recipient_ids, request.category_name)
            return result
        else:
            raise HTTPException(status_code=400, detail="Provide recipient_id or recipient_ids")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error assigning category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error assigning category")


@router.get("/categories/uncategorized", response_model=UncategorizedResponse)
async def get_uncategorized(
        type: str = Query("all", pattern="^(recipients|transactions|all)$"),
        limit: int = Query(50, ge=1, le=1000),
        db: Session = Depends(get_db)
):
    """Show uncategorized recipients and/or transactions"""
    try:
        service = CategoryService(db)
        response = {}

        if type in ("recipients", "all"):
            recipients = service.get_uncategorized_recipients()
            response["recipients"] = [{
                "id": r.id,
                "name": r.name,
                "txns": len(r.transactions)
            } for r in recipients]

        if type in ("transactions", "all"):
            from repositories.transaction_repository import TransactionRepository
            transaction_service = TransactionRepository(db)
            txns = transaction_service.get_uncategorized(limit=limit)
            response["transactions"] = [{
                "date": t.date.isoformat(),
                "amount": float(t.amount),
                "recipient": t.recipient.name if t.recipient else None
            } for t in txns]

        return response
    except Exception as e:
        logger.error(f"Error retrieving uncategorized: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving uncategorized")


@router.get("/categories/stats")
async def get_category_stats(db: Session = Depends(get_db)):
    """Category statistics"""
    try:
        service = CategoryService(db)
        return service.get_category_statistics()
    except Exception as e:
        logger.error(f"Error retrieving category stats: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category stats")

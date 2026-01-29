"""
API routes for category management.

Handles all category-related endpoints.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.params import Path
from sqlalchemy.orm import Session

from api.api_schemas import (
    CategoryResponse, AssignCategoryRequest, CategoryBase, CategoryUpdate
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.category_service import CategoryService

router = APIRouter(prefix="/api", tags=["categories"])
logger = setup_logging(__name__)


@router.get("/categories", response_model=list[CategoryResponse], description="Retrieves all categories.")
async def get_categories(
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of categories to return"),
        offset: int = Query(0, ge=0, description="Number of categories to skip for pagination"),
        db: Session = Depends(get_db)
):
    """Get categories with pagination.

    Retrieves a list of categories with pagination support.

    Args:
        limit (int): Maximum number of categories to return (1-1000). Defaults to 50.
        offset (int): Number of categories to skip before returning results. Defaults to 0.
        db (Session): Database session dependency.

    Returns:
        list[CategoryResponse]: List of categories.

    Raises:
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        categories = service.get_all_flat(limit=limit, offset=offset)
        logger.info(f"Retrieved {len(categories)} categories (offset={offset}, limit={limit})")
        return [CategoryResponse.model_validate(c) for c in categories]
    except Exception as e:
        logger.error(f"Error retrieving categories: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving categories")


@router.post("/categories", response_model=CategoryResponse, description="Creates a new category.")
async def get_or_create_category(
        category: CategoryBase,
        db: Session = Depends(get_db)
):
    """Create a new category or return an existing one.

    Creates a new category with the specified general and detail names. If a category
    with the same general:detail combination already exists, returns the existing category.

    Args:
        category (CategoryBase): Category creation data including general, detail,
            description, and color.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The created or existing category.

    Raises:
        HTTPException: 400 error for validation errors.
        HTTPException: 500 error if creation fails.
    """
    try:
        service = CategoryService(db)
        new_category = service.get_or_create_category(
            general=category.general,
            detail=category.detail,
            description=category.description,
            color=category.color
        )
        return CategoryResponse.model_validate(new_category)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error creating category")


@router.get("/categories/{category_id}", response_model=CategoryResponse,
            description="Retrieves a specific category by ID.")
async def get_category(
        category_id: int = Path(..., ge=1, description="The ID of the category to retrieve"),
        db: Session = Depends(get_db)
):
    """Get a specific category by ID.

    Retrieves detailed information for a single category identified by its ID.

    Args:
        category_id (int): The ID of the category to retrieve.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The requested category details.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if retrieval fails.
    """
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


@router.patch("/categories/{category_id}", response_model=CategoryResponse, description="Updates a category.")
async def update_category(
        category_update: CategoryUpdate,
        category_id: int = Path(..., ge=1, description="The ID of the category to update"),
        db: Session = Depends(get_db)
):
    """Partially update an existing category.

    Updates the specified category with any provided values for general, detail,
    description, and/or color.

    Args:
        category_id (int): The ID of the category to update.
        category_update (CategoryUpdate): Updated category data.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The updated category.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if update fails.
    """
    try:
        service = CategoryService(db)
        category = service.update(
            category_id=category_id,
            general=category_update.general,
            detail=category_update.detail,
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


@router.delete("/categories/{category_id}", description="Deletes a category.")
async def delete_category(
        category_id: int = Path(..., ge=1, description="The ID of the category to delete"),
        soft: bool = Query(True, description="Perform a soft delete or not"),
        db: Session = Depends(get_db)
):
    """Delete a category (soft delete).

    Performs a soft delete by marking the category as inactive rather than removing
    it from the database.

    Args:
        category_id (int): The ID of the category to delete.
        soft (bool): Whether to perform a soft delete (True) or hard delete (False).
        db (Session): Database session dependency.

    Returns:
        dict: Success message confirming deletion.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if deletion fails.
    """
    try:
        service = CategoryService(db)
        if soft:
            if not service.soft_delete(category_id):
                raise HTTPException(status_code=404, detail="Category not found")
        else:
            if not service.hard_delete(category_id):
                raise HTTPException(status_code=404, detail="Category not found")
        return {"message": "Category deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error deleting category")


@router.post("/categories/assign", description="Assign category to one or many recipients.")
async def assign_category(request: AssignCategoryRequest, db: Session = Depends(get_db)):
    """Assign a category to one or many recipients.

    Assigns a default category to multiple recipients. The category is created if it
    doesn't exist.

    Args:
        request (AssignCategoryRequest): Assignment request containing:
            - category_general (str): Category general name
            - category_detail (str): Category detail name
            - recipient_ids (int | list[int]): Recipient ID or list of recipient IDs
        db (Session): Database session dependency.

    Returns:
        dict: Number of recipients updated.

    Raises:
        HTTPException: 400 error for invalid request data.
        HTTPException: 404 error if a recipient is not found.
        HTTPException: 500 error if assignment fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_or_create_category(request.category_general, request.category_detail)
        updated_count = service.assign_category(
            recipient_ids=request.recipient_ids,
            category=category,
        )
        return {"updated_recipients": updated_count}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error assigning category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error assigning category")


@router.get("/categories/path/{general}/{detail}", response_model=CategoryResponse,
            description="Retrieves a specific category by General:Detail path.")
async def get_category_by_path(
        general: str = Path(..., description="General name"),
        detail: str = Path(..., description="Detail name"),
        db: Session = Depends(get_db)
):
    """Get a category by General:Detail path.

    Retrieves a category based on its general and detail names.

    Args:
        general (str): General name of the category.
        detail (str): Detail name of the category.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The requested category details.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_by_general_detail(general, detail)
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving category {general}:{detail}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category")

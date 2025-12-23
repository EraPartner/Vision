"""
Import Batch Repository

Centralizes operations for ImportBatch entities.
"""
from typing import List, Optional

from sqlalchemy.orm import Session

from database.models import ImportBatch


class ImportBatchRepository:
    def __init__(self, db: Session):
        self.db = db

    def list_recent(self, limit: int = 10) -> List[ImportBatch]:
        return self.db.query(ImportBatch).order_by(ImportBatch.created_at.desc()).limit(limit).all()

    def create(self, batch: ImportBatch) -> ImportBatch:
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)
        return batch

    def update(self, batch: ImportBatch) -> ImportBatch:
        self.db.commit()
        self.db.refresh(batch)
        return batch

    def get_by_id(self, batch_id: int) -> Optional[ImportBatch]:
        return self.db.query(ImportBatch).filter(ImportBatch.id == batch_id).first()

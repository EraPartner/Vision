# Quick Start Action Plan

**Vault Voyager Backend Refactoring - Week 1 Sprint**

---

## 🎯 **THIS WEEK'S GOALS**

1. Fix critical bugs and typos
2. Add missing database indexes
3. Initialize migration system
4. Document current API endpoints
5. Set up basic testing framework

**Expected Time Investment:** 15-20 hours  
**Expected Impact:** High - Foundation for all future work  
**Risk Level:** Low - Non-breaking changes

---

## 📅 **DAY-BY-DAY BREAKDOWN**

### Day 1: Quick Wins & Setup (2-3 hours)

#### Morning: Fix Critical Issues

- [ ] **Fix typo in api_schemas.py** (5 min)
    - Line 88: Change `genera` to `general`
    - Test affected endpoints

- [ ] **Remove unused imports** (30 min)
    - Run: `pylint --disable=all --enable=unused-import apps/backend/`
    - Clean up all unused imports

- [ ] **Add missing type hints** (1 hour)
    - Priority files: All API route files
    - Add `from __future__ import annotations` if needed

#### Afternoon: Documentation

- [ ] **Document all API endpoints** (1 hour)
    - Create `API_ENDPOINTS.md`
    - List all endpoints with purpose and usage
    - Mark deprecated/duplicate endpoints

- [ ] **Create database ERD** (30 min)
    - Use tool or manual diagram
    - Include in `DATABASE_ANALYSIS.md`

---

### Day 2: Database Foundation (3-4 hours)

#### Morning: Initialize Migrations

- [ ] **Set up Alembic** (1 hour)
  ```bash
  cd /path/to/backend
  alembic init alembic
  ```

- [ ] **Configure Alembic** (30 min)
    - Update `alembic.ini` with database URL
    - Update `alembic/env.py` to import models
    - Test with: `alembic current`

- [ ] **Create baseline migration** (30 min)
  ```bash
  alembic revision --autogenerate -m "Initial schema baseline"
  alembic upgrade head
  ```

#### Afternoon: Add Indexes

- [ ] **Create index migration** (1 hour)
  ```bash
  alembic revision -m "Add missing indexes"
  ```

- [ ] **Add indexes to migration** (30 min)
  ```python
  def upgrade():
      op.create_index('idx_transaction_recipient_id', 'transactions', ['recipient_id'])
      op.create_index('idx_transaction_category_id', 'transactions', ['category_id'])
      op.create_index('idx_transaction_date_bank', 'transactions', ['date', 'bank_account'])
      op.create_index('idx_batch_created_desc', 'import_batches', ['created_at'])
  ```

- [ ] **Test migration** (30 min)
  ```bash
  alembic upgrade head
  # Verify indexes created
  ```

---

### Day 3: Verification & Testing Setup (3-4 hours)

#### Morning: Verify Database

- [ ] **Run verification queries** (1 hour)
  ```sql
  -- Check column usage
  SELECT COUNT(*) as total,
         COUNT(currency) as with_currency,
         COUNT(balance) as with_balance,
         COUNT(comment) as with_comment
  FROM transactions;
  
  -- Check BankAdapter usage
  SELECT * FROM bank_adapters;
  
  -- Find orphaned records
  SELECT COUNT(*) FROM recipients r
  LEFT JOIN transactions t ON r.id = t.recipient_id
  WHERE t.id IS NULL;
  ```

- [ ] **Document findings** (30 min)
    - Update `DATABASE_ANALYSIS.md` with actual counts
    - Mark columns for removal/keeping

- [ ] **Benchmark current performance** (30 min)
  ```python
  # Create benchmark script
  import time
  # Test common queries and record times
  ```

#### Afternoon: Testing Framework

- [ ] **Install testing dependencies** (15 min)
  ```bash
  pip install pytest pytest-cov pytest-asyncio httpx
  ```

- [ ] **Create test structure** (30 min)
  ```bash
  mkdir -p tests/{unit,integration,e2e}
  touch tests/__init__.py
  touch tests/conftest.py
  ```

- [ ] **Write first tests** (1.5 hours)
    - `tests/unit/test_category_service.py`
    - `tests/integration/test_api_categories.py`
    - Run with: `pytest tests/ -v`

---

### Day 4: Code Quality Improvements (3-4 hours)

#### Morning: Service Layer Review

- [ ] **Analyze TransactionImportService** (1 hour)
    - List all methods and their purposes
    - Identify methods that don't belong (like `list_transactions_frontend`)
    - Create refactoring plan

- [ ] **Review error handling patterns** (1 hour)
    - Document current error handling
    - Identify inconsistencies
    - Plan standardization

#### Afternoon: API Cleanup Planning

- [ ] **Identify duplicate endpoints** (1 hour)
    - `/export-csv` vs `/transactions/export`
    - `/transactions/view` vs `/transactions`
    - Document consolidation plan

- [ ] **Create deprecation notices** (1 hour)
    - Add deprecation warnings to duplicate endpoints
    - Update API documentation
    - Plan removal timeline

---

### Day 5: Documentation & Review (2-3 hours)

#### Morning: Complete Documentation

- [ ] **Finalize API documentation** (1 hour)
    - Complete endpoint descriptions
    - Add request/response examples
    - Document query parameters

- [ ] **Update README** (30 min)
    - Add "Getting Started" section
    - Document development setup
    - Add testing instructions

#### Afternoon: Week Review

- [ ] **Run full test suite** (30 min)
  ```bash
  pytest tests/ -v --cov=. --cov-report=html
  ```

- [ ] **Review all changes** (30 min)
    - Verify all migrations work
    - Check all tests pass
    - Ensure documentation is complete

- [ ] **Plan next week** (30 min)
    - Based on findings this week
    - Prioritize refactoring tasks
    - Set goals for Week 2

---

## 🔧 **DETAILED TASKS WITH COMMANDS**

### Task 1: Fix Critical Typo

**File:** `/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/api/api_schemas.py`

**Change:**

```python
# Line 88 - OLD
general: str = Field(..., description="General name")

# Line 88 - NEW  
general: str = Field(..., description="General name")
```

**Verification:**

```bash
# Check if any code references the typo
grep -r "genera" --include="*.py" .
# Should only find the fixed line
```

---

### Task 2: Initialize Alembic

**Commands:**

```bash
cd "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"

# Install if not already
pip install alembic

# Initialize
alembic init alembic

# Edit alembic.ini
# Change: sqlalchemy.url = driver://user:pass@localhost/dbname
# To: sqlalchemy.url = sqlite:///./financial_transactions.db.bak

# Edit alembic/env.py
# Add after imports:
# import sys
# from pathlib import Path
# sys.path.append(str(Path(__file__).parent.parent))
# from database.models import Base
# target_metadata = Base.metadata

# Create first migration
alembic revision --autogenerate -m "Initial schema baseline"

# Apply migration
alembic upgrade head

# Verify
alembic current
```

---

### Task 3: Add Database Indexes

**Create migration file:**

```bash
alembic revision -m "Add missing indexes for performance"
```

**Edit the generated file:**

```python
def upgrade():
    # Add indexes for foreign keys
    op.create_index('idx_transaction_recipient_id', 'transactions', ['recipient_id'])
    op.create_index('idx_transaction_category_id', 'transactions', ['category_id'])
    op.create_index('idx_transaction_batch_id', 'transactions', ['batch_id'])

    # Add composite index for common query pattern
    op.create_index('idx_transaction_date_bank', 'transactions', ['date', 'bank_account'])

    # Add index for import history sorting
    op.create_index('idx_batch_created_desc', 'import_batches', ['created_at'])

    # Add index for recipient category lookups
    op.create_index('idx_recipient_category_id', 'recipients', ['default_category_id'])


def downgrade():
    op.drop_index('idx_recipient_category_id', table_name='recipients')
    op.drop_index('idx_batch_created_desc', table_name='import_batches')
    op.drop_index('idx_transaction_date_bank', table_name='transactions')
    op.drop_index('idx_transaction_batch_id', table_name='transactions')
    op.drop_index('idx_transaction_category_id', table_name='transactions')
    op.drop_index('idx_transaction_recipient_id', table_name='transactions')
```

**Apply:**

```bash
alembic upgrade head
```

---

### Task 4: Set Up Testing

**Install dependencies:**

```bash
pip install pytest pytest-cov pytest-asyncio httpx
pip freeze > requirements-dev.txt
```

**Create test configuration:**

```python
# tests/conftest.py
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database.models import Base
from database.connection import get_db
from main import app

# Test database
SQLALCHEMY_TEST_DATABASE_URL = "sqlite:///./test.db"
engine = create_engine(SQLALCHEMY_TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def db():
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client(db):
    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)
```

**Create first test:**

```python
# tests/integration/test_api_categories.py
def test_get_categories(client):
    response = client.get("/api/categories")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_create_category(client):
    category_data = {
        "general": "Food",
        "detail": "Groceries",
        "description": "Grocery shopping",
        "color": "#FF0000"
    }
    response = client.post("/api/categories", json=category_data)
    assert response.status_code == 200
    data = response.json()
    assert data["general"] == "Food"
    assert data["detail"] == "Groceries"
```

**Run tests:**

```bash
pytest tests/ -v --cov=. --cov-report=html
```

---

### Task 5: Verify Column Usage

**Create verification script:**

```python
# scripts/verify_column_usage.py
from database.connection import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# Check transaction columns
result = db.execute(text("""
    SELECT 
        COUNT(*) as total,
        COUNT(currency) as with_currency,
        COUNT(balance) as with_balance,
        COUNT(comment) as with_comment,
        COUNT(original_raw_data) as with_raw_data,
        COUNT(bank_reference) as with_reference
    FROM transactions
""")).fetchone()

print("Transaction Column Usage:")
print(f"Total transactions: {result[0]}")
print(f"With currency: {result[1]} ({result[1] / result[0] * 100:.1f}%)")
print(f"With balance: {result[2]} ({result[2] / result[0] * 100:.1f}%)")
print(f"With comment: {result[3]} ({result[3] / result[0] * 100:.1f}%)")
print(f"With raw_data: {result[4]} ({result[4] / result[0] * 100:.1f}%)")
print(f"With reference: {result[5]} ({result[5] / result[0] * 100:.1f}%)")

# Check BankAdapter table
result = db.execute(text("SELECT COUNT(*) FROM bank_adapters")).fetchone()
print(f"\nBankAdapter records: {result[0]}")

db.close()
```

**Run:**

```bash
python scripts/verify_column_usage.py
```

---

## ✅ **DAILY CHECKLIST**

Copy this for each day:

### Daily Standup Questions

- [ ] What did I complete yesterday?
- [ ] What am I working on today?
- [ ] Any blockers or issues?

### Daily Tasks

- [ ] Review overnight thoughts/ideas
- [ ] Complete planned tasks for the day
- [ ] Update TODO.md with progress
- [ ] Commit changes with clear messages
- [ ] Run tests before committing
- [ ] Update documentation as needed

### End of Day

- [ ] All tests passing?
- [ ] All changes committed?
- [ ] Documentation updated?
- [ ] Plan tomorrow's tasks
- [ ] Note any issues for follow-up

---

## 🚦 **SUCCESS METRICS FOR WEEK 1**

### Must Have (Critical)

- [x] Critical typo fixed
- [ ] Alembic initialized and working
- [ ] Missing indexes added
- [ ] At least 5 tests written and passing
- [ ] Column usage documented

### Should Have (Important)

- [ ] Test coverage > 20%
- [ ] All API endpoints documented
- [ ] Database ERD created
- [ ] Benchmark baseline established
- [ ] Deprecation plan for duplicate endpoints

### Could Have (Nice to Have)

- [ ] Test coverage > 30%
- [ ] First service refactoring completed
- [ ] CI/CD pipeline started
- [ ] Code quality tools configured
- [ ] Contributing guide written

---

## 🔍 **VERIFICATION CHECKLIST**

Before marking Week 1 complete:

### Code Quality

- [ ] No syntax errors
- [ ] All imports working
- [ ] Type hints added to new code
- [ ] No obvious bugs introduced
- [ ] Linter passes (or known issues documented)

### Database

- [ ] All migrations applied successfully
- [ ] Can rollback migrations
- [ ] Indexes exist and working
- [ ] No data corruption
- [ ] Backup of original database created

### Testing

- [ ] Test suite runs without errors
- [ ] Tests are meaningful (not just smoke tests)
- [ ] Coverage report generated
- [ ] Critical paths covered
- [ ] Integration tests pass

### Documentation

- [ ] README updated
- [ ] API endpoints documented
- [ ] Migration process documented
- [ ] Testing process documented
- [ ] Known issues documented

---

## 📞 **WHO TO ASK / ESCALATE TO**

### Technical Decisions

- Database schema changes → **Discuss with frontend team**
- API breaking changes → **Notify all stakeholders**
- Performance issues → **Document and prioritize**

### Blockers

- Missing information → **Check existing documentation first**
- Unclear requirements → **Document assumptions and proceed**
- Technical obstacles → **Research, try alternatives, document**

---

## 📚 **RESOURCES & REFERENCES**

### Documentation

- SQLAlchemy: https://docs.sqlalchemy.org/
- FastAPI: https://fastapi.tiangolo.com/
- Alembic: https://alembic.sqlalchemy.org/
- Pytest: https://docs.pytest.org/

### Tools

- Database browser: DB Browser for SQLite
- API testing: Postman or curl
- Code quality: pylint, mypy, black
- Git client: Your preferred tool

### Project Docs

- `TODO.md` - Complete task list
- `REFACTORING_SUMMARY.md` - High-level overview
- `DATABASE_ANALYSIS.md` - Database deep dive
- This file - Week 1 action plan

---

## 💡 **TIPS FOR SUCCESS**

1. **Start with the easiest task** - Build momentum
2. **Commit often** - Small, focused commits
3. **Test as you go** - Don't save testing for the end
4. **Document while fresh** - Write docs immediately after implementing
5. **Ask for help early** - Don't spin wheels for hours
6. **Take breaks** - Better work in focused 90-minute blocks
7. **Review before committing** - Quick self-code review catches bugs
8. **Keep TODO.md updated** - Check off items as you complete them

---

## 🎉 **CELEBRATION POINTS**

- ✨ First migration created
- ✨ First test passing
- ✨ First index added and verified faster
- ✨ Database fully documented
- ✨ Week 1 goals achieved

---

**Ready to start?** Begin with Day 1, Morning session!

**Questions?** Review the TODO.md and other documentation files first.

**Stuck?** Document the issue and move to the next task. Come back with fresh eyes.

---

**Last Updated:** January 17, 2026  
**Sprint Duration:** January 17-21, 2026 (5 days)  
**Next Sprint Planning:** January 21, 2026

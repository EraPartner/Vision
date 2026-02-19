# Raw Transaction Architecture Overhaul

## Date: 2026-02-19

## Context

The current system stores raw CSV data and deduplication hashes within the normalized `transactions` table. This creates
unnecessary complexity and mixes concerns of raw data storage with business logic.

## Decision

Implement a source-of-truth architecture with bank-specific raw transaction tables.

## Architecture

### Raw Transaction Tables (Source of Truth)

Each bank will have its own immutable, append-only table containing the exact CSV structure:

1. **belfius_raw_transactions**
    - All CSV columns as-is
    - Deduplication hash for exact duplicate detection
    - Import batch tracking
    - Immutable (no updates, only inserts)

2. **revolut_raw_transactions**
    - All CSV columns as-is
    - Deduplication hash
    - Import batch tracking
    - Immutable

3. **kbc_raw_transactions**
    - All CSV columns as-is
    - Deduplication hash
    - Import batch tracking
    - Immutable

### Normalized Transaction Table

- **Removes:** `original_raw_data`, `bank_reference` fields
- **Adds:** Foreign keys to bank-specific raw tables
- Links to raw source via polymorphic relationship or discriminator column

### Data Flow

1. CSV Import → Bank-specific raw table (with deduplication)
2. Raw transaction → Create/update normalized Transaction record
3. Balance calculation → Query raw bank tables
4. Deduplication → Check raw bank table hashes

## Benefits

1. **Separation of Concerns:** Raw data storage separate from business logic
2. **Immutability:** Raw tables are append-only, preserving exact CSV data
3. **Flexibility:** Each bank can have custom fields without polluting Transaction table
4. **Audit Trail:** Complete history of raw imports
5. **Performance:** Deduplication at source level is more efficient
6. **Data Integrity:** Original CSV data preserved exactly as imported

## Implementation Phases

### Phase 1: Database Models

- Create bank-specific raw transaction models
- Add migration scripts
- Update Transaction model to reference raw tables

### Phase 2: Import Service Refactor

- Update bank adapters to map to raw table schemas
- Implement raw table insertion with deduplication
- Update transaction creation to link raw records

### Phase 3: Repository Layer

- Create raw transaction repositories
- Update transaction repository to handle raw references
- Implement balance calculation services

### Phase 4: API Layer

- Update import endpoints
- Add raw transaction query endpoints (read-only)
- Update transaction schemas

### Phase 5: Migration & Testing

- Data migration script for existing transactions
- Comprehensive test suite
- Rollback procedures

## Technical Details

### Polymorphic Raw Transaction Reference

Two approaches:

1. **Discriminator Column:** `raw_transaction_source` + `raw_transaction_id`
2. **Separate FK Columns:** `belfius_raw_id`, `revolut_raw_id`, `kbc_raw_id` (only one populated)

Decision: Use discriminator approach for cleaner schema and extensibility.

### Deduplication Strategy

- Hash computed from ALL raw CSV columns
- Stored in raw transaction table
- Check before insert
- No duplicate raw transactions allowed

### Balance Calculation

- Query raw bank table for account
- Order by date + original row order
- Calculate running balance from transactions
- Cache results for performance

## Rollback Plan

- Keep original schema in migration
- Maintain backward compatibility during transition
- Feature flag for new architecture
- Gradual rollout per bank

## Status

**Phase:** Planning Complete → Implementation Starting
**Next:** Phase 1 - Database Models


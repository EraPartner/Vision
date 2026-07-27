---
title: API - Attachments
type: endpoint
method: GET, POST, DELETE
path: /api/attachments
description: Manage receipt and document attachments for transactions
date: 2026-04-24
updated: 2026-04-25
tags: [api, attachments, receipts, files, storage, phase-5a, security, path-traversal, rfc-5987]
status: active
aliases: [attachments-api, receipts, documents, file-management]
related_code: ["apps/node-backend/src/routes/attachments.js", "apps/node-backend/src/services/attachmentService.js", "apps/node-backend/src/repositories/attachmentRepository.js", "apps/frontend/src/components/shared/AttachmentPanel.tsx"]
---

# Attachments API

## Overview

The Attachments API provides CRUD operations for managing receipt and document attachments associated with transactions. Attachments are stored on disk with metadata tracked in the database.

> [!info] File Storage (Phase 5A)
> Attachments are stored in a configurable directory (`ATTACHMENTS_DIR`, default `./data/attachments`) organized by transaction ID. Database stores relative file paths and metadata (MIME type, file size).

## Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `ATTACHMENTS_DIR` | `./data/attachments` | Base directory for attachment storage |
| `ATTACHMENT_MAX_SIZE_MB` | `10` | Maximum file size in megabytes |

## Endpoints

### POST /api/attachments/transaction/:id

Upload a file attachment to a transaction.

**Path Parameters:**
- `id` (integer, required): Transaction ID

**Request Body:**
- `file` (multipart form data, required): File to upload (binary stream)

**Response (201 Created):**
```json
{
  "id": 42,
  "transaction_id": 123,
  "stored_path": "123/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 245680,
  "created_at": "2026-04-24T14:30:00Z"
}
```

**Error Responses:**
- `400` Bad Request — File missing or exceeds size limit
- `404` Not Found — Transaction does not exist
- `500` Internal Server Error — Storage failure

### GET /api/attachments/transaction/:id

List attachments for a transaction.

**Path Parameters:**
- `id` (integer, required): Transaction ID

**Query Parameters:**
- `limit` (integer, optional, capped at 1000): page size
- `offset` (integer, optional, default 0): rows to skip

Pagination is opt-in — with neither param the response lists every attachment on the
transaction and `total` is that count. With either, the body also carries `limit` and
`offset`, and `total` stays the full attachment count.

**Response (200 OK):**
```json
{
  "items": [
    {
      "id": 42,
      "transaction_id": 123,
      "stored_path": "123/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 245680,
      "created_at": "2026-04-24T14:30:00Z"
    },
    {
      "id": 43,
      "transaction_id": 123,
      "stored_path": "123/b2c3d4e5-f6a7-8901-bcde-f12345678901.png",
      "mime_type": "image/png",
      "size_bytes": 89214,
      "created_at": "2026-04-24T14:31:00Z"
    }
  ],
  "total": 2
}
```

**Error Responses:**
- `404` Not Found — Transaction does not exist

### GET /api/attachments/:id/download

Download (stream) an attachment file by its ID.

**Path Parameters:**
- `id` (integer, required): Attachment ID

**Query Parameters:**
- None

**Response (200 OK):**
- Raw file content with appropriate `Content-Type` header
- `Content-Disposition` header using RFC 5987 dual-encoding for filename:
  - ASCII fallback: `filename="sanitized_ascii_name"` (non-printable, quotes, and backslashes replaced with `_`)
  - UTF-8 with encoding: `filename*=UTF-8''percent%2Dencoded%20name`
  - Clients supporting RFC 5987 use the UTF-8 form; others fall back to ASCII
  - Example: `Content-Disposition: inline; filename="receipt.pdf"; filename*=UTF-8''re%C3%A7u.pdf`

> [!info] RFC 5987 Compliance (April 2026)
> Non-ASCII filenames are transmitted safely to all clients via dual encoding. This prevents issues with filename corruption in older browsers while providing proper UTF-8 handling in modern ones.

**Error Responses:**
- `404` Not Found — Attachment or file does not exist
- `500` Internal Server Error — File read failure

### DELETE /api/attachments/:id

Delete an attachment and remove the file from disk.

**Path Parameters:**
- `id` (integer, required): Attachment ID

**Request Body:**
- None

**Response (204 No Content):**
- Success with empty body

**Error Responses:**
- `404` Not Found — Attachment does not exist
- `500` Internal Server Error — File deletion failure

## Storage Details

### File Organization
Files are stored in a hierarchical structure:
```
ATTACHMENTS_DIR/
├── {transaction_id}/
│   ├── {uuid}.pdf
│   ├── {uuid}.png
│   └── {uuid}.jpg
└── {other_transaction_id}/
    └── {uuid}.docx
```

### Path Traversal Protection

The attachment service validates all file paths before reading or writing:

```javascript
// In resolveAbsolutePath(storedPath):
// Throws 'Invalid attachment path: outside attachments root' if:
// - resolved path does not equal root, AND
// - resolved path does not start with root + path separator
```

This prevents directory traversal attacks (e.g., stored paths like `../../../etc/passwd`). The `sep` is imported from `node:path` to handle OS-specific separators correctly (Windows vs. POSIX).

### Metadata Schema
```sql
CREATE TABLE attachments (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  stored_path VARCHAR NOT NULL,      -- Relative path: {txId}/{uuid}.ext
  mime_type VARCHAR,                  -- e.g., "application/pdf"
  size_bytes INTEGER,                 -- File size in bytes
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Naming Convention
- UUIDs (v4) prevent filename collisions within a transaction directory
- File extension preserved from original upload for MIME type recovery

## Frontend Integration

### React Component
The [[apps/frontend/src/components/shared/AttachmentPanel.tsx]] component handles file upload, display, and deletion:
- Uses TanStack Query for state management and cache invalidation
- Shows image thumbnails with hover-reveal delete button
- Displays loading state during upload
- Provides user-friendly error messages

### Usage in Transactions
The [[apps/frontend/src/features/transactions/components/TransactionInfoDialog.tsx]] integrates `AttachmentPanel` at the bottom of the transaction detail view.

### API Client
The [[apps/frontend/src/lib/api/attachments.ts]] module provides typed methods:
- `listAttachments(transactionId: number)`
- `uploadAttachment(transactionId: number, file: File)`
- `downloadAttachment(attachmentId: number)`
- `deleteAttachment(attachmentId: number)`

## Related

- [[docs/features/import|Import Feature]] — Phase 5A attachments overview
- [[docs/api/transactions|Transactions API]]
- [[docs/api/index|API Documentation Index]]

---
title: {Endpoint Name}
type: endpoint
status: active
date: {YYYY-MM-DD}
tags: [endpoint, api, {domain}, backend]
description: {Brief description of what this endpoint does}
aliases: [api, endpoint, {resource}]
related_code: ["apps/node-backend/src/routes/{route-file}.js"]
---

# {Endpoint Name}

> [!abstract] Overview
> {One-sentence description of this endpoint's purpose}

## Endpoint Details

| Property | Value |
|----------|-------|
| **Path** | `/api/{resource}` |
| **Methods** | GET, POST, PATCH, DELETE |
| **Authentication** | {None / Session / API Key} |
| **Rate Limit** | {100/min / 30/min / None} |

## Request

### Headers

```
Content-Type: application/json
Authorization: Bearer {token}  # if required
```

### Query Parameters (GET)

| Parameter | Type | Required | Default | Description |
|------------|------|----------|---------|-------------|
| `limit` | integer | No | 50 | Max results (max: 1000) |
| `offset` | integer | No | 0 | Pagination offset |
| `{filter}` | string | No | - | Filter by field |

### Request Body (POST/PATCH)

```json
{
  "field1": "value1",
  "field2": "value2"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field1` | string | Yes | Description |
| `field2` | integer | No | Description |

## Response

### Success (200 OK)

```json
{
  "items": [],
  "total": 0,
  "limit": 50,
  "offset": 0,
  "links": []
}
```

### Created (201)

```json
{
  "id": 1,
  "field1": "value1"
}
```

### Error Responses

| Status | Description |
|--------|-------------|
| 400 | Validation error |
| 404 | Resource not found |
| 429 | Rate limited |

```json
{
  "detail": "Error message"
}
```

## Examples

### cURL

```bash
curl -X GET "http://localhost:3002/api/{resource}" \
  -H "Content-Type: application/json"
```

### JavaScript

```javascript
const response = await apiClient.getResource();
```

## Related

- [[docs/api/index|API Index]]
- [[docs/reference/error-codes|Error Codes]]
- [[docs/features/{feature}|{Feature} Feature]]
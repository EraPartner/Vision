# Logging System Documentation

## Overview
All logging in the Vault Voyager frontend uses a consistent JSON format for easy parsing, filtering, and analysis.

## Log Format
Every log entry is a JSON object with the following structure:

```json
{
  "level": "info",
  "type": "api_request",
  "timestamp": "2026-02-07T10:30:45.123Z",
  "...additional fields..."
}
```

## Log Levels
- **debug**: Development/debugging information
- **info**: General informational messages
- **warn**: Warning messages
- **error**: Error messages

## Log Types

### Application Lifecycle
- `app_start`: Application initialization
  ```json
  {
    "level": "info",
    "type": "app_start",
    "environment": "development",
    "apiUrl": "http://localhost:8000",
    "timestamp": "2026-02-07T10:30:45.123Z"
  }
  ```

### Component Events
- `component_render`: Component render event
- `component_state`: Component state snapshot

### API Operations
- `api_request`: Outgoing API request
  ```json
  {
    "level": "info",
    "type": "api_request",
    "method": "GET",
    "url": "http://localhost:8000/api/info",
    "timestamp": "2026-02-07T10:30:45.123Z"
  }
  ```

- `api_response`: API response received
  ```json
  {
    "level": "info",
    "type": "api_response",
    "url": "http://localhost:8000/api/info",
    "status": 200,
    "statusText": "OK",
    "ok": true,
    "timestamp": "2026-02-07T10:30:45.456Z"
  }
  ```

- `api_error`: API error occurred
- `api_data`: API data received (debug level)
- `api_request_failed`: API request failed completely

### Data Fetching
- `data_fetch_start`: Starting to fetch data
- `data_fetch_success`: Data fetch completed successfully
- `data_fetch_error`: Data fetch failed
- `query_success`: React Query success callback

### Testing
- `api_test_start`: API connectivity test started
- `api_test_step`: Individual test step
- `api_test_result`: Test step result
- `api_test_complete`: All tests completed
- `api_test_failed`: Test suite failed

### Hook Events
- `hook_called`: Custom hook invoked

## Using the Logger Utility

### Basic Usage
```typescript
import { logger } from '@/lib/logger';

// Simple logging
logger.info('api_request', { method: 'GET', url: '/api/info' });
logger.error('api_error', { url: '/api/info', error: 'Network error' });

// Convenience methods
logger.apiRequest('GET', 'http://localhost:8000/api/info');
logger.componentRender('Dashboard');
logger.hookCalled('useStatistics', { cached: true });
```

### In Components
```typescript
export default function MyComponent() {
  logger.componentRender('MyComponent');
  
  // Component logic...
}
```

### In API Calls
```typescript
async request() {
  logger.apiRequest('GET', url);
  
  try {
    const response = await fetch(url);
    logger.apiResponse(url, response.status, response.ok);
    return response.json();
  } catch (error) {
    logger.apiError(url, 0, error.message);
    throw error;
  }
}
```

## Filtering Logs in Console

### By Level
```javascript
// Show only errors
console.log = () => {};
console.warn = () => {};

// Show only info and errors
console.log = (msg) => {
  const log = JSON.parse(msg);
  if (log.level === 'info' || log.level === 'error') {
    console.info(msg);
  }
};
```

### By Type
```javascript
// Show only API-related logs
console.log = (msg) => {
  const log = JSON.parse(msg);
  if (log.type.startsWith('api_')) {
    console.info(msg);
  }
};
```

### Using Browser DevTools
1. Open DevTools Console
2. Use the filter box with regex: `"type":"api_`
3. Or filter by level: `"level":"error"`

## Log Analysis

### Extract All Errors
```bash
# In browser console
copy(
  $$('console-message')
    .map(el => el.innerText)
    .filter(text => text.includes('"level":"error"'))
    .map(text => JSON.parse(text))
);
```

### Count by Type
```javascript
const logs = []; // Your logs array
const counts = logs.reduce((acc, log) => {
  acc[log.type] = (acc[log.type] || 0) + 1;
  return acc;
}, {});
console.table(counts);
```

## Best Practices

1. **Always include context**: Add relevant data to help debugging
2. **Use appropriate levels**: Don't log everything as 'info'
3. **Be consistent**: Use the defined log types
4. **Avoid sensitive data**: Don't log passwords, tokens, or PII
5. **Keep it structured**: All logs are JSON - maintain the structure

## Common Patterns

### API Call Sequence
```
{"level":"info","type":"api_request","method":"GET","url":"..."}
{"level":"info","type":"api_response","url":"...","status":200}
{"level":"debug","type":"api_data","url":"...","dataLength":50}
```

### Data Fetch Sequence
```
{"level":"debug","type":"hook_called","hook":"useStatistics"}
{"level":"info","type":"data_fetch_start","resource":"statistics"}
{"level":"info","type":"api_request","method":"GET","url":"..."}
{"level":"info","type":"api_response","url":"...","status":200}
{"level":"info","type":"data_fetch_success","resource":"statistics"}
```

### Error Sequence
```
{"level":"info","type":"api_request","method":"GET","url":"..."}
{"level":"error","type":"api_error","url":"...","status":500}
{"level":"error","type":"data_fetch_error","resource":"statistics"}
```

## Performance Considerations

- Logs are synchronous and can impact performance if excessive
- Use `debug` level for verbose logging (can be filtered in production)
- Consider implementing log batching for production environments
- Use console filters to reduce noise during development

## Future Enhancements

- [ ] Add log persistence (localStorage/IndexedDB)
- [ ] Implement log batching and remote sending
- [ ] Add performance metrics (request duration, render time)
- [ ] Create log analysis dashboard
- [ ] Add user session tracking
- [ ] Implement log rotation

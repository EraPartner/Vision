import { describe, it, expect } from 'vitest';
import { ApiErrorCode } from '@vision/types';

import { ApiClientError } from '@/lib/api/client';
import { API_ERROR_KEYS, apiErrorToMessage, isAuthoredMessage } from '@/lib/api/errorMessage';
import en from '@/locales/en';
import nl from '@/locales/nl';

/** Identity `t` — assertions read as i18n keys rather than brittle English copy. */
const t = (key: string) => key;

function apiError(status: number, code: string, message: string, details?: unknown): ApiClientError {
    return new ApiClientError({ status, code: code as never, message, details });
}

describe('apiErrorToMessage — ApiClientError codes', () => {
    it.each([
        [ApiErrorCode.VALIDATION_ERROR, 422, 'Validation error: body.ids.0: field required', API_ERROR_KEYS.validation],
        [ApiErrorCode.NOT_FOUND, 404, 'Request failed (status 404)', API_ERROR_KEYS.notFound],
        [ApiErrorCode.CONFLICT, 409, 'Request failed (status 409)', API_ERROR_KEYS.conflict],
        [ApiErrorCode.UNAUTHORIZED, 401, 'Request failed (status 401)', API_ERROR_KEYS.unauthorized],
        [ApiErrorCode.FORBIDDEN, 403, 'Request failed (status 403)', API_ERROR_KEYS.forbidden],
        [ApiErrorCode.RATE_LIMITED, 429, 'Too many requests. Please try again in 30 seconds.', API_ERROR_KEYS.rateLimited],
        [ApiErrorCode.INTERNAL_SERVER_ERROR, 500, 'Request failed (status 500)', API_ERROR_KEYS.server],
        [ApiErrorCode.BAD_GATEWAY, 502, 'Request failed (status 502)', API_ERROR_KEYS.server],
        [ApiErrorCode.SERVICE_UNAVAILABLE, 503, 'Request failed (status 503)', API_ERROR_KEYS.server],
        [ApiErrorCode.APP_ERROR, 400, 'Request failed (status 400)', API_ERROR_KEYS.unknown],
    ])('maps %s to %s', (code, status, message, expected) => {
        expect(apiErrorToMessage(apiError(status, code, message), t)).toBe(expected);
    });

    it('never leaks the raw FastAPI loc-path join from a 422', () => {
        const err = apiError(422, ApiErrorCode.VALIDATION_ERROR, 'Validation error: body.ids.0: field required', [
            { loc: ['body', 'ids', 0], msg: 'field required' },
        ]);
        const out = apiErrorToMessage(err, t);
        expect(out).toBe(API_ERROR_KEYS.validation);
        expect(out).not.toContain('body.ids');
    });

    it('falls back to the server bucket for an unrecognised code on a 5xx', () => {
        expect(apiErrorToMessage(apiError(500, 'WEIRD_CODE', 'Request failed (status 500)'), t)).toBe(
            API_ERROR_KEYS.server,
        );
    });

    it('falls back to the unknown bucket for an unrecognised code on a machine-worded 4xx', () => {
        expect(apiErrorToMessage(apiError(418, 'WEIRD_CODE', 'Request failed (status 418)'), t)).toBe(
            API_ERROR_KEYS.unknown,
        );
    });
});

describe('apiErrorToMessage — authored backend copy', () => {
    it('passes a backend-authored 400 detail through verbatim', () => {
        const detail = 'statement_balance_date is required when a statement balance is set';
        expect(apiErrorToMessage(apiError(400, ApiErrorCode.VALIDATION_ERROR, detail), t)).toBe(detail);
    });

    it('passes a backend-authored 409 detail through verbatim', () => {
        const detail = 'An account named "Savings" already exists.';
        expect(apiErrorToMessage(apiError(409, ApiErrorCode.CONFLICT, detail), t)).toBe(detail);
    });

    it('trims surrounding whitespace on an authored detail', () => {
        expect(apiErrorToMessage(apiError(404, ApiErrorCode.NOT_FOUND, '  That batch was rolled back.  '), t)).toBe(
            'That batch was rolled back.',
        );
    });

    it('never passes 5xx text through, however human it reads', () => {
        const err = apiError(500, ApiErrorCode.INTERNAL_SERVER_ERROR, 'psycopg2.OperationalError: connection refused');
        expect(apiErrorToMessage(err, t)).toBe(API_ERROR_KEYS.server);
    });

    it('never passes rate-limit text through', () => {
        const err = apiError(429, ApiErrorCode.RATE_LIMITED, 'Slow down, you have made 500 requests.');
        expect(apiErrorToMessage(err, t)).toBe(API_ERROR_KEYS.rateLimited);
    });

    it('uses generic validation copy when the 4xx carries no message', () => {
        expect(apiErrorToMessage(apiError(422, ApiErrorCode.VALIDATION_ERROR, '   '), t)).toBe(
            API_ERROR_KEYS.validation,
        );
    });
});

describe('apiErrorToMessage — raw transport errors', () => {
    it.each([
        ['Chrome', new TypeError('Failed to fetch')],
        ['Safari', new TypeError('Load failed')],
        ['Firefox', new TypeError('NetworkError when attempting to fetch resource.')],
    ])('maps the %s network failure to the network bucket', (_browser, err) => {
        expect(apiErrorToMessage(err, t)).toBe(API_ERROR_KEYS.network);
    });

    it('maps a non-TypeError with browser network wording to the network bucket', () => {
        expect(apiErrorToMessage(new Error('Network request failed'), t)).toBe(API_ERROR_KEYS.network);
    });

    it('maps any bare TypeError to the network bucket rather than showing its message', () => {
        const out = apiErrorToMessage(new TypeError("Cannot read properties of undefined (reading 'x')"), t);
        expect(out).toBe(API_ERROR_KEYS.network);
        expect(out).not.toContain('undefined');
    });

    it('maps the client timeout sentinel to the timeout bucket', () => {
        expect(apiErrorToMessage(new Error('Request timed out'), t)).toBe(API_ERROR_KEYS.timeout);
    });

    it('maps an AbortError (a DOMException, not an Error) to the cancelled bucket', () => {
        const abort = { name: 'AbortError', message: 'signal is aborted without reason' };
        expect(apiErrorToMessage(abort, t)).toBe(API_ERROR_KEYS.cancelled);
    });

    it('maps retry exhaustion on a 5xx to the server bucket', () => {
        expect(apiErrorToMessage(new Error('Server returned 503'), t)).toBe(API_ERROR_KEYS.server);
    });

    it('maps retry exhaustion on a 429 to the rate-limited bucket', () => {
        expect(apiErrorToMessage(new Error('Server returned 429'), t)).toBe(API_ERROR_KEYS.rateLimited);
    });

    it('maps retry exhaustion on a non-5xx status to the unknown bucket', () => {
        expect(apiErrorToMessage(new Error('Server returned 408'), t)).toBe(API_ERROR_KEYS.unknown);
    });

    it('maps the bare "Request failed" fallback to the unknown bucket', () => {
        expect(apiErrorToMessage(new Error('Request failed'), t)).toBe(API_ERROR_KEYS.unknown);
    });
});

describe('apiErrorToMessage — app-thrown and junk values', () => {
    it('passes an app-authored guard message through verbatim', () => {
        expect(apiErrorToMessage(new Error('Pick at least one account first'), t)).toBe(
            'Pick at least one account first',
        );
    });

    it.each([
        ['a plain string', 'kaboom'],
        ['null', null],
        ['undefined', undefined],
        ['a number', 42],
        ['a bare object', {}],
        ['an Error with an empty message', new Error('')],
    ])('maps %s to the unknown bucket', (_label, value) => {
        expect(apiErrorToMessage(value, t)).toBe(API_ERROR_KEYS.unknown);
    });
});

describe('isAuthoredMessage', () => {
    it.each([
        'Validation error: body.ids.0: field required',
        'Request failed (status 500)',
        'Server returned 503',
        'Request failed',
        'Request timed out',
        'Failed to fetch',
        'Load failed',
        'NetworkError when attempting to fetch resource.',
        '',
        '   ',
    ])('rejects the machine-generated message %j', (message) => {
        expect(isAuthoredMessage(message)).toBe(false);
    });

    it.each(['Account already closed.', 'statement_balance_date is required'])(
        'accepts the authored message %j',
        (message) => {
            expect(isAuthoredMessage(message)).toBe(true);
        },
    );

    it('rejects non-string input', () => {
        expect(isAuthoredMessage(undefined)).toBe(false);
        expect(isAuthoredMessage(7)).toBe(false);
    });
});

describe('copy coverage', () => {
    const keys = Object.values(API_ERROR_KEYS);

    it.each(keys)('%s has English copy', (key) => {
        expect(en[key]).toBeTruthy();
    });

    it.each(keys)('%s has Dutch copy', (key) => {
        expect(nl[key]).toBeTruthy();
    });

    it('resolves real copy, not the key, through a dictionary-backed t', () => {
        const translate = (key: string) => en[key] ?? key;
        const message = apiErrorToMessage(new TypeError('Failed to fetch'), translate);
        expect(message).toBe(en['apiError.network']);
        expect(message).not.toBe('Failed to fetch');
    });
});

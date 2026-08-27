import { describe, expect, it } from 'vitest';
import { makeValidationError } from '../src/lib/repositoryErrors.js';

describe('makeValidationError', () => {
  it('preserves the message and attaches the repository validation code', () => {
    const error = makeValidationError('bad input');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('bad input');
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

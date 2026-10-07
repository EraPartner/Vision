/**
 * Build the coded validation error used by repository-owned input checks.
 */
export function makeValidationError(message: string): Error & { code?: string } {
  const error: Error & { code?: string } = new Error(message);
  error.code = 'VALIDATION_ERROR';
  return error;
}

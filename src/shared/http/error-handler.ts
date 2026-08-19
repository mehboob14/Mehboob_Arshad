import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { DomainError } from '../domain/errors.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
}

export function mapError(error: unknown): MappedError {
  if (error instanceof DomainError) {
    return {
      status: error.httpStatus,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request payload is invalid.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
    };
  }

  // Errors raised before a controller is reached - a body that is not valid
  // JSON, or one over the size limit - already carry the status they deserve.
  // Without this they fell through to 500, which told the client the server had
  // broken when in fact the request had, hid the size limit entirely, and let
  // any anonymous caller drive the 5xx rate with malformed input.
  const middlewareStatus = statusOf(error);
  if (middlewareStatus !== null) {
    return {
      status: middlewareStatus,
      body: { error: { code: 'VALIDATION_FAILED', message: 'Request body could not be read.' } },
    };
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
  };
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 500 ? value : null;
}

/** True for failures a retry could plausibly resolve, rather than reproduce. */
export function isTransient(error: unknown): boolean {
  if (error instanceof ZodError) return false;
  if (error instanceof DomainError) return error.retryable;
  return statusOf(error) === null;
}

export function errorHandler(logger: (error: unknown) => void): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) logger(error);
    res.status(mapped.status).json(mapped.body);
  };
}

import type { RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;
}

const userId = z.string().uuid();

/**
 * Authentication is out of scope for this exercise, so identity is asserted by
 * the caller. It is isolated here precisely so that swapping it for real token
 * verification touches one file and no business logic.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const parsed = userId.safeParse(req.header('x-user-id'));
  if (!parsed.success) {
    throw new UnauthenticatedError('A valid X-User-Id header is required.');
  }
  req.userId = parsed.data;
  next();
};

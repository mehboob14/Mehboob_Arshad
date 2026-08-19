import type { Request, RequestHandler, Response } from 'express';

export interface HttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Controllers return a value instead of writing to the response. Everything
 * that decorates a controller (idempotency, in future rate limiting or
 * caching) is then plain function composition rather than response
 * interception, and every controller is unit-testable without a server.
 */
export type Controller = (req: Request) => Promise<HttpResult>;

export function route(controller: Controller): RequestHandler {
  return async (req: Request, res: Response) => {
    const result = await controller(req);
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    if (result.body === undefined) res.status(result.status).end();
    else res.status(result.status).json(result.body);
  };
}

/** Shape of a returned row. Deliberately structural: a caller declares the
 *  columns it selected, and nothing forces those declarations to carry an
 *  index signature. */
export type Row = object;

/**
 * A handle on a database session. Ports declare it so that a use case can span
 * several repositories inside one transaction without any layer above
 * infrastructure knowing which driver is underneath.
 */
export interface UnitOfWork {
  query<R extends Row>(sql: string, params?: readonly unknown[]): Promise<R[]>;
}

export interface TransactionManager {
  withTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

export class UniqueViolationError extends Error {
  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`);
    this.name = 'UniqueViolationError';
  }
}

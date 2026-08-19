import pg from 'pg';
import type { Row, TransactionManager, UnitOfWork } from './unit-of-work.js';
import { UniqueViolationError } from './unit-of-work.js';

const UNIQUE_VIOLATION = '23505';

interface Queryable {
  query<R extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<pg.QueryResult<R>>;
}

function translate(error: unknown): unknown {
  if (error instanceof Error && 'code' in error && error.code === UNIQUE_VIOLATION) {
    return new UniqueViolationError((error as { constraint?: string }).constraint);
  }
  return error;
}

class Session implements UnitOfWork {
  constructor(private readonly db: Queryable) {}

  async query<R extends Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    try {
      const result = await this.db.query<R & pg.QueryResultRow>(sql, [...params]);
      return result.rows;
    } catch (error) {
      throw translate(error);
    }
  }
}

export class PostgresDatabase implements UnitOfWork, TransactionManager {
  private readonly pool: pg.Pool;
  private readonly session: Session;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
    this.session = new Session(this.pool);
  }

  query<R extends Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.session.query<R>(sql, params);
  }

  async withTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new Session(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

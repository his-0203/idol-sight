// Cloudflare D1 binding type — matches @cloudflare/workers-types.
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}

export async function d1Query<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  const r = await bound.all<T>();
  return r.results ?? [];
}

export async function d1QueryOne<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  return (await bound.first<T>()) ?? null;
}

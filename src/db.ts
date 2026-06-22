import { neon, type NeonQueryFunction } from "@neondatabase/serverless"

export type Sql = NeonQueryFunction<false, false>

export type SchemaInfo = {
  reports: Set<string>
  payments: Set<string>
}

export function createSql(databaseUrl: string): Sql {
  return neon(databaseUrl)
}

export async function loadSchemaInfo(sql: Sql): Promise<SchemaInfo> {
  const rows = await sql.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('reports', 'payments')
      ORDER BY table_name, ordinal_position
    `,
  )

  const reports = new Set<string>()
  const payments = new Set<string>()

  for (const row of rows as { table_name: string; column_name: string }[]) {
    if (row.table_name === "reports") reports.add(row.column_name)
    if (row.table_name === "payments") payments.add(row.column_name)
  }

  return { reports, payments }
}

export async function withAdvisoryLock<T>(
  sql: Sql,
  lockKey: number,
  fn: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const lockRows = await sql.query(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [lockKey],
  )
  const acquired = Boolean((lockRows[0] as { acquired?: boolean })?.acquired)
  if (!acquired) return { acquired: false }

  try {
    const result = await fn()
    return { acquired: true, result }
  } finally {
    await sql.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey])
  }
}

export function hasColumn(schema: SchemaInfo, table: keyof SchemaInfo, column: string) {
  return schema[table].has(column)
}


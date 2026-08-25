export async function kernelPost<T = unknown>(url: string, body: unknown = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 0) throw new Error(result.msg || `${url}: code ${result.code}`);
  return result.data as T;
}

export async function querySecretReferenceCounts(): Promise<Record<string, number>> {
  type Row = { secret_id: string; count: number | string };
  const rows = await kernelPost<Row[]>("/api/query/sql", {
    stmt: `SELECT value AS secret_id, COUNT(*) AS count
           FROM attributes
           WHERE name = 'custom-secret-id'
           GROUP BY value`,
  });
  return Object.fromEntries(rows.map((row) => [row.secret_id, Number(row.count) || 0]));
}

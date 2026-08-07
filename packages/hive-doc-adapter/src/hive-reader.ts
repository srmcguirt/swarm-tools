/**
 * Read-only hive access via @libsql/client.
 *
 * Deliberately NOT the swarm-mail HiveAdapter (drizzle-orm, effect, ai-sdk,
 * chokidar, ...) — this package only ever reads, never migrates or writes,
 * so a direct raw-SQL client against the known `beads`/`bead_*` schema
 * (packages/swarm-mail/src/db/schema/hive.ts) is a much lighter dependency
 * footprint for a package meant to eventually be portable.
 *
 * MUST use @libsql/client, never stock `sqlite3`: the `memories` table has
 * a libsql native vector index (F32_BLOB + libsql_vector_idx), and a plain
 * sqlite3 driver's COUNT(*) silently returns 0 against it. This has already
 * produced one false total-data-loss report — see the DB-destruction
 * incident fixture in this package's tests.
 *
 * Every function here is a SELECT. No INSERT/UPDATE/DELETE/migration
 * statement exists anywhere in this module.
 */

import { type Client, createClient } from "@libsql/client";

export interface RawCell {
  id: string;
  project_key: string;
  type: string;
  status: string;
  title: string;
  description: string | null;
  priority: number;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  closed_reason: string | null;
  created_by: string | null;
  result: string | null;
}

export interface HiveReaderOptions {
  /** Path to the swarm.db file, e.g. `~/.config/swarm-tools/swarm.db` (already expanded). */
  dbPath: string;
  projectKey: string;
}

export interface HiveReader {
  getCells(): Promise<RawCell[]>;
  getLabels(cellIds: string[]): Promise<Map<string, string[]>>;
  getAgentNames(): Promise<string[]>;
  /** Row count for `memories`, via COUNT(id) — never COUNT(*) against the vector-indexed table. */
  getMemoryCount(): Promise<number>;
  close(): Promise<void>;
}

function toFileUrl(dbPath: string): string {
  return dbPath.startsWith("file:") ? dbPath : `file:${dbPath}`;
}

export function createHiveReader(options: HiveReaderOptions): HiveReader {
  const client: Client = createClient({ url: toFileUrl(options.dbPath) });

  return {
    async getCells(): Promise<RawCell[]> {
      const result = await client.execute({
        sql: `SELECT id, project_key, type, status, title, description, priority,
                     parent_id, created_at, updated_at, closed_at, closed_reason,
                     created_by, result
              FROM beads
              WHERE project_key = ? AND deleted_at IS NULL
              ORDER BY created_at ASC`,
        args: [options.projectKey],
      });
      return result.rows.map((row) => ({
        id: String(row.id),
        project_key: String(row.project_key),
        type: String(row.type),
        status: String(row.status),
        title: String(row.title),
        description: row.description == null ? null : String(row.description),
        priority: Number(row.priority),
        parent_id: row.parent_id == null ? null : String(row.parent_id),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
        closed_at: row.closed_at == null ? null : Number(row.closed_at),
        closed_reason:
          row.closed_reason == null ? null : String(row.closed_reason),
        created_by: row.created_by == null ? null : String(row.created_by),
        result: row.result == null ? null : String(row.result),
      }));
    },

    async getLabels(cellIds: string[]): Promise<Map<string, string[]>> {
      const map = new Map<string, string[]>();
      if (cellIds.length === 0) return map;
      const placeholders = cellIds.map(() => "?").join(",");
      const result = await client.execute({
        sql: `SELECT cell_id, label FROM bead_labels WHERE cell_id IN (${placeholders})`,
        args: cellIds,
      });
      for (const row of result.rows) {
        const cellId = String(row.cell_id);
        const label = String(row.label);
        const existing = map.get(cellId) ?? [];
        existing.push(label);
        map.set(cellId, existing);
      }
      return map;
    },

    async getAgentNames(): Promise<string[]> {
      try {
        const result = await client.execute("SELECT DISTINCT name FROM agents");
        return result.rows.map((row) => String(row.name)).filter(Boolean);
      } catch {
        // `agents` table may not exist in every deployment; absence is not fatal.
        return [];
      }
    },

    async getMemoryCount(): Promise<number> {
      const result = await client.execute(
        "SELECT COUNT(id) AS n FROM memories",
      );
      return Number(result.rows[0]?.n ?? 0);
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}

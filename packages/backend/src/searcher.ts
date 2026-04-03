import type Database from "better-sqlite3";
import type { PathMapping } from "./config.js";

export interface SearchResult {
  filename: string;
  filepath: string;
  hostPath: string | null;
  extension: string | null;
  sizeBytes: number;
  mtime: string;
  docTitle: string | null;
  score: number;
}

function escapeQuery(keyword: string): string {
  // Remove FTS5 special characters, use prefix matching for better recall
  const cleaned = keyword.replace(/["*(){}[\]^~:]/g, "").trim();
  if (!cleaned) return "";
  // Use prefix matching so "报税" matches "报税2025.pdf"
  return cleaned + "*";
}

export function searchFiles(
  db: Database.Database,
  keywords: string[],
  maxResults: number = 10,
  _pathMap?: PathMapping[],
): SearchResult[] {
  if (keywords.length === 0) return [];

  // Build FTS5 MATCH query: keyword1 OR keyword2 OR ...
  const matchQuery = keywords.map(escapeQuery).join(" OR ");

  const stmt = db.prepare(`
    SELECT
      f.filename, f.filepath, f.host_path, f.extension,
      f.size_bytes, f.mtime, f.doc_title,
      bm25(files_fts, 10.0, 5.0, 8.0, 1.0) AS score
    FROM files_fts
    JOIN files f ON f.id = files_fts.rowid
    WHERE files_fts MATCH @query
    ORDER BY score
    LIMIT @limit
  `);

  const rows = stmt.all({ query: matchQuery, limit: maxResults }) as Array<{
    filename: string;
    filepath: string;
    host_path: string | null;
    extension: string | null;
    size_bytes: number;
    mtime: string;
    doc_title: string | null;
    score: number;
  }>;

  return rows.map((row) => ({
    filename: row.filename,
    filepath: row.filepath,
    hostPath: row.host_path,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    mtime: row.mtime,
    docTitle: row.doc_title,
    score: row.score,
  }));
}

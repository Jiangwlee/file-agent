import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Config, PathMapping } from "./config.js";
import { extractDocTitle } from "./metadata.js";

export interface IndexStats {
  totalFiles: number;
  indexedAt: string;
  dbSizeBytes: number;
}

function toHostPath(filepath: string, pathMap: PathMapping[]): string | null {
  for (const { containerPath, hostPath } of pathMap) {
    if (filepath.startsWith(containerPath)) {
      const relative = filepath.slice(containerPath.length);
      // Convert forward slashes to backslashes for Windows
      return hostPath + relative.replace(/\//g, "\\");
    }
  }
  return null;
}

function extractPathSegments(filepath: string): string {
  // Extract meaningful path segments for search
  return filepath
    .split(/[/\\]/)
    .filter((s) => s && s !== "." && s !== "..")
    .join(" ");
}

export function createDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL UNIQUE,
      host_path TEXT,
      path_segments TEXT,
      extension TEXT,
      size_bytes INTEGER,
      mtime TEXT,
      doc_title TEXT,
      indexed_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      filename, path_segments, doc_title, extension,
      content=files, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, filename, path_segments, doc_title, extension)
      VALUES (new.id, new.filename, COALESCE(new.path_segments, ''),
              COALESCE(new.doc_title, ''), COALESCE(new.extension, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, filename, path_segments, doc_title, extension)
      VALUES ('delete', old.id, old.filename, COALESCE(old.path_segments, ''),
              COALESCE(old.doc_title, ''), COALESCE(old.extension, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, filename, path_segments, doc_title, extension)
      VALUES ('delete', old.id, old.filename, COALESCE(old.path_segments, ''),
              COALESCE(old.doc_title, ''), COALESCE(old.extension, ''));
      INSERT INTO files_fts(rowid, filename, path_segments, doc_title, extension)
      VALUES (new.id, new.filename, COALESCE(new.path_segments, ''),
              COALESCE(new.doc_title, ''), COALESCE(new.extension, ''));
    END;
  `);

  return db;
}

function* walkDir(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Skip unreadable directories
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

export function buildIndex(db: Database.Database, config: Config): IndexStats {
  const now = new Date().toISOString();

  // Collect all existing paths for cleanup
  const existingPaths = new Set<string>();
  const existingRows = db.prepare("SELECT filepath, mtime FROM files").all() as {
    filepath: string;
    mtime: string;
  }[];
  const mtimeMap = new Map<string, string>();
  for (const row of existingRows) {
    existingPaths.add(row.filepath);
    mtimeMap.set(row.filepath, row.mtime);
  }

  const upsert = db.prepare(`
    INSERT INTO files (filename, filepath, host_path, path_segments, extension, size_bytes, mtime, doc_title, indexed_at)
    VALUES (@filename, @filepath, @hostPath, @pathSegments, @extension, @sizeBytes, @mtime, @docTitle, @indexedAt)
    ON CONFLICT(filepath) DO UPDATE SET
      filename=@filename, host_path=@hostPath, path_segments=@pathSegments, extension=@extension,
      size_bytes=@sizeBytes, mtime=@mtime, doc_title=@docTitle, indexed_at=@indexedAt
  `);

  const seenPaths = new Set<string>();
  let count = 0;

  const insertMany = db.transaction(() => {
    for (const scanDir of config.scanDirs) {
      if (!fs.existsSync(scanDir)) continue;
      for (const filepath of walkDir(scanDir)) {
        seenPaths.add(filepath);

        let stat: fs.Stats;
        try {
          stat = fs.statSync(filepath);
        } catch {
          continue;
        }

        const mtime = stat.mtime.toISOString();

        // Skip unchanged files
        if (mtimeMap.get(filepath) === mtime) {
          count++;
          continue;
        }

        const filename = path.basename(filepath);
        const extension = path.extname(filepath).toLowerCase().replace(".", "");

        upsert.run({
          filename,
          filepath,
          hostPath: toHostPath(filepath, config.pathMap),
          pathSegments: extractPathSegments(filepath),
          extension,
          sizeBytes: stat.size,
          mtime,
          docTitle: null,
          indexedAt: now,
        });
        count++;
      }
    }

    // Remove deleted files
    const deletePath = db.prepare("DELETE FROM files WHERE filepath = ?");
    for (const existing of existingPaths) {
      if (!seenPaths.has(existing)) {
        deletePath.run(existing);
      }
    }
  });

  insertMany();

  return {
    totalFiles: count,
    indexedAt: now,
    dbSizeBytes: fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0,
  };
}

const DOC_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx"]);

/**
 * Async pass: extract document titles for files that support it.
 * Runs after buildIndex to avoid blocking the sync indexing.
 */
export async function enrichMetadata(db: Database.Database): Promise<number> {
  const rows = db
    .prepare(
      "SELECT id, filepath, extension FROM files WHERE doc_title IS NULL AND extension IN ('pdf','docx','xlsx','pptx')",
    )
    .all() as Array<{ id: number; filepath: string; extension: string }>;

  if (rows.length === 0) return 0;

  const update = db.prepare("UPDATE files SET doc_title = @title WHERE id = @id");
  let enriched = 0;

  // Process in batches to avoid memory pressure
  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const title = await extractDocTitle(row.filepath, row.extension);
        return { id: row.id, title };
      }),
    );

    const updateMany = db.transaction(() => {
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.title) {
          update.run({ id: result.value.id, title: result.value.title });
          enriched++;
        }
      }
    });
    updateMany();
  }

  return enriched;
}

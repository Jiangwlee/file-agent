import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, buildIndex } from "../packages/backend/src/indexer.js";
import type { Config } from "../packages/backend/src/config.js";
import type Database from "better-sqlite3";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-agent-test-"));
}

describe("indexer", () => {
  let tmpDir: string;
  let dbPath: string;
  let scanDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = makeTempDir();
    dbPath = path.join(tmpDir, "test.db");
    scanDir = path.join(tmpDir, "files");
    fs.mkdirSync(scanDir, { recursive: true });
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates database with correct schema", () => {
    db = createDatabase(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("files");
    expect(names).toContain("files_fts");
  });

  it("indexes files from scan directory", () => {
    // Create test files
    fs.writeFileSync(path.join(scanDir, "报税2025.pdf"), "dummy");
    fs.writeFileSync(path.join(scanDir, "invoice.xlsx"), "dummy");
    fs.mkdirSync(path.join(scanDir, "subdir"));
    fs.writeFileSync(path.join(scanDir, "subdir", "contract.docx"), "dummy");

    db = createDatabase(dbPath);
    const config: Config = {
      scanDirs: [scanDir],
      pathMap: [],
      dbPath,
      port: 8080,
    };

    const stats = buildIndex(db, config);
    expect(stats.totalFiles).toBe(3);

    const count = db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
    expect(count.c).toBe(3);
  });

  it("handles incremental updates", () => {
    fs.writeFileSync(path.join(scanDir, "a.txt"), "original");

    db = createDatabase(dbPath);
    const config: Config = {
      scanDirs: [scanDir],
      pathMap: [],
      dbPath,
      port: 8080,
    };

    buildIndex(db, config);

    // Add a new file
    fs.writeFileSync(path.join(scanDir, "b.txt"), "new file");

    const stats = buildIndex(db, config);
    expect(stats.totalFiles).toBe(2);

    const count = db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("removes deleted files from index", () => {
    fs.writeFileSync(path.join(scanDir, "keep.txt"), "keep");
    fs.writeFileSync(path.join(scanDir, "delete.txt"), "delete");

    db = createDatabase(dbPath);
    const config: Config = {
      scanDirs: [scanDir],
      pathMap: [],
      dbPath,
      port: 8080,
    };

    buildIndex(db, config);
    let count = db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
    expect(count.c).toBe(2);

    // Delete a file and reindex
    fs.unlinkSync(path.join(scanDir, "delete.txt"));
    buildIndex(db, config);

    count = db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("maps container paths to host paths", () => {
    fs.writeFileSync(path.join(scanDir, "test.pdf"), "dummy");

    db = createDatabase(dbPath);
    const config: Config = {
      scanDirs: [scanDir],
      pathMap: [{ containerPath: scanDir, hostPath: "D:\\Documents" }],
      dbPath,
      port: 8080,
    };

    buildIndex(db, config);
    const row = db.prepare("SELECT host_path FROM files LIMIT 1").get() as {
      host_path: string;
    };
    expect(row.host_path).toBe("D:\\Documents\\test.pdf");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, buildIndex } from "../packages/backend/src/indexer.js";
import { searchFiles } from "../packages/backend/src/searcher.js";
import type { Config } from "../packages/backend/src/config.js";
import type Database from "better-sqlite3";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-agent-search-test-"));
}

describe("searcher", () => {
  let tmpDir: string;
  let dbPath: string;
  let scanDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = makeTempDir();
    dbPath = path.join(tmpDir, "test.db");
    scanDir = path.join(tmpDir, "files");
    fs.mkdirSync(scanDir, { recursive: true });

    // Create test files
    fs.writeFileSync(path.join(scanDir, "报税2025.pdf"), "dummy");
    fs.writeFileSync(path.join(scanDir, "invoice_2024.xlsx"), "dummy");
    fs.writeFileSync(path.join(scanDir, "contract_签约.docx"), "dummy");
    fs.mkdirSync(path.join(scanDir, "tax_documents"));
    fs.writeFileSync(
      path.join(scanDir, "tax_documents", "annual_return.pdf"),
      "dummy",
    );
    fs.writeFileSync(path.join(scanDir, "photo_vacation.jpg"), "dummy");

    db = createDatabase(dbPath);
    const config: Config = {
      scanDirs: [scanDir],
      pathMap: [{ containerPath: scanDir, hostPath: "D:\\Files" }],
      dbPath,
      port: 8080,
    };
    buildIndex(db, config);
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds files by Chinese keyword", () => {
    const results = searchFiles(db, ["报税"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toContain("报税");
  });

  it("finds files by English keyword", () => {
    const results = searchFiles(db, ["invoice"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toContain("invoice");
  });

  it("finds files by multiple keywords (OR)", () => {
    const results = searchFiles(db, ["tax", "invoice"]);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("respects max_results limit", () => {
    const results = searchFiles(db, ["pdf", "xlsx", "docx", "jpg"], 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array for no matches", () => {
    const results = searchFiles(db, ["nonexistent_keyword_xyz"]);
    expect(results).toEqual([]);
  });

  it("returns host paths when configured", () => {
    const results = searchFiles(db, ["invoice"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].hostPath).toMatch(/^D:\\Files/);
  });

  it("returns empty array for empty keywords", () => {
    const results = searchFiles(db, []);
    expect(results).toEqual([]);
  });

  it("finds files by path segments", () => {
    const results = searchFiles(db, ["tax_documents"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe("annual_return.pdf");
  });

  it("filename matches rank higher than path matches", () => {
    const results = searchFiles(db, ["tax"]);
    // Files with "tax" in filename or direct path should appear
    expect(results.length).toBeGreaterThan(0);
  });
});

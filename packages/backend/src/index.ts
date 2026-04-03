import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "./config.js";
import { buildIndex, createDatabase, enrichMetadata } from "./indexer.js";
import { createLlmProxy } from "./llm-proxy.js";
import { createOAuthStore } from "./oauth-store.js";
import { searchFiles } from "./searcher.js";

const config = loadConfig();
const oauthStore = createOAuthStore(
  path.join(path.dirname(config.dbPath), "oauth-credentials.json"),
);
const db = createDatabase(config.dbPath);

// Build index on startup
console.log(`Indexing files from: ${config.scanDirs.join(", ")}`);
let lastStats = buildIndex(db, config);
console.log(`Indexed ${lastStats.totalFiles} files`);

// Async metadata enrichment (non-blocking)
enrichMetadata(db).then((n) => {
  if (n > 0) console.log(`Enriched ${n} files with document metadata`);
});

const app = new Hono();

// CORS for dev (frontend on different port)
app.use("/api/*", cors());

// Search API
app.post("/api/search", async (c) => {
  const body = await c.req.json<{ keywords: string[]; max_results?: number }>();
  const { keywords, max_results = 10 } = body;

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return c.json({ error: "keywords must be a non-empty array" }, 400);
  }

  const results = searchFiles(db, keywords, max_results);
  return c.json({ results });
});

// Reindex API
app.post("/api/reindex", async (c) => {
  console.log("Reindexing...");
  lastStats = buildIndex(db, config);
  console.log(`Reindexed ${lastStats.totalFiles} files`);
  enrichMetadata(db).then((n) => {
    if (n > 0) console.log(`Enriched ${n} files with document metadata`);
  });
  return c.json(lastStats);
});

// Stats API
app.get("/api/stats", (c) => {
  const countRow = db.prepare("SELECT COUNT(*) as count FROM files").get() as {
    count: number;
  };
  return c.json({
    ...lastStats,
    totalFiles: countRow.count,
  });
});

// LLM proxy (must be before static files)
app.route("/", createLlmProxy(oauthStore));

// Serve frontend static files in production
app.use("/*", serveStatic({ root: "packages/frontend/dist" }));
// SPA fallback
app.get("/*", serveStatic({ root: "packages/frontend/dist", path: "index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`File Agent server running on http://localhost:${info.port}`);
});

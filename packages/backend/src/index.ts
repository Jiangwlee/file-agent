import path from "node:path";
import fs from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  loadAppConfig,
  resolveAppPaths,
  saveAppConfig,
  type AppConfig,
} from "./app-config.js";
import { loadConfig } from "./config.js";
import { buildIndex, createDatabase, enrichMetadata } from "./indexer.js";
import { InitState } from "./init-state.js";
import { createLlmProxy } from "./llm-proxy.js";
import { createOAuthStore } from "./oauth-store.js";
import { searchFiles } from "./searcher.js";

const initState = new InitState();
const appPaths = resolveAppPaths();
const config = loadConfig();
const oauthStore = createOAuthStore(appPaths.oauthPath);
const db = createDatabase(config.dbPath);

function resolveFrontendRoot(): string {
  if (process.env.FILE_AGENT_FRONTEND_DIST) {
    return process.env.FILE_AGENT_FRONTEND_DIST;
  }
  const distRoot = path.resolve(process.cwd(), "packages/frontend/dist");
  if (fs.existsSync(distRoot)) {
    return distRoot;
  }
  return path.resolve(process.cwd(), "../frontend/dist");
}

function runIndexing(reason: "startup" | "manual") {
  const activeConfig = loadConfig();
  initState.setStatus({
    stage: "building_index",
    message: reason === "startup" ? "正在构建文件索引..." : "正在重建文件索引...",
    error: null,
    progress: {
      currentDirectory: null,
      scannedFiles: 0,
    },
  });
  console.log(`Indexing files from: ${activeConfig.scanDirs.join(", ")}`);

  let stats;
  try {
    stats = buildIndex(db, activeConfig, (progress) => {
      initState.setStatus({
        stage: "building_index",
        message: "正在构建文件索引...",
        progress: {
          currentDirectory: progress.currentDirectory,
          scannedFiles: progress.scannedFiles,
        },
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Indexing failed:", err);
    initState.setStatus({
      stage: "error",
      message: `索引失败: ${message}`,
      error: message,
    });
    throw err;
  }

  enrichMetadata(db)
    .then((n) => {
      if (n > 0) console.log(`Enriched ${n} files with document metadata`);
    })
    .catch((err) => {
      console.error("Metadata enrichment failed:", err);
    });

  initState.setStatus({
    stage: "ready",
    message: "初始化完成",
    progress: {
      currentDirectory: null,
      scannedFiles: stats.totalFiles,
    },
  });
  return stats;
}

initState.setStatus({
  stage: "loading_config",
  message: "正在读取配置...",
});
const appConfig = loadAppConfig(appPaths);
initState.setStatus({
  stage: "checking_ollama",
  message: "正在检查模型配置...",
});
let lastStats = appConfig.indexing.autoReindexOnStartup
  ? runIndexing("startup")
  : {
      totalFiles: 0,
      indexedAt: new Date().toISOString(),
      dbSizeBytes: 0,
    };

if (!appConfig.indexing.autoReindexOnStartup) {
  initState.setStatus({
    stage: "ready",
    message: "初始化完成",
    progress: {
      currentDirectory: null,
      scannedFiles: 0,
    },
  });
}

const frontendRoot = resolveFrontendRoot();

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
let isIndexing = false;
app.post("/api/reindex", async (c) => {
  if (isIndexing) {
    return c.json({ error: "Indexing already in progress" }, 409);
  }
  isIndexing = true;
  try {
    console.log("Reindexing...");
    lastStats = runIndexing("manual");
    console.log(`Reindexed ${lastStats.totalFiles} files`);
    return c.json(lastStats);
  } finally {
    isIndexing = false;
  }
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

app.get("/api/settings", (c) => {
  return c.json(loadAppConfig(appPaths));
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<AppConfig>();
  saveAppConfig(body, appPaths);
  return c.json(body);
});

app.get("/api/app-paths", (c) => {
  return c.json(appPaths);
});

app.get("/api/init-status", (c) => {
  return c.json(initState.getStatus());
});

app.get("/api/init-events", async (c) => {
  return streamSSE(c, async (stream) => {
    const writeStatus = async () => {
      await stream.writeSSE({
        data: JSON.stringify(initState.getStatus()),
      });
    };

    const listener = () => {
      void writeStatus();
    };

    initState.on("update", listener);
    try {
      await writeStatus();

      while (!stream.closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      initState.off("update", listener);
    }
  });
});

// LLM proxy (must be before static files)
app.route("/", createLlmProxy(oauthStore));

// Serve frontend static files in production
app.use("/*", serveStatic({ root: frontendRoot }));
// SPA fallback
app.get("/*", serveStatic({ root: frontendRoot, path: "index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`File Agent server running on http://localhost:${info.port}`);
});

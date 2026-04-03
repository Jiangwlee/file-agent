import path from "node:path";
import { loadAppConfig, resolveAppPaths } from "./app-config.js";

export interface PathMapping {
  containerPath: string;
  hostPath: string;
}

export interface Config {
  scanDirs: string[];
  pathMap: PathMapping[];
  dbPath: string;
  port: number;
}

function parsePathMap(raw: string | undefined): PathMapping[] {
  if (!raw) return [];
  // Format: /data/desktop=C:\Users\name\Desktop,/data/d-drive=D:\
  // Split on first "=" only to handle Windows paths that contain "="
  return raw.split(",").flatMap((pair) => {
    const sep = pair.indexOf("=");
    if (sep === -1) return [];
    return [{ containerPath: pair.slice(0, sep).trim(), hostPath: pair.slice(sep + 1).trim() }];
  });
}

export function loadConfig(): Config {
  const appConfig = loadAppConfig();
  const appPaths = resolveAppPaths();
  const scanDirs = process.env.SCAN_DIRS
    ? process.env.SCAN_DIRS.split(",").map((d) => d.trim())
    : appConfig.scanDirs;

  return {
    scanDirs,
    pathMap: parsePathMap(process.env.PATH_MAP),
    dbPath: process.env.DB_PATH || appPaths.dbPath || path.join(process.cwd(), "data", "file_index.db"),
    port: (() => { const p = parseInt(process.env.FILE_AGENT_PORT || "8080", 10); return isNaN(p) ? 8080 : p; })(),
  };
}

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
  // Format: /data/desktop=C:\Users\bruce\Desktop,/data/d-drive=D:\
  return raw.split(",").map((pair) => {
    const [containerPath, hostPath] = pair.split("=");
    return { containerPath: containerPath.trim(), hostPath: hostPath.trim() };
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
    port: parseInt(process.env.FILE_AGENT_PORT || "8080", 10),
  };
}

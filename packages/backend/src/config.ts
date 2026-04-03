import path from "node:path";

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
  const scanDirs = (process.env.SCAN_DIRS || "/data")
    .split(",")
    .map((d) => d.trim());

  return {
    scanDirs,
    pathMap: parsePathMap(process.env.PATH_MAP),
    dbPath: process.env.DB_PATH || path.join(process.cwd(), "data", "file_index.db"),
    port: parseInt(process.env.FILE_AGENT_PORT || "8080", 10),
  };
}

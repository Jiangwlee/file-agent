import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelConfig {
  provider: "ollama";
  baseUrl: string;
  selectedModelId: string | null;
}

export interface AppConfig {
  model: ModelConfig;
  scanDirs: string[];
  indexing: {
    autoReindexOnStartup: boolean;
  };
}

export interface AppPaths {
  appDataDir: string;
  configPath: string;
  dbPath: string;
  oauthPath: string;
}

const DEFAULT_MODEL_BASE_URL = "http://127.0.0.1:11434";

export function getDefaultScanDirs(): string[] {
  const home = os.homedir();
  return ["Desktop", "Documents", "Downloads"]
    .map((name) => path.join(home, name))
    .filter((dir) => fs.existsSync(dir));
}

export function getDefaultAppConfig(): AppConfig {
  return {
    model: {
      provider: "ollama",
      baseUrl: DEFAULT_MODEL_BASE_URL,
      selectedModelId: null,
    },
    scanDirs: getDefaultScanDirs(),
    indexing: {
      autoReindexOnStartup: true,
    },
  };
}

export function resolveAppPaths(): AppPaths {
  const appDataDir =
    process.env.FILE_AGENT_APP_DATA_DIR ||
    path.join(process.cwd(), "data");

  return {
    appDataDir,
    configPath: path.join(appDataDir, "config.json"),
    dbPath: path.join(appDataDir, "file_index.db"),
    oauthPath: path.join(appDataDir, "oauth-credentials.json"),
  };
}

function ensureAppDir(paths: AppPaths): void {
  if (!fs.existsSync(paths.appDataDir)) {
    fs.mkdirSync(paths.appDataDir, { recursive: true });
  }
}

export function loadAppConfig(paths: AppPaths = resolveAppPaths()): AppConfig {
  ensureAppDir(paths);

  const defaults = getDefaultAppConfig();
  if (!fs.existsSync(paths.configPath)) {
    saveAppConfig(defaults, paths);
    return defaults;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as
      | Partial<AppConfig>
      | undefined;

    return {
      model: {
        provider: "ollama",
        baseUrl: parsed?.model?.baseUrl || defaults.model.baseUrl,
        selectedModelId: parsed?.model?.selectedModelId || null,
      },
      scanDirs:
        parsed?.scanDirs?.filter((dir): dir is string => typeof dir === "string") ||
        defaults.scanDirs,
      indexing: {
        autoReindexOnStartup:
          parsed?.indexing?.autoReindexOnStartup ??
          defaults.indexing.autoReindexOnStartup,
      },
    };
  } catch {
    return defaults;
  }
}

export function saveAppConfig(
  config: AppConfig,
  paths: AppPaths = resolveAppPaths(),
): void {
  ensureAppDir(paths);
  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2), "utf8");
}

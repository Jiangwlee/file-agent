import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_PORT = 4310;
let backendProcess: ChildProcess | null = null;
const electronProcess = process as NodeJS.Process & {
  resourcesPath?: string;
};

function getWorkspaceRoot(): string {
  return path.resolve(__dirname, "../../..");
}

function getBackendCwd(): string {
  return app.isPackaged
    ? electronProcess.resourcesPath || getWorkspaceRoot()
    : getWorkspaceRoot();
}

function getFrontendDist(): string {
  if (app.isPackaged) {
    return path.join(
      electronProcess.resourcesPath || getWorkspaceRoot(),
      "frontend",
    );
  }
  return path.join(getWorkspaceRoot(), "packages/frontend/dist");
}

function getBackendEntrypoint(): string {
  if (app.isPackaged) {
    return path.join(
      electronProcess.resourcesPath || getWorkspaceRoot(),
      "backend",
      "index.js",
    );
  }
  return path.join(getWorkspaceRoot(), "packages/backend/dist/index.js");
}

async function waitForBackend(url: string, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("Backend did not become ready in time.");
}

async function startBackend(): Promise<void> {
  if (backendProcess) return;

  const appDataDir = app.getPath("userData");
  backendProcess = spawn(process.execPath, [getBackendEntrypoint()], {
    cwd: getBackendCwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      FILE_AGENT_APP_DATA_DIR: appDataDir,
      FILE_AGENT_PORT: String(BACKEND_PORT),
      FILE_AGENT_FRONTEND_DIST: getFrontendDist(),
    },
  });

  backendProcess.on("exit", () => {
    backendProcess = null;
  });

  await waitForBackend(`http://127.0.0.1:${BACKEND_PORT}/api/init-status`);
}

async function createMainWindow(): Promise<void> {
  await startBackend();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(`http://127.0.0.1:${BACKEND_PORT}`);
  win.once("ready-to-show", () => {
    win.show();
  });
}

app.whenReady().then(async () => {
  ipcMain.handle("file-agent:select-directories", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  backendProcess?.kill();
});

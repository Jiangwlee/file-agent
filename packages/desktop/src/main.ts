import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_PORT = 4310;
let backendProcess: UtilityProcess | null = null;
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
      "wrapper.cjs",
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
  const entrypoint = getBackendEntrypoint();

  backendProcess = utilityProcess.fork(entrypoint, [], {
    stdio: "pipe",
    env: {
      ...process.env,
      FILE_AGENT_APP_DATA_DIR: appDataDir,
      FILE_AGENT_PORT: String(BACKEND_PORT),
      FILE_AGENT_FRONTEND_DIST: getFrontendDist(),
      FILE_AGENT_CWD: getBackendCwd(),
    },
  });

  // Capture stderr for error reporting
  let stderrOutput = "";
  backendProcess.stderr?.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString();
  });
  backendProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout?.write(chunk);
  });

  // Detect early crash: race between "ready" and "exit"
  const exitPromise = new Promise<never>((_, reject) => {
    backendProcess!.on("exit", (code) => {
      backendProcess = null;
      // Read crash log written by wrapper.cjs
      let crashLog = "";
      try {
        const logPath = path.join(appDataDir, "backend-crash.log");
        crashLog = fs.readFileSync(logPath, "utf-8");
      } catch {
        // No crash log available
      }
      reject(
        new Error(
          `Backend exited with code ${code}.\n` +
            `Entrypoint: ${entrypoint}\n` +
            (crashLog ? `\nCrash log:\n${crashLog}` : `\nStderr:\n${stderrOutput || "(empty)"}`),
        ),
      );
    });
  });

  await Promise.race([
    waitForBackend(`http://127.0.0.1:${BACKEND_PORT}/api/init-status`),
    exitPromise,
  ]);
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

  try {
    await createMainWindow();
  } catch (err) {
    dialog.showErrorBox(
      "FileAgent 启动失败",
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await createMainWindow();
      } catch (err) {
        dialog.showErrorBox(
          "FileAgent 启动失败",
          err instanceof Error ? err.message : String(err),
        );
      }
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

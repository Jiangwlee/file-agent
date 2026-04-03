declare module "electron" {
  export const app: {
    isPackaged: boolean;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): void;
    quit(): void;
    getPath(name: string): string;
  };

  export class BrowserWindow {
    constructor(options: Record<string, unknown>);
    static getAllWindows(): BrowserWindow[];
    loadURL(url: string): Promise<void>;
    once(event: string, listener: () => void): void;
    show(): void;
  }

  export const dialog: {
    showOpenDialog(options: Record<string, unknown>): Promise<{
      canceled: boolean;
      filePaths: string[];
    }>;
  };

  export const ipcMain: {
    handle(
      channel: string,
      listener: (...args: any[]) => any,
    ): void;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>;
  };
}

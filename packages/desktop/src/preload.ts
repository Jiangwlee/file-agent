import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fileAgentDesktop", {
  selectDirectories: (): Promise<string[]> =>
    ipcRenderer.invoke("file-agent:select-directories"),
});

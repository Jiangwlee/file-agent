import { EventEmitter } from "node:events";

export type InitStage =
  | "starting_backend"
  | "loading_config"
  | "checking_ollama"
  | "building_index"
  | "ready"
  | "error";

export interface InitStatus {
  stage: InitStage;
  message: string;
  progress: {
    scannedFiles: number;
    currentDirectory: string | null;
  };
  error: string | null;
  updatedAt: string;
}

export class InitState extends EventEmitter {
  private status: InitStatus = {
    stage: "starting_backend",
    message: "正在启动本地服务...",
    progress: {
      scannedFiles: 0,
      currentDirectory: null,
    },
    error: null,
    updatedAt: new Date().toISOString(),
  };

  getStatus(): InitStatus {
    return this.status;
  }

  setStatus(next: Partial<InitStatus>): void {
    this.status = {
      ...this.status,
      ...next,
      progress: {
        ...this.status.progress,
        ...next.progress,
      },
      updatedAt: new Date().toISOString(),
    };
    this.emit("update", this.status);
  }
}

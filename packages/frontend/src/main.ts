import { Agent, streamProxy } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import {
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
  defaultConvertToLlm,
} from "@mariozechner/pi-web-ui";
import { html, render, nothing } from "lit";
import "./app.css";
import { createSearchFilesTool } from "./tools/search-files.js";
import { registerSearchRenderer } from "./tools/search-renderer.js";
import { FILE_FINDER_SYSTEM_PROMPT } from "./prompts/system.js";
import { openOAuthDialog } from "./oauth-dialog.js";

declare global {
  interface Window {
    fileAgentDesktop?: {
      selectDirectories: () => Promise<string[]>;
    };
  }
}

interface AppConfig {
  model: {
    provider: "ollama";
    baseUrl: string;
    selectedModelId: string | null;
  };
  scanDirs: string[];
  indexing: {
    autoReindexOnStartup: boolean;
  };
}

interface InitStatus {
  stage:
    | "starting_backend"
    | "loading_config"
    | "checking_ollama"
    | "building_index"
    | "ready"
    | "error";
  message: string;
  progress: {
    scannedFiles: number;
    currentDirectory: string | null;
  };
  error: string | null;
}

interface DiscoveredModel {
  provider: string;
  id: string;
  name: string;
  baseUrl?: string;
}

registerSearchRenderer();

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
  dbName: "file-agent",
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
    customProviders.getConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);
customProviders.setBackend(backend);

const storage = new AppStorage(
  settings,
  providerKeys,
  sessions,
  customProviders,
  backend,
);
setAppStorage(storage);

let chatPanel: ChatPanel | null = null;
let agent: Agent | null = null;
let appConfig: AppConfig | null = null;
let discoveredModels: DiscoveredModel[] = [];
let initStatus: InitStatus = {
  stage: "starting_backend",
  message: "正在启动本地服务...",
  progress: { scannedFiles: 0, currentDirectory: null },
  error: null,
};
let activeView: "init" | "chat" | "settings" = "init";
let savingSettings = false;
let settingsMessage = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

async function loadSettings(): Promise<void> {
  appConfig = await fetchJson<AppConfig>("/api/settings");
}

async function discoverModels(): Promise<void> {
  if (!appConfig) return;
  const data = await fetchJson<{ models: DiscoveredModel[] }>(
    "/api/models/discover",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "ollama",
        baseUrl: appConfig.model.baseUrl,
      }),
    },
  );
  discoveredModels = data.models;
  if (
    !appConfig.model.selectedModelId &&
    discoveredModels.length > 0
  ) {
    appConfig.model.selectedModelId = discoveredModels[0].id;
  }
}

function buildOllamaModel(config: AppConfig): Model<Api> {
  const id = config.model.selectedModelId;
  if (!id) {
    throw new Error("请先在设置中选择 Ollama 模型。");
  }

  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${config.model.baseUrl.replace(/\/+$/, "")}/v1`,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

async function createAgent(): Promise<void> {
  if (!appConfig) throw new Error("Settings not loaded");

  const selectedModel = buildOllamaModel(appConfig);
  agent = new Agent({
    initialState: {
      systemPrompt: FILE_FINDER_SYSTEM_PROMPT,
      model: selectedModel,
      thinkingLevel: "off",
      messages: [],
      tools: [],
    },
    convertToLlm: defaultConvertToLlm,
    streamFn: (model, context, options) =>
      streamProxy(model, context, {
        ...options,
        authToken: "local",
        proxyUrl: "",
      }),
  });

  chatPanel = new ChatPanel();
  await chatPanel.setAgent(agent, {
    toolsFactory: () => [createSearchFilesTool()],
    onApiKeyRequired: async () => true,
    onModelSelect: () => {
      activeView = "settings";
      renderApp();
    },
  });
}

async function ensureAgent(): Promise<void> {
  if (!appConfig?.model.selectedModelId) {
    activeView = "settings";
    return;
  }

  if (!chatPanel) {
    await createAgent();
  }
}

function subscribeInitEvents(): void {
  const source = new EventSource("/api/init-events");
  source.onmessage = (event) => {
    initStatus = JSON.parse(event.data) as InitStatus;
    if (initStatus.stage === "ready") {
      activeView = appConfig?.model.selectedModelId ? "chat" : "settings";
      void ensureAgent().then(renderApp);
    }
    renderApp();
  };
  source.onerror = () => {
    source.close();
  };
}

async function addDirectories(): Promise<void> {
  if (!appConfig) return;
  let picked: string[];
  if (window.fileAgentDesktop) {
    picked = await window.fileAgentDesktop.selectDirectories();
  } else {
    const input = prompt(
      "输入目录路径（多个用分号分隔）\n例如：C:\\Users\\bruce\\Desktop;D:\\",
    );
    if (!input) return;
    picked = input
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const unique = new Set([...appConfig.scanDirs, ...picked]);
  appConfig.scanDirs = [...unique];
  renderApp();
}

async function saveSettings(): Promise<void> {
  if (!appConfig) return;
  savingSettings = true;
  settingsMessage = "";
  renderApp();

  try {
    await fetchJson<AppConfig>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appConfig),
    });

    await discoverModels();
    await fetchJson("/api/reindex", { method: "POST" });
    chatPanel = null;
    agent = null;
    await ensureAgent();
    activeView = "chat";
    settingsMessage = "设置已保存，索引任务已重新启动。";
  } catch (error) {
    settingsMessage =
      error instanceof Error ? error.message : "保存设置失败";
  } finally {
    savingSettings = false;
    renderApp();
  }
}

function removeDirectory(dir: string): void {
  if (!appConfig) return;
  appConfig.scanDirs = appConfig.scanDirs.filter((item) => item !== dir);
  renderApp();
}

function renderInitView() {
  return html`
    <div class="fa-shell">
      <div class="fa-card fa-init-card">
        <div class="fa-eyebrow">File Agent 初始化</div>
        <h1>${initStatus.message}</h1>
        <p>已扫描文件：${initStatus.progress.scannedFiles}</p>
        ${initStatus.progress.currentDirectory
          ? html`<p class="fa-subtle">
              当前目录：${initStatus.progress.currentDirectory}
            </p>`
          : nothing}
        ${initStatus.error
          ? html`<p class="fa-error">${initStatus.error}</p>`
          : nothing}
      </div>
    </div>
  `;
}

function renderSettingsView() {
  if (!appConfig) return nothing;

  return html`
    <div class="fa-shell">
      <div class="fa-card fa-settings">
        <div class="fa-settings-header">
          <div>
            <div class="fa-eyebrow">设置</div>
            <h1>模型与扫描目录</h1>
          </div>
          <button class="fa-ghost-btn" @click=${() => {
            activeView = chatPanel ? "chat" : "init";
            renderApp();
          }}>
            返回
          </button>
        </div>

        <section class="fa-section">
          <h2>Ollama</h2>
          <label class="fa-field">
            <span>服务地址</span>
            <input
              .value=${appConfig.model.baseUrl}
              @input=${(e: Event) => {
                appConfig!.model.baseUrl = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <div class="fa-inline-actions">
            <button class="fa-primary-btn" @click=${async () => {
              try {
                settingsMessage = "";
                await discoverModels();
                settingsMessage = `发现 ${discoveredModels.length} 个模型。`;
              } catch (error) {
                settingsMessage =
                  error instanceof Error ? error.message : "模型发现失败";
              }
              renderApp();
            }}>
              发现模型
            </button>
            <button class="fa-secondary-btn" @click=${() => openOAuthDialog()}>
              OAuth 登录
            </button>
          </div>
          <label class="fa-field">
            <span>默认模型</span>
            <select
              .value=${appConfig.model.selectedModelId || ""}
              @change=${(e: Event) => {
                appConfig!.model.selectedModelId = (e.target as HTMLSelectElement).value || null;
              }}
            >
              <option value="">请选择模型</option>
              ${discoveredModels.map(
                (model) => html`<option value=${model.id}>${model.name}</option>`,
              )}
            </select>
          </label>
        </section>

        <section class="fa-section">
          <div class="fa-section-header">
            <h2>扫描目录</h2>
            <button class="fa-primary-btn" @click=${addDirectories}>
              添加目录
            </button>
          </div>
          <div class="fa-directory-list">
            ${appConfig.scanDirs.length === 0
              ? html`<div class="fa-empty">尚未配置扫描目录</div>`
              : appConfig.scanDirs.map(
                  (dir) => html`
                    <div class="fa-directory-row">
                      <span>${dir}</span>
                      <button
                        class="fa-ghost-btn"
                        @click=${() => removeDirectory(dir)}
                      >
                        删除
                      </button>
                    </div>
                  `,
                )}
          </div>
        </section>

        ${settingsMessage
          ? html`<div class="fa-subtle">${settingsMessage}</div>`
          : nothing}

        <div class="fa-inline-actions">
          <button
            class="fa-primary-btn"
            ?disabled=${savingSettings}
            @click=${saveSettings}
          >
            ${savingSettings ? "保存中..." : "保存并重建索引"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderChatView() {
  return html`
    <div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <div class="flex items-center justify-between border-b border-border px-4 py-2 shrink-0">
        <span class="text-base font-semibold">File Agent</span>
        <div class="flex items-center gap-2">
          <button
            class="px-2 py-1 text-xs rounded border border-border hover:bg-secondary transition-colors"
            @click=${() => {
              activeView = "settings";
              renderApp();
            }}
          >
            设置
          </button>
        </div>
      </div>
      ${chatPanel}
    </div>
  `;
}

function renderApp(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const content =
    activeView === "init"
      ? renderInitView()
      : activeView === "settings"
        ? renderSettingsView()
        : renderChatView();

  render(content, app);
}

async function init(): Promise<void> {
  renderApp();
  await loadSettings();
  try {
    await discoverModels();
  } catch {
    // Let the settings page surface discovery errors interactively.
  }
  subscribeInitEvents();
  renderApp();
}

void init();

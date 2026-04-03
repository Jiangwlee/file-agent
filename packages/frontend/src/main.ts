import { Agent, streamProxy } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import {
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ModelSelector,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
  defaultConvertToLlm,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import "./app.css";
import { createSearchFilesTool } from "./tools/search-files.js";
import { registerSearchRenderer } from "./tools/search-renderer.js";
import { FILE_FINDER_SYSTEM_PROMPT } from "./prompts/system.js";
import { openOAuthDialog } from "./oauth-dialog.js";

// Register custom tool renderer
registerSearchRenderer();

// Storage setup (sessions only — API keys are server-side)
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

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// Fetch default model from server
type AvailableModel = { provider: string; id: string };

async function getAvailableModels(): Promise<AvailableModel[]> {
  const resp = await fetch("/api/models");
  const data = (await resp.json()) as {
    models: AvailableModel[];
  };
  return data.models;
}

async function getDefaultModel(): Promise<Model<Api>> {
  try {
    const models = await getAvailableModels();
    if (models.length > 0) {
      const m = models[0];
      const model = getModel(m.provider as any, m.id as any);
      if (model) return model;
    }
  } catch {
    // Fall back to default
  }
  return getModel("openai", "gpt-4.1-mini");
}

// App state
let chatPanel: ChatPanel;

async function createAgent() {
  const [defaultModel, availableModels] = await Promise.all([
    getDefaultModel(),
    getAvailableModels().catch(() => []),
  ]);
  const allowedProviders = [...new Set(availableModels.map((model) => model.provider))];

  const agent = new Agent({
    initialState: {
      systemPrompt: FILE_FINDER_SYSTEM_PROMPT,
      model: defaultModel,
      thinkingLevel: "off",
      messages: [],
      tools: [],
    },
    convertToLlm: defaultConvertToLlm,
    // Route LLM calls through backend proxy — API keys stay server-side
    streamFn: (model, context, options) =>
      streamProxy(model, context, {
        ...options,
        authToken: "local", // No real auth needed for local deployment
        proxyUrl: "",       // Same origin — relative URL
      }),
  });

  await chatPanel.setAgent(agent, {
    toolsFactory: () => [createSearchFilesTool()],
    // API keys are server-side — skip browser key check
    onApiKeyRequired: async (_provider) => true,
    onModelSelect: () => {
      ModelSelector.open(
        agent.state.model,
        (selectedModel) => {
          agent.setModel(selectedModel);
          chatPanel.agentInterface?.requestUpdate();
        },
        allowedProviders.length > 0 ? allowedProviders : undefined,
      );
    },
  });
}

function renderApp() {
  const app = document.getElementById("app");
  if (!app) return;

  render(
    html`
      <div
        class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden"
      >
        <div
          class="flex items-center justify-between border-b border-border px-4 py-2 shrink-0"
        >
          <span class="text-base font-semibold">File Agent</span>
          <div class="flex items-center gap-2">
            <button
              class="px-2 py-1 text-xs rounded border border-border hover:bg-secondary transition-colors"
              @click=${() => openOAuthDialog()}
            >
              OAuth 登录
            </button>
          </div>
        </div>
        ${chatPanel}
      </div>
    `,
    app,
  );
}

async function init() {
  const app = document.getElementById("app");
  if (!app) throw new Error("App container not found");

  render(
    html`
      <div
        class="w-full h-screen flex items-center justify-center bg-background text-foreground"
      >
        <div class="text-muted-foreground">加载中...</div>
      </div>
    `,
    app,
  );

  chatPanel = new ChatPanel();
  await createAgent();
  renderApp();
}

init();

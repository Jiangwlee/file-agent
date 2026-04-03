import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  streamSimple,
  getEnvApiKey,
  getProviders,
  getModels,
} from "@mariozechner/pi-ai";
import {
  getOAuthProviders,
  getOAuthProvider,
  type OAuthCredentials,
} from "@mariozechner/pi-ai/oauth";
import type {
  Model,
  Context,
  AssistantMessageEvent,
  Api,
} from "@mariozechner/pi-ai";
import type { OAuthStore } from "./oauth-store.js";

/**
 * Convert AssistantMessageEvent to bandwidth-efficient proxy format.
 * Strips the `partial` field that the client reconstructs locally.
 */
function toProxyEvent(event: AssistantMessageEvent): object {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return {
        type: "text_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "text_end":
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        contentSignature: (event.partial.content[event.contentIndex] as any)
          ?.textSignature,
      };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "thinking_end":
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        contentSignature: (event.partial.content[event.contentIndex] as any)
          ?.thinkingSignature,
      };
    case "toolcall_start": {
      const tc = event.partial.content[event.contentIndex];
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        id: tc?.type === "toolCall" ? tc.id : "",
        toolName: tc?.type === "toolCall" ? tc.name : "",
      };
    }
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex };
    case "done":
      return {
        type: "done",
        reason: event.reason,
        usage: event.message.usage,
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        errorMessage: event.error.errorMessage,
        usage: event.error.usage,
      };
  }
}

/**
 * Resolve API key for a provider: try env var first, then OAuth credentials.
 * Automatically refreshes expired OAuth tokens.
 */
async function resolveApiKey(
  provider: string,
  oauthStore: OAuthStore,
): Promise<{ apiKey: string; model?: Partial<Model<Api>> } | null> {
  // 1. Static env var
  const envKey = getEnvApiKey(provider);
  if (envKey) return { apiKey: envKey };

  // 2. OAuth credentials
  const creds = oauthStore.get(provider);
  if (!creds) return null;

  const oauthProvider = getOAuthProvider(provider);
  if (!oauthProvider) return null;

  let activeCreds = creds;

  // Auto-refresh if expired
  if (Date.now() >= creds.expires) {
    try {
      activeCreds = await oauthProvider.refreshToken(creds);
      oauthStore.set(provider, activeCreds);
      console.log(`Refreshed OAuth token for ${provider}`);
    } catch (err) {
      console.error(`Failed to refresh OAuth token for ${provider}:`, err);
      oauthStore.delete(provider);
      return null;
    }
  }

  const apiKey = oauthProvider.getApiKey(activeCreds);
  return { apiKey };
}

export function createLlmProxy(oauthStore: OAuthStore): Hono {
  const app = new Hono();

  // ─── Models ─────────────────────────────────────────────────────────
  // Returns available models from providers with env keys OR OAuth credentials
  app.get("/api/models", (c) => {
    const available: Array<{
      provider: string;
      id: string;
      name: string;
    }> = [];

    const configuredProviders = new Set<string>();

    // Env-based providers
    for (const provider of getProviders()) {
      if (getEnvApiKey(provider)) {
        configuredProviders.add(provider);
      }
    }

    // OAuth-based providers
    for (const providerId of oauthStore.listProviderIds()) {
      configuredProviders.add(providerId);
    }

    for (const provider of configuredProviders) {
      for (const model of getModels(provider as any)) {
        available.push({
          provider: model.provider,
          id: model.id,
          name: model.name || model.id,
        });
      }
    }

    return c.json({ models: available });
  });

  // ─── OAuth ──────────────────────────────────────────────────────────

  // List OAuth providers and their login status
  app.get("/api/oauth/providers", (c) => {
    const providers = getOAuthProviders().map((p) => ({
      id: p.id,
      name: p.name,
      loggedIn: !!oauthStore.get(p.id),
    }));
    return c.json({ providers });
  });

  // Start OAuth login (device code flow)
  // Returns SSE events: { type: "auth", url, instructions } | { type: "progress", message } | { type: "done" } | { type: "error", message }
  app.post("/api/oauth/login/:providerId", async (c) => {
    const { providerId } = c.req.param();
    const oauthProvider = getOAuthProvider(providerId);
    if (!oauthProvider) {
      return c.json({ error: `Unknown OAuth provider: ${providerId}` }, 404);
    }

    // Parse optional body for prompts (e.g., enterprise URL)
    let promptResponses: Record<string, string> = {};
    try {
      const body = await c.req.json<{ prompts?: Record<string, string> }>();
      promptResponses = body.prompts || {};
    } catch {
      // No body is fine
    }

    let promptIndex = 0;
    const promptKeys = Object.keys(promptResponses);

    return streamSSE(c, async (stream) => {
      try {
        const credentials = await oauthProvider.login({
          onAuth: (info) => {
            stream.writeSSE({
              data: JSON.stringify({
                type: "auth",
                url: info.url,
                instructions: info.instructions,
              }),
            });
          },
          onPrompt: async (prompt) => {
            // Use pre-supplied prompt responses, or return empty for allowEmpty
            const key = promptKeys[promptIndex++];
            if (key && promptResponses[key]) {
              return promptResponses[key];
            }
            if (prompt.allowEmpty) return "";
            // Can't prompt interactively via HTTP — return empty
            return "";
          },
          onProgress: (message) => {
            stream.writeSSE({
              data: JSON.stringify({ type: "progress", message }),
            });
          },
        });

        oauthStore.set(providerId, credentials);
        await stream.writeSSE({
          data: JSON.stringify({ type: "done" }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message }),
        });
      }
    });
  });

  // Logout OAuth provider
  app.delete("/api/oauth/login/:providerId", (c) => {
    const { providerId } = c.req.param();
    oauthStore.delete(providerId);
    return c.json({ ok: true });
  });

  // ─── LLM Streaming Proxy ───────────────────────────────────────────

  app.post("/api/stream", async (c) => {
    const body = await c.req.json<{
      model: Model<Api>;
      context: Context;
      options?: {
        temperature?: number;
        maxTokens?: number;
        reasoning?: string;
      };
    }>();

    const { model, context, options } = body;

    const resolved = await resolveApiKey(model.provider, oauthStore);
    if (!resolved) {
      return c.json(
        { error: `No API key configured for provider: ${model.provider}. Configure env var or login via OAuth.` },
        401,
      );
    }

    // Apply model modifications from OAuth provider if needed
    let finalModel = model;
    const oauthProvider = getOAuthProvider(model.provider);
    const creds = oauthStore.get(model.provider);
    if (oauthProvider?.modifyModels && creds) {
      const modified = oauthProvider.modifyModels([model], creds);
      if (modified.length > 0) {
        finalModel = modified[0];
      }
    }

    return streamSSE(c, async (stream) => {
      const eventStream = streamSimple(finalModel, context, {
        apiKey: resolved.apiKey,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        reasoning: options?.reasoning as any,
      });

      for await (const event of eventStream) {
        const proxyEvent = toProxyEvent(event);
        await stream.writeSSE({ data: JSON.stringify(proxyEvent) });
      }
    });
  });

  return app;
}

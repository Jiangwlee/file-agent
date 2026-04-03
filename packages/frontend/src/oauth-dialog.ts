import { html, render, type TemplateResult } from "lit";

interface OAuthProvider {
  id: string;
  name: string;
  loggedIn: boolean;
}

interface LoginState {
  status: "idle" | "waiting" | "progress" | "done" | "error";
  url?: string;
  instructions?: string;
  message?: string;
}

function createDialogContent(
  providers: OAuthProvider[],
  loginStates: Map<string, LoginState>,
  onLogin: (id: string) => void,
  onLogout: (id: string) => void,
  onClose: () => void,
): TemplateResult {
  return html`
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4"
      >
        <div
          class="flex items-center justify-between px-4 py-3 border-b border-border"
        >
          <h2 class="text-sm font-semibold">OAuth 登录</h2>
          <button
            class="text-muted-foreground hover:text-foreground text-lg leading-none"
            @click=${onClose}
          >
            &times;
          </button>
        </div>
        <div class="p-4 space-y-3 max-h-96 overflow-y-auto">
          ${providers.map((p) => {
            const state = loginStates.get(p.id) || { status: "idle" };
            return html`
              <div
                class="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium">${p.name}</div>
                  ${p.loggedIn
                    ? html`<div class="text-xs text-green-600">已登录</div>`
                    : state.status === "waiting"
                      ? html`
                          <div class="mt-2 space-y-1">
                            <div class="text-xs text-muted-foreground">
                              ${state.instructions || "请在浏览器中完成授权"}
                            </div>
                            <a
                              href=${state.url}
                              target="_blank"
                              class="text-xs text-blue-600 hover:underline break-all"
                              >${state.url}</a
                            >
                          </div>
                        `
                      : state.status === "progress"
                        ? html`<div class="text-xs text-muted-foreground">
                            ${state.message || "处理中..."}
                          </div>`
                        : state.status === "error"
                          ? html`<div class="text-xs text-red-600">
                              ${state.message}
                            </div>`
                          : state.status === "done"
                            ? html`<div class="text-xs text-green-600">
                                登录成功
                              </div>`
                            : html``}
                </div>
                <div class="ml-3 shrink-0">
                  ${p.loggedIn
                    ? html`<button
                        class="px-3 py-1 text-xs rounded border border-border hover:bg-secondary transition-colors"
                        @click=${() => onLogout(p.id)}
                      >
                        登出
                      </button>`
                    : state.status === "waiting" || state.status === "progress"
                      ? html`<div
                          class="text-xs text-muted-foreground animate-pulse"
                        >
                          等待中...
                        </div>`
                      : html`<button
                          class="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                          @click=${() => onLogin(p.id)}
                        >
                          登录
                        </button>`}
                </div>
              </div>
            `;
          })}
          ${providers.length === 0
            ? html`<div class="text-sm text-muted-foreground text-center py-4">
                无可用的 OAuth 供应商
              </div>`
            : ""}
        </div>
      </div>
    </div>
  `;
}

export async function openOAuthDialog(): Promise<void> {
  // Fetch providers
  const resp = await fetch("/api/oauth/providers");
  const data = (await resp.json()) as { providers: OAuthProvider[] };
  let providers = data.providers;

  const loginStates = new Map<string, LoginState>();
  const container = document.createElement("div");
  document.body.appendChild(container);

  function rerender() {
    render(
      createDialogContent(
        providers,
        loginStates,
        startLogin,
        doLogout,
        close,
      ),
      container,
    );
  }

  function close() {
    render(html``, container);
    container.remove();
  }

  async function refreshProviders() {
    const resp = await fetch("/api/oauth/providers");
    const data = (await resp.json()) as { providers: OAuthProvider[] };
    providers = data.providers;
  }

  async function startLogin(providerId: string) {
    loginStates.set(providerId, { status: "waiting" });
    rerender();

    try {
      const resp = await fetch(`/api/oauth/login/${providerId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const event = JSON.parse(line.slice(6).trim());
            switch (event.type) {
              case "auth":
                loginStates.set(providerId, {
                  status: "waiting",
                  url: event.url,
                  instructions: event.instructions,
                });
                // Auto-open auth URL
                window.open(event.url, "_blank");
                break;
              case "progress":
                loginStates.set(providerId, {
                  status: "progress",
                  message: event.message,
                });
                break;
              case "done":
                loginStates.set(providerId, { status: "done" });
                await refreshProviders();
                break;
              case "error":
                loginStates.set(providerId, {
                  status: "error",
                  message: event.message,
                });
                break;
            }
            rerender();
          }
        }
      }
    } catch (err) {
      loginStates.set(providerId, {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      rerender();
    }
  }

  async function doLogout(providerId: string) {
    await fetch(`/api/oauth/login/${providerId}`, { method: "DELETE" });
    loginStates.delete(providerId);
    await refreshProviders();
    rerender();
  }

  rerender();
}

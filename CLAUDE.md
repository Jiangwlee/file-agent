# file-agent

轻量文件定位器：给出模糊自然语言描述，快速返回 ≤10 个最可能的文件路径。

## 问题

Windows 主机上桌面/D盘有大量散落文档，Windows 自带搜索只支持关键词精确匹配，用户经常"知道有这个文件但找不到"。

## 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 技术栈 | TypeScript (Node.js + Vite) | 与 pi-mono 生态统一 |
| 索引深度 | L1: 文件名+路径+元数据 | 轻量快速，覆盖大部分场景；不做全文索引 |
| 搜索引擎 | SQLite FTS5 + BM25 (better-sqlite3) | 毫秒级查询，前缀匹配支持中文 |
| 语义桥接 | LLM 关键词扩展 | LLM 只做"翻译"（模糊→关键词），token 极少 |
| 向量数据库 | 不用 | FTS5 对"找文件"场景足够 |
| 部署 | Docker on Windows | 只读 mount 桌面+D盘，隔离安全 |
| Agent | pi-agent-core (浏览器端) | 与 pi-web-ui ChatPanel 集成 |
| LLM 调用 | 后端 proxy (streamProxy) | API key 存服务端，支持多用户/多浏览器 |
| Web UI | pi-web-ui ChatPanel | 现成的 chat 组件，含 sessions/model selector |

## 不做的事

- 不做文件整理/移动/重命名
- 不做全文内容问答（不是 RAG 系统）
- 不做版本管理

## 搜索流程

```
用户输入: "去年的报税文件"
    ↓
浏览器端 Agent (LLM): 扩展为关键词 ["报税", "税务", "个税", "tax", "return", "2025"]
    ↓
search_files tool: fetch POST /api/search → 后端 FTS5 MATCH + BM25
    ↓
返回 top 10 文件路径（Windows 路径，可点击复制）
```

## 技术架构

```
┌──────────────────────────────────────────────────────┐
│                  Docker Container                     │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │  Browser (Vite SPA)                         │     │
│  │                                             │     │
│  │  pi-web-ui ChatPanel                        │     │
│  │    └─ pi-agent-core Agent                   │     │
│  │         ├─ system prompt (file-finder)       │     │
│  │         └─ search_files tool                 │     │
│  │              └─ fetch POST /api/search ──────┼──┐ │
│  └─────────────────────────────────────────────┘  │ │
│                                                    │ │
│  ┌─────────────────────────────────────────────┐  │ │
│  │  Backend (Hono on Node.js, :8080)       ◄───┼──┘ │
│  │                                             │     │
│  │  POST /api/stream   → LLM proxy (SSE)       │     │
│  │  GET  /api/models   → 可用模型列表          │     │
│  │  POST /api/search   → SQLite FTS5 查询      │     │
│  │  POST /api/reindex  → 重建索引              │     │
│  │  GET  /api/stats    → 索引统计              │     │
│  │  GET  /*            → 静态文件 (Vite build) │     │
│  │                                             │     │
│  │  SQLite + FTS5 (better-sqlite3)             │     │
│  │  API Keys: 环境变量 (.env)                   │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  Mount (ro): Desktop → /data/desktop                 │
│              D:\     → /data/d-drive                 │
└──────────────────────────────────────────────────────┘
```

## 项目结构

```
file-agent/
├── CLAUDE.md
├── package.json              # npm workspaces root
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── packages/
│   ├── frontend/             # Vite SPA (pi-web-ui)
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.ts
│   │       ├── app.css
│   │       ├── tools/
│   │       │   ├── search-files.ts    # AgentTool 定义
│   │       │   └── search-renderer.ts # ToolRenderer
│   │       └── prompts/
│   │           └── system.ts          # file-finder system prompt
│   └── backend/              # Hono server
│       ├── package.json
│       └── src/
│           ├── index.ts      # Hono server + 静态文件
│           ├── llm-proxy.ts  # LLM streaming proxy (SSE) + OAuth 端点
│           ├── oauth-store.ts # OAuth 凭据持久化 (JSON 文件)
│           ├── indexer.ts    # 文件扫描 + FTS5 索引
│           ├── searcher.ts   # FTS5 查询 + BM25
│           └── config.ts     # 环境变量
└── tests/
    ├── indexer.test.ts
    └── searcher.test.ts
```

## 核心组件

### Backend: Indexer (`packages/backend/src/indexer.ts`)

- `node:fs` 递归遍历 mount 目录
- `better-sqlite3` 创建 FTS5 索引
- 收集：filename / filepath / path_segments / extension / size / mtime
- tokenizer: `unicode61 remove_diacritics 2`
- 搜索使用前缀匹配 (`keyword*`) 以支持中文 token
- 增量更新：按 mtime 判断变更，删除已移除的文件

### Backend: Searcher (`packages/backend/src/searcher.ts`)

- 接收关键词列表，OR 连接 + 前缀匹配构建 FTS5 MATCH
- BM25 排序权重：filename(10.0) > doc_title(8.0) > path_segments(5.0) > extension(1.0)
- 容器路径 → Windows 路径映射

### Frontend: Agent + Tool (`packages/frontend/src/`)

- `pi-agent-core` Agent 在浏览器端运行
- system prompt 指导 LLM 扩展关键词
- `search_files` tool: `fetch POST /api/search` → 后端查询
- 自定义 `ToolRenderer` 渲染文件列表（图标 + 路径可复制）

### Backend: LLM Proxy (`packages/backend/src/llm-proxy.ts`)

- `POST /api/stream`: SSE proxy，接收 `{ model, context, options }`
- 服务端用 `streamSimple()` 调 LLM，转为 `ProxyAssistantMessageEvent` 格式
- API key 解析优先级：环境变量 (`getEnvApiKey()`) → OAuth 凭据
- `GET /api/models`: 返回已配置 key + OAuth 登录的 provider 模型

### Backend: OAuth (`packages/backend/src/llm-proxy.ts` + `oauth-store.ts`)

- `GET /api/oauth/providers`: 列出所有 OAuth provider 及登录状态
- `POST /api/oauth/login/:providerId`: 启动 Device Code Flow，返回 SSE 事件
- `DELETE /api/oauth/login/:providerId`: 登出
- 凭据持久化到 `data/oauth-credentials.json`
- 自动 token refresh：LLM 调用前检查过期，透明续期
- 支持的 OAuth provider：GitHub Copilot, Anthropic, OpenAI Codex, Gemini CLI, Antigravity

### Frontend: UI

- `pi-web-ui` ChatPanel: 完整 chat 界面
- `streamProxy` 将 LLM 调用代理到后端 `/api/stream`
- API key 不接触浏览器，多用户/多浏览器均可使用
- IndexedDB 持久化 sessions
- 支持多模型切换（模型列表从 `/api/models` 获取）

## SQLite Schema

```sql
CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL UNIQUE,
    host_path TEXT,
    path_segments TEXT,
    extension TEXT,
    size_bytes INTEGER,
    mtime TEXT,
    doc_title TEXT,
    indexed_at TEXT
);

CREATE VIRTUAL TABLE files_fts USING fts5(
    filename, path_segments, doc_title, extension,
    content=files, content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
);
```

## 依赖

**Backend:** `hono`, `@hono/node-server`, `better-sqlite3`, `@mariozechner/pi-ai`
**Frontend:** `@mariozechner/pi-web-ui`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@sinclair/typebox`, `lit`, `vite`

## 开发

```bash
npm install                    # 安装所有依赖
npm test                       # 运行测试 (vitest)
npm run dev                    # 启动 backend dev server
cd packages/frontend && npm run dev  # 启动 frontend dev server (proxy /api → :8080)
```

## 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| SCAN_DIRS | 逗号分隔的扫描目录 | `/data` |
| PATH_MAP | 容器路径=Windows路径映射 | 无 |
| DB_PATH | SQLite 数据库路径 | `./data/file_index.db` |
| FILE_AGENT_PORT | Web 服务端口 | `8080` |
| OPENAI_API_KEY | OpenAI API key | 无 |
| ANTHROPIC_API_KEY | Anthropic API key | 无 |
| GEMINI_API_KEY | Google Gemini API key | 无 |

API key 通过 `.env` 文件或 Docker 环境变量配置（见 `.env.example`）。

## 研究背景

设计基于 deep-research 的调研结论（14 个来源，3 轮研究）：

- 社区共识："搜索比整理更有价值"（r/LocalLLaMA, r/Rag）
- 现有工具（AnythingLLM/Khoj）太重，不符合单一职责
- naive RAG 在大规模下精度下降，但我们不做 RAG，只做文件定位
- FTS5 + LLM 关键词扩展是"甜点"方案：轻量 + 语义理解

完整报告：`~/.local/share/oh-my-superpowers/deep-research/2026-04-03T15-09-windows-doc-ai-management/reports/`

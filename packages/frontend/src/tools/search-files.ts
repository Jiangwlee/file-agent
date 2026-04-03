import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const searchFilesSchema = Type.Object({
  keywords: Type.Array(Type.String(), {
    description:
      "搜索关键词列表，包含中英文关键词、文件名片段、扩展名等。至少 5 个关键词。",
  }),
  max_results: Type.Optional(
    Type.Number({
      description: "最大返回结果数，默认 10",
      default: 10,
    }),
  ),
});

type SearchFilesParams = Static<typeof searchFilesSchema>;

export interface SearchFileResult {
  filename: string;
  filepath: string;
  hostPath: string | null;
  extension: string | null;
  sizeBytes: number;
  mtime: string;
  docTitle: string | null;
  score: number;
}

export interface SearchFilesDetails {
  results: SearchFileResult[];
  query: string[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function createSearchFilesTool(): AgentTool<
  typeof searchFilesSchema,
  SearchFilesDetails
> {
  return {
    name: "search_files",
    label: "搜索文件",
    description:
      "根据关键词搜索文件。输入中英文关键词列表，返回最匹配的文件路径。",
    parameters: searchFilesSchema,
    execute: async (
      _toolCallId: string,
      params: SearchFilesParams,
    ): Promise<AgentToolResult<SearchFilesDetails>> => {
      const { keywords, max_results = 10 } = params;

      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, max_results }),
      });

      if (!response.ok) {
        throw new Error(`搜索失败: ${response.statusText}`);
      }

      const data = (await response.json()) as { results: SearchFileResult[] };
      const results = data.results;

      // Format results as text for LLM
      let text: string;
      if (results.length === 0) {
        text = "未找到匹配的文件。";
      } else {
        const lines = results.map((r, i) => {
          const displayPath = r.hostPath || r.filepath;
          const size = formatFileSize(r.sizeBytes);
          const date = new Date(r.mtime).toLocaleDateString("zh-CN");
          const title = r.docTitle ? ` (${r.docTitle})` : "";
          return `${i + 1}. ${r.filename}${title}\n   路径: ${displayPath}\n   大小: ${size} | 修改日期: ${date}`;
        });
        text = `找到 ${results.length} 个文件：\n\n${lines.join("\n\n")}`;
      }

      return {
        content: [{ type: "text", text }],
        details: { results, query: keywords },
      };
    },
  };
}

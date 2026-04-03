import { html } from "lit";
import {
  registerToolRenderer,
  type ToolRenderer,
} from "@mariozechner/pi-web-ui";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { SearchFilesDetails, SearchFileResult } from "./search-files.js";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function extensionIcon(ext: string | null): string {
  switch (ext) {
    case "pdf":
      return "📄";
    case "doc":
    case "docx":
      return "📝";
    case "xls":
    case "xlsx":
      return "📊";
    case "ppt":
    case "pptx":
      return "📽️";
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "bmp":
      return "🖼️";
    case "mp3":
    case "wav":
    case "flac":
      return "🎵";
    case "mp4":
    case "avi":
    case "mkv":
      return "🎬";
    case "zip":
    case "rar":
    case "7z":
      return "📦";
    default:
      return "📁";
  }
}

function renderResult(result: SearchFileResult, index: number) {
  const displayPath = result.hostPath || result.filepath;
  const size = formatFileSize(result.sizeBytes);
  const date = new Date(result.mtime).toLocaleDateString("zh-CN");
  const icon = extensionIcon(result.extension);

  const copyPath = () => {
    navigator.clipboard.writeText(displayPath);
  };

  return html`
    <div
      class="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer group"
      @click=${copyPath}
      title="点击复制路径"
    >
      <span class="text-xl mt-0.5">${icon}</span>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-foreground truncate">
            ${index + 1}. ${result.filename}
          </span>
          ${result.docTitle
            ? html`<span class="text-xs text-muted-foreground"
                >(${result.docTitle})</span
              >`
            : ""}
        </div>
        <div
          class="text-xs text-muted-foreground font-mono truncate mt-0.5 group-hover:text-foreground transition-colors"
        >
          ${displayPath}
        </div>
        <div class="text-xs text-muted-foreground mt-1">
          ${size} &middot; ${date}
        </div>
      </div>
      <span
        class="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity self-center"
        >复制</span
      >
    </div>
  `;
}

const searchRenderer: ToolRenderer<
  { keywords: string[]; max_results?: number },
  SearchFilesDetails
> = {
  render(params, result, isStreaming) {
    if (isStreaming || !result) {
      const keywords = params?.keywords?.join(", ") || "...";
      return {
        content: html`
          <div class="p-3 text-sm text-muted-foreground">
            正在搜索: ${keywords}
          </div>
        `,
        isCustom: false,
      };
    }

    const details = result.details;
    if (
      !details ||
      !details.results ||
      (result as ToolResultMessage<SearchFilesDetails>).isError
    ) {
      const errorText =
        result.content?.map((c: any) => c.text).join("") || "搜索失败";
      return {
        content: html`
          <div class="p-3 text-sm text-destructive">${errorText}</div>
        `,
        isCustom: false,
      };
    }

    const { results: files, query } = details;

    return {
      content: html`
        <div class="space-y-1">
          <div class="px-3 pt-2 text-xs text-muted-foreground">
            关键词: ${query.join(", ")} &middot; ${files.length} 个结果
          </div>
          ${files.length === 0
            ? html`<div class="p-3 text-sm text-muted-foreground">
                未找到匹配的文件
              </div>`
            : files.map((f, i) => renderResult(f, i))}
        </div>
      `,
      isCustom: false,
    };
  },
};

export function registerSearchRenderer() {
  registerToolRenderer("search_files", searchRenderer);
}

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  BinaryFilePayload,
  DiffResult,
  DocStats,
  FilePayload,
  FormatResult,
  SearchMatch,
  TransformResult,
  TreeNode,
  ValidationResult,
} from "../types/editor";
import { uint8ArrayToBase64 } from "../utils/samplePdf";
import {
  buildDemoTree,
  DEMO_WORKSPACE_NAME,
  DEMO_WORKSPACE_ROOT,
  SAMPLE_FILES,
} from "./sampleFiles";
import {
  computeDiff as clientComputeDiff,
  computeStats as clientComputeStats,
  convertFormat as clientConvertFormat,
  formatDocument as clientFormatDocument,
  queryJson as clientQueryJson,
  transformText as clientTransformText,
  validateDocument as clientValidateDocument,
} from "../utils/clientTransforms";

// ============================================================================
// Runtime Detection & In-Memory Demo Workspace (for Browser Preview Mode)
// ============================================================================

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const demoFiles = new Map<string, string>(
  SAMPLE_FILES.map((file) => [file.path, file.content])
);

const demoBinaryFiles = new Map<string, string>(
  SAMPLE_FILES.filter((file) => file.isBinary && file.binaryBase64).map((file) => [
    file.path,
    file.binaryBase64 as string,
  ])
);

export function isPdfPath(pathOrName: string): boolean {
  return pathOrName.trim().toLowerCase().endsWith(".pdf");
}

export function getDemoWorkspaceInfo() {
  return {
    name: DEMO_WORKSPACE_NAME,
    root: DEMO_WORKSPACE_ROOT,
  };
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// File System & Workspace Operations
// ============================================================================

export async function readFileSmart(path: string): Promise<FilePayload> {
  if (isTauriRuntime() && !path.startsWith("demo://")) {
    return invoke<FilePayload>("read_file_smart", { path });
  }

  const content = demoFiles.get(path);
  if (content === undefined) {
    throw new Error(`File not found in workspace: ${path}`);
  }
  return {
    path,
    name: getFileName(path),
    content,
    encoding: "UTF-8",
    line_ending: "LF",
    size_bytes: new TextEncoder().encode(content).length,
    modified_ms: Date.now(),
  };
}

export async function readBinaryFile(path: string): Promise<BinaryFilePayload> {
  if (isTauriRuntime() && !path.startsWith("demo://")) {
    return invoke<BinaryFilePayload>("read_binary_file", { path });
  }

  const base64 = demoBinaryFiles.get(path);
  if (base64 === undefined) {
    throw new Error(`Binary file not found in workspace: ${path}`);
  }
  const approxBytes = Math.floor((base64.length * 3) / 4);
  return {
    path,
    name: getFileName(path),
    base64,
    size_bytes: approxBytes,
    modified_ms: Date.now(),
  };
}

export async function writeFileSmart(
  path: string,
  content: string,
  encoding: string,
  lineEnding: string
): Promise<FilePayload> {
  if (isTauriRuntime() && !path.startsWith("demo://")) {
    return invoke<FilePayload>("write_file_smart", {
      path,
      content,
      encoding,
      lineEnding,
    });
  }

  demoFiles.set(path, content);
  return {
    path,
    name: getFileName(path),
    content,
    encoding,
    line_ending: lineEnding,
    size_bytes: new TextEncoder().encode(content).length,
    modified_ms: Date.now(),
  };
}

export async function listWorkspaceTree(
  root: string,
  maxDepth?: number
): Promise<TreeNode[]> {
  if (isTauriRuntime() && !root.startsWith("demo://")) {
    return invoke<TreeNode[]>("list_workspace_tree", {
      root,
      maxDepth: maxDepth ?? 8,
    });
  }
  return buildDemoTree(demoFiles);
}

export async function createFsEntry(path: string, isDir: boolean): Promise<void> {
  if (isTauriRuntime() && !path.startsWith("demo://")) {
    await invoke("create_fs_entry", { path, isDir });
    return;
  }
  if (!isDir) {
    demoFiles.set(path, "");
  } else {
    demoFiles.set(`${path}/.keep`, "");
  }
}

export async function renameFsEntry(oldPath: string, newPath: string): Promise<void> {
  if (isTauriRuntime() && !oldPath.startsWith("demo://")) {
    await invoke("rename_fs_entry", { oldPath, newPath });
    return;
  }
  const existing = demoFiles.get(oldPath);
  if (existing !== undefined) {
    demoFiles.delete(oldPath);
    demoFiles.set(newPath, existing);
  }
}

export async function deleteFsEntry(path: string): Promise<void> {
  if (isTauriRuntime() && !path.startsWith("demo://")) {
    await invoke("delete_fs_entry", { path });
    return;
  }
  demoFiles.delete(path);
  const prefix = path.endsWith("/") ? path : `${path}/`;
  for (const key of Array.from(demoFiles.keys())) {
    if (key.startsWith(prefix)) {
      demoFiles.delete(key);
    }
  }
}

export async function searchWorkspace(
  root: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
  wholeWord: boolean,
  maxResults = 300
): Promise<SearchMatch[]> {
  if (!query) return [];

  if (isTauriRuntime() && !root.startsWith("demo://")) {
    return invoke<SearchMatch[]>("search_workspace", {
      root,
      query,
      isRegex,
      caseSensitive,
      wholeWord,
      maxResults,
    });
  }

  const results: SearchMatch[] = [];
  let pattern = isRegex ? query : escapeRegexLiteral(query);
  if (wholeWord) {
    pattern = `\\b(?:${pattern})\\b`;
  }
  const flags = caseSensitive ? "g" : "gi";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return [];
  }

  for (const [path, content] of demoFiles.entries()) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      regex.lastIndex = 0;
      const match = regex.exec(lineText);
      if (match) {
        results.push({
          path,
          line_number: i + 1,
          column: match.index + 1,
          line_text: lineText.trim().slice(0, 220),
          match_text: match[0],
        });
        if (results.length >= maxResults) return results;
      }
    }
  }

  return results;
}

// ============================================================================
// Formatters, Validators, Converters & JSON Query
// ============================================================================

export async function formatDocument(
  content: string,
  format: string,
  indent = 2,
  useTabs = false,
  minify = false
): Promise<FormatResult> {
  if (isTauriRuntime()) {
    return invoke<FormatResult>("format_document", {
      content,
      format,
      indent,
      useTabs,
      minify,
    });
  }
  return clientFormatDocument(content, format, indent, useTabs, minify);
}

export async function validateDocument(
  content: string,
  format: string
): Promise<ValidationResult> {
  if (isTauriRuntime()) {
    return invoke<ValidationResult>("validate_document", { content, format });
  }
  return clientValidateDocument(content, format);
}

export async function convertFormat(
  content: string,
  from: string,
  to: string
): Promise<FormatResult> {
  if (isTauriRuntime()) {
    return invoke<FormatResult>("convert_format", { content, from, to });
  }
  return clientConvertFormat(content, from, to);
}

export async function queryJson(
  content: string,
  path: string
): Promise<FormatResult> {
  if (isTauriRuntime()) {
    return invoke<FormatResult>("query_json", { content, path });
  }
  return clientQueryJson(content, path);
}

// ============================================================================
// Notepad++ Transforms, Diff & Document Stats
// ============================================================================

export async function transformText(
  content: string,
  op: string,
  arg?: string
): Promise<TransformResult> {
  if (isTauriRuntime()) {
    return invoke<TransformResult>("transform_text", {
      content,
      op,
      arg: arg ?? null,
    });
  }
  return await clientTransformText(content, op, arg);
}

export async function computeDiff(left: string, right: string): Promise<DiffResult> {
  if (isTauriRuntime()) {
    return invoke<DiffResult>("compute_diff", { left, right });
  }
  return clientComputeDiff(left, right);
}

export async function computeStats(content: string): Promise<DocStats> {
  if (isTauriRuntime()) {
    return invoke<DocStats>("compute_stats", { content });
  }
  return clientComputeStats(content);
}

// ============================================================================
// Native OS Dialogs (Tauri) + Browser File Input / Download Fallbacks
// ============================================================================

export type PickedFileResult =
  | { kind: "text"; payload: FilePayload }
  | { kind: "binary"; payload: BinaryFilePayload };

export async function pickOpenFile(): Promise<PickedFileResult | null> {
  if (isTauriRuntime()) {
    const selected = await openDialog({ multiple: false, directory: false });
    if (!selected || typeof selected !== "string") return null;
    if (isPdfPath(selected)) {
      return { kind: "binary", payload: await readBinaryFile(selected) };
    }
    return { kind: "text", payload: await readFileSmart(selected) };
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const virtualPath = `${DEMO_WORKSPACE_ROOT}/${file.name}`;
      if (isPdfPath(file.name)) {
        const buffer = await file.arrayBuffer();
        const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
        demoFiles.set(virtualPath, "");
        demoBinaryFiles.set(virtualPath, base64);
        resolve({
          kind: "binary",
          payload: {
            path: virtualPath,
            name: file.name,
            base64,
            size_bytes: file.size,
            modified_ms: file.lastModified || Date.now(),
          },
        });
        return;
      }
      const content = await file.text();
      demoFiles.set(virtualPath, content);
      resolve({
        kind: "text",
        payload: {
          path: virtualPath,
          name: file.name,
          content,
          encoding: "UTF-8",
          line_ending: content.includes("\r\n") ? "CRLF" : "LF",
          size_bytes: file.size,
          modified_ms: file.lastModified || Date.now(),
        },
      });
    };
    input.click();
  });
}

export async function pickOpenFolder(): Promise<{ root: string; name: string } | null> {
  if (isTauriRuntime()) {
    const selected = await openDialog({ multiple: false, directory: true });
    if (!selected || typeof selected !== "string") return null;
    return {
      root: selected,
      name: getFileName(selected),
    };
  }
  // Browser fallback keeps demo workspace active
  return null;
}

export async function pickSaveAsPath(defaultName: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const selected = await saveDialog({ defaultPath: defaultName });
    return selected ?? null;
  }
  return null;
}

export function triggerBrowserDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

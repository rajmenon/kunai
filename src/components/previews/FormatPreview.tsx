import React, { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import {
  X,
  ChevronRight,
  ChevronDown,
  Copy,
  Search,
  GitCompare,
  Eye,
  Clipboard,
  Table,
  ListTree,
  ChevronsDownUp,
  ChevronsUpDown,
  AlertTriangle,
  ShieldAlert,
  Columns2,
  Code2,
  ArrowLeft,
} from "lucide-react";
import type { DiffLine, DiffResult, FormatPreviewProps, FormatResult } from "../../types/editor";
import {
  formatDocument as clientFormatDocument,
  parseCsvRows,
  parseStructuredData,
} from "../../utils/clientTransforms";
import {
  isSafeToPreview,
  sanitizeMarkdownHtml,
  type SafePreviewFormat,
} from "../../utils/previewSecurity";

// ============================================================================
// Pure React JSX Syntax Highlighter (ZERO dangerouslySetInnerHTML / innerHTML)
// ============================================================================

interface CodeToken {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

const SQL_KEYWORD_RE =
  /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|GROUP|ORDER|BY|ASC|DESC|HAVING|LIMIT|OFFSET|DISTINCT|ALL|UNION|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|CHECK|CONSTRAINT|CASE|WHEN|THEN|ELSE|END|BETWEEN|LIKE|ILIKE|EXISTS|WITH|RECURSIVE|RETURNING|COALESCE|COUNT|SUM|AVG|MIN|MAX|CAST)\b/g;

function tokenizeLine(line: string, format: SafePreviewFormat, lineIndex: number): CodeToken[] {
  if (!line) return [{ text: " " }];

  if (format === "json") {
    const tokens: CodeToken[] = [];
    const re =
      /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) tokens.push({ text: line.slice(last, m.index) });
      if (m[1]) {
        tokens.push({ text: m[1], color: "var(--cyan)" });
        const afterKey = m[0].slice(m[1].length);
        tokens.push({ text: afterKey, color: "var(--text-muted)" });
      } else if (m[2]) {
        tokens.push({ text: m[2], color: "var(--success)" });
      } else if (m[3]) {
        tokens.push({ text: m[3], color: "var(--purple)", bold: true });
      } else if (m[4]) {
        tokens.push({ text: m[4], color: "var(--orange)" });
      } else if (m[5]) {
        tokens.push({ text: m[5], color: "var(--text-muted)" });
      }
      last = re.lastIndex;
    }
    if (last < line.length) tokens.push({ text: line.slice(last) });
    return tokens;
  }

  if (format === "yaml") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      return [{ text: line, color: "var(--text-muted)", italic: true }];
    }
    const tokens: CodeToken[] = [];
    const m = line.match(/^(\s*)(-\s+)?([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')(\s*:)(\s*)(.*)$/);
    if (m) {
      if (m[1]) tokens.push({ text: m[1] });
      if (m[2]) tokens.push({ text: m[2], color: "var(--accent)", bold: true });
      tokens.push({ text: m[3], color: "var(--cyan)" });
      tokens.push({ text: m[4], color: "var(--text-muted)" });
      if (m[5]) tokens.push({ text: m[5] });
      if (m[6]) tokens.push(...tokenizeScalarValue(m[6]));
      return tokens;
    }
    const seq = line.match(/^(\s*)(-\s+)(.*)$/);
    if (seq) {
      if (seq[1]) tokens.push({ text: seq[1] });
      tokens.push({ text: seq[2], color: "var(--accent)", bold: true });
      tokens.push(...tokenizeScalarValue(seq[3]));
      return tokens;
    }
    return [{ text: line, color: "var(--text-primary)" }];
  }

  if (format === "toml") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      return [{ text: line, color: "var(--text-muted)", italic: true }];
    }
    if (trimmed.startsWith("[")) {
      return [{ text: line, color: "var(--accent)", bold: true }];
    }
    const eq = line.indexOf("=");
    if (eq > 0) {
      return [
        { text: line.slice(0, eq), color: "var(--cyan)" },
        { text: "=", color: "var(--text-muted)" },
        ...tokenizeScalarValue(line.slice(eq + 1)),
      ];
    }
    return [{ text: line }];
  }

  if (format === "xml") {
    const tokens: CodeToken[] = [];
    const re =
      /(<!--[\s\S]*?-->)|(<!DOCTYPE[^>]*>)|(<\?[\s\S]*?\?>)|(<\/?)([A-Za-z_][\w:.-]*)|([A-Za-z_][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')|(\/?>)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) tokens.push({ text: line.slice(last, m.index) });
      if (m[1]) {
        tokens.push({ text: m[1], color: "var(--text-muted)", italic: true });
      } else if (m[2] || m[3]) {
        tokens.push({ text: m[0], color: "var(--purple)" });
      } else if (m[4] && m[5]) {
        tokens.push({ text: m[4], color: "var(--text-muted)" });
        tokens.push({ text: m[5], color: "var(--accent)" });
      } else if (m[6]) {
        tokens.push({ text: m[6], color: "var(--cyan)" });
        tokens.push({ text: m[7], color: "var(--text-muted)" });
        tokens.push({ text: m[8], color: "var(--success)" });
      } else if (m[9]) {
        tokens.push({ text: m[9], color: "var(--text-muted)" });
      }
      last = re.lastIndex;
    }
    if (last < line.length) tokens.push({ text: line.slice(last) });
    return tokens;
  }

  if (format === "css") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) {
      return [{ text: line, color: "var(--text-muted)", italic: true }];
    }
    if (trimmed.startsWith("@")) {
      return [{ text: line, color: "var(--purple)", bold: true }];
    }
    if (trimmed.endsWith("{") || trimmed === "}") {
      return [{ text: line, color: "var(--accent)" }];
    }
    const colon = line.indexOf(":");
    if (colon > 0 && trimmed.endsWith(";")) {
      return [
        { text: line.slice(0, colon), color: "var(--cyan)" },
        { text: ":", color: "var(--text-muted)" },
        { text: line.slice(colon + 1, -1), color: "var(--orange)" },
        { text: ";", color: "var(--text-muted)" },
      ];
    }
    return [{ text: line }];
  }

  if (format === "sql") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("--")) {
      return [{ text: line, color: "var(--text-muted)", italic: true }];
    }
    const tokens: CodeToken[] = [];
    const re = new RegExp(
      `(--[^\\n]*)|('(?:''|[^'])*')|(\\b\\d+(?:\\.\\d+)?\\b)|${SQL_KEYWORD_RE.source}`,
      "gi"
    );
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) tokens.push({ text: line.slice(last, m.index) });
      if (m[1]) {
        tokens.push({ text: m[1], color: "var(--text-muted)", italic: true });
      } else if (m[2]) {
        tokens.push({ text: m[2], color: "var(--success)" });
      } else if (m[3]) {
        tokens.push({ text: m[3], color: "var(--orange)" });
      } else if (m[4]) {
        tokens.push({ text: m[4], color: "var(--accent)", bold: true });
      }
      last = re.lastIndex;
    }
    if (last < line.length) tokens.push({ text: line.slice(last) });
    return tokens;
  }

  if (format === "csv") {
    if (lineIndex === 0) {
      return [{ text: line, color: "var(--accent)", bold: true }];
    }
    const colColors = ["var(--text-primary)", "var(--cyan)", "var(--success)", "var(--orange)"];
    const parts = line.split(",");
    const tokens: CodeToken[] = [];
    parts.forEach((part, idx) => {
      if (idx > 0) tokens.push({ text: ",", color: "var(--text-muted)" });
      tokens.push({ text: part, color: colColors[idx % colColors.length] });
    });
    return tokens;
  }

  return [{ text: line }];
}

function tokenizeScalarValue(raw: string): CodeToken[] {
  const trimmed = raw.trim();
  if (!trimmed) return [{ text: raw }];
  if (trimmed === "true" || trimmed === "false" || trimmed === "null" || trimmed === "~") {
    return [{ text: raw, color: "var(--purple)", bold: true }];
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    return [{ text: raw, color: "var(--orange)" }];
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return [{ text: raw, color: "var(--success)" }];
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return [{ text: raw, color: "var(--text-primary)" }];
  }
  return [{ text: raw, color: "var(--success)" }];
}

const PrettyCodeView: React.FC<{
  code: string;
  format: SafePreviewFormat;
}> = ({ code, format }) => {
  const lines = useMemo(() => code.split(/\r\n|\r|\n/), [code]);

  return (
    <div
      className="kunai-pretty-code"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        lineHeight: 1.6,
        padding: "10px 0 24px",
        overflow: "auto",
        flex: 1,
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            padding: "0 14px 0 0",
            minHeight: 20,
          }}
        >
          <span
            style={{
              width: 46,
              minWidth: 46,
              paddingRight: 12,
              textAlign: "right",
              color: "var(--text-muted)",
              userSelect: "none",
              opacity: 0.65,
              flexShrink: 0,
            }}
          >
            {i + 1}
          </span>
          <span style={{ whiteSpace: "pre", flex: 1 }}>
            {tokenizeLine(line, format, i).map((tok, ti) => (
              <span
                key={ti}
                style={{
                  color: tok.color ?? "var(--text-primary)",
                  fontWeight: tok.bold ? 600 : undefined,
                  fontStyle: tok.italic ? "italic" : undefined,
                }}
              >
                {tok.text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Structured Data Tree Inspector (JSON / YAML / TOML)
// ============================================================================

function getValueType(val: unknown): "null" | "boolean" | "number" | "string" | "array" | "object" {
  if (val === null || val === undefined) return "null";
  if (Array.isArray(val)) return "array";
  const t = typeof val;
  if (t === "boolean" || t === "number" || t === "string") return t;
  return "object";
}

const TYPE_COLORS: Record<string, string> = {
  string: "var(--success)",
  number: "var(--orange)",
  boolean: "var(--purple)",
  null: "var(--text-muted)",
  array: "var(--cyan)",
  object: "var(--accent)",
};

interface JsonTreeNodeProps {
  label: string;
  value: unknown;
  path: string;
  depth: number;
  defaultOpenDepth: number;
  expandSignal: { version: number; open: boolean };
  onCopyPath: (path: string) => void;
}

const JsonTreeNode: React.FC<JsonTreeNodeProps> = ({
  label,
  value,
  path,
  depth,
  defaultOpenDepth,
  expandSignal,
  onCopyPath,
}) => {
  const [open, setOpen] = useState(depth < defaultOpenDepth);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (expandSignal.version > 0) {
      setOpen(expandSignal.open);
    }
  }, [expandSignal]);

  const vType = getValueType(value);
  const isContainer = vType === "array" || vType === "object";
  const entries: [string, unknown, string][] = useMemo(() => {
    if (vType === "array") {
      return (value as unknown[]).map((v, i) => [String(i), v, `${path}[${i}]`]);
    }
    if (vType === "object" && value !== null) {
      return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        const nextPath = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`;
        return [k, v, nextPath];
      });
    }
    return [];
  }, [vType, value, path]);

  const previewVal = useMemo(() => {
    if (vType === "string") {
      const s = String(value);
      return `"${s.length > 90 ? s.slice(0, 90) + "…" : s}"`;
    }
    if (vType === "null") return "null";
    if (vType === "boolean" || vType === "number") return String(value);
    if (vType === "array") return `[${entries.length}]`;
    return `{${entries.length}}`;
  }, [vType, value, entries.length]);

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
      <div
        onClick={() => isContainer && setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          padding: `2px 8px 2px ${6 + depth * 14}px`,
          borderRadius: 4,
          cursor: isContainer ? "pointer" : "default",
          background: hovered ? "var(--bg-hover)" : "transparent",
          lineHeight: 1.55,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, flex: 1 }}>
          {isContainer ? (
            open ? (
              <ChevronDown size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            ) : (
              <ChevronRight size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            )
          ) : (
            <span style={{ width: 12, flexShrink: 0 }} />
          )}

          <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{label}</span>
          <span style={{ color: "var(--text-muted)" }}>:</span>

          <span
            style={{
              color: TYPE_COLORS[vType],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {previewVal}
          </span>

          <span
            style={{
              fontSize: 9.5,
              padding: "0 4px",
              borderRadius: 3,
              background: "var(--bg-badge)",
              color: TYPE_COLORS[vType],
              opacity: 0.85,
              flexShrink: 0,
            }}
          >
            {vType === "array"
              ? `arr(${entries.length})`
              : vType === "object"
                ? `obj(${entries.length})`
                : vType.slice(0, 4)}
          </span>
        </div>

        {hovered && (
          <button
            type="button"
            title={`Copy path: ${path}`}
            onClick={(e) => {
              e.stopPropagation();
              onCopyPath(path);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              height: 18,
              padding: "0 5px",
              borderRadius: 3,
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text-secondary)",
              fontSize: 10,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Copy size={9} />
            <span>{path}</span>
          </button>
        )}
      </div>

      {isContainer && open && (
        <div>
          {entries.map(([k, v, childPath]) => (
            <JsonTreeNode
              key={childPath}
              label={k}
              value={v}
              path={childPath}
              depth={depth + 1}
              defaultOpenDepth={defaultOpenDepth}
              expandSignal={expandSignal}
              onCopyPath={onCopyPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Side-by-Side Diff Pairing Helper
// ============================================================================

interface SideBySideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function buildSideBySideRows(hunks: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < hunks.length) {
    const h = hunks[i];
    if (h.kind === "equal") {
      rows.push({ left: h, right: h });
      i++;
    } else {
      const deletes: DiffLine[] = [];
      const inserts: DiffLine[] = [];
      while (i < hunks.length && hunks[i].kind !== "equal") {
        if (hunks[i].kind === "delete") deletes.push(hunks[i]);
        else inserts.push(hunks[i]);
        i++;
      }
      const max = Math.max(deletes.length, inserts.length);
      for (let k = 0; k < max; k++) {
        rows.push({ left: deletes[k] ?? null, right: inserts[k] ?? null });
      }
    }
  }
  return rows;
}

// ============================================================================
// Main FormatPreview Component (ZERO <iframe>, Strict Security Allowlist)
// ============================================================================

export const FormatPreview: React.FC<FormatPreviewProps> = ({
  mode,
  tab,
  allTabs,
  isFullPreview = false,
  onToggleSideBySide,
  onFormatDocument,
  tabSize,
  useTabs,
  onConvertFormat,
  onQueryJson,
  onComputeDiff,
  onClose,
  onCopyText,
  onJumpToLine,
}) => {
  const safety = useMemo(
    () => isSafeToPreview(tab.language, tab.path ?? tab.title),
    [tab.language, tab.path, tab.title]
  );
  const safeFormat = safety.allowed ? safety.format : undefined;

  // Sub-view mode for structured formats (default: "pretty"!)
  const [structuredTab, setStructuredTab] = useState<"pretty" | "tree">("pretty");
  const [csvTab, setCsvTab] = useState<"pretty" | "table">("pretty");

  // Reset to pretty-printed default when switching tabs
  useEffect(() => {
    setStructuredTab("pretty");
    setCsvTab("pretty");
    setJsonPath("$");
  }, [tab.id]);

  // Pretty-printed formatted result for all non-markdown safe formats
  const isCodeFormat = Boolean(safeFormat && safeFormat !== "markdown");
  const syncFormatted = useMemo<FormatResult | null>(() => {
    if (mode !== "preview" || !safeFormat || safeFormat === "markdown") return null;
    return clientFormatDocument(tab.content, safeFormat, tabSize, useTabs, false);
  }, [mode, safeFormat, tab.content, tabSize, useTabs]);

  const [asyncFormatted, setAsyncFormatted] = useState<FormatResult | null>(null);

  useEffect(() => {
    if (mode !== "preview" || !safeFormat || safeFormat === "markdown") {
      setAsyncFormatted(null);
      return;
    }
    let cancelled = false;
    onFormatDocument(tab.content, safeFormat, tabSize, useTabs, false)
      .then((res) => {
        if (!cancelled) setAsyncFormatted(res);
      })
      .catch(() => {
        // Fallback to syncFormatted seamlessly
      });
    return () => {
      cancelled = true;
    };
  }, [mode, safeFormat, tab.content, tabSize, useTabs, onFormatDocument]);

  const activeFormatted = asyncFormatted ?? syncFormatted;

  // Structured data inspector state (JSON / YAML / TOML)
  const [jsonPath, setJsonPath] = useState("$");
  const [queryResult, setQueryResult] = useState<FormatResult | null>(null);
  const [expandSignal, setExpandSignal] = useState({ version: 0, open: true });

  // Diff state
  const otherTabs = useMemo(() => allTabs.filter((t) => t.id !== tab.id), [allTabs, tab.id]);
  const [diffTargetId, setDiffTargetId] = useState<string>("__saved__");
  const [clipboardText, setClipboardText] = useState<string>("");
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");

  useEffect(() => {
    if (
      diffTargetId !== "__saved__" &&
      diffTargetId !== "__clipboard__" &&
      !otherTabs.some((t) => t.id === diffTargetId)
    ) {
      setDiffTargetId("__saved__");
    }
  }, [otherTabs, diffTargetId]);

  const diffLeftText = useMemo(() => {
    if (diffTargetId === "__saved__") return tab.savedContent;
    if (diffTargetId === "__clipboard__") return clipboardText;
    return otherTabs.find((t) => t.id === diffTargetId)?.content ?? "";
  }, [diffTargetId, tab.savedContent, clipboardText, otherTabs]);

  const diffLeftLabel = useMemo(() => {
    if (diffTargetId === "__saved__") return `${tab.title} (Saved)`;
    if (diffTargetId === "__clipboard__") return "Clipboard / Custom";
    return otherTabs.find((t) => t.id === diffTargetId)?.title ?? "Compare";
  }, [diffTargetId, tab.title, otherTabs]);

  useEffect(() => {
    if (mode !== "diff") return;
    let cancelled = false;
    onComputeDiff(diffLeftText, tab.content).then((res) => {
      if (!cancelled) setDiffResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, diffLeftText, tab.content, onComputeDiff]);

  // Strictly DOM-sanitized GFM Markdown HTML
  const markdownHtml = useMemo(() => {
    if (mode !== "preview" || safeFormat !== "markdown") return "";
    const rendered = marked.parse(tab.content, {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return sanitizeMarkdownHtml(rendered);
  }, [mode, safeFormat, tab.content]);

  const isTreeCapable =
    safeFormat === "json" || safeFormat === "yaml" || safeFormat === "toml";

  const parsedStructured = useMemo(() => {
    if (mode !== "preview" || !isTreeCapable) {
      return { ok: false as const, data: null, error: null };
    }
    try {
      const data = parseStructuredData(tab.content, safeFormat);
      return { ok: true as const, data, error: null };
    } catch (err) {
      return {
        ok: false as const,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [mode, isTreeCapable, tab.content, safeFormat]);

  const csvRows = useMemo(() => {
    if (mode !== "preview" || safeFormat !== "csv") return [];
    return parseCsvRows(tab.content);
  }, [mode, safeFormat, tab.content]);

  // Live JSONPath evaluation
  useEffect(() => {
    if (mode !== "preview" || !isTreeCapable || !parsedStructured.ok) {
      setQueryResult(null);
      return;
    }
    const q = jsonPath.trim();
    if (!q || q === "$") {
      setQueryResult(null);
      return;
    }
    let cancelled = false;
    const jsonSource =
      safeFormat === "json" ? tab.content : JSON.stringify(parsedStructured.data);
    onQueryJson(jsonSource, q).then((res) => {
      if (!cancelled) setQueryResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, isTreeCapable, parsedStructured, jsonPath, safeFormat, tab.content, onQueryJson]);

  const loadClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setClipboardText(text);
    } catch {
      // Clipboard API may be blocked; textarea allows manual paste
    }
  };

  const sideBySideRows = useMemo(
    () => (diffResult ? buildSideBySideRows(diffResult.hunks) : []),
    [diffResult]
  );

  const headerTitle =
    mode === "diff"
      ? "Diff Viewer"
      : !safety.allowed
        ? "Preview Blocked"
        : safeFormat === "markdown"
          ? "Markdown Preview"
          : `${safeFormat?.toUpperCase()} Pretty Preview`;

  return (
    <section
      className="kunai-preview"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: "var(--bg-primary)",
        borderLeft: isFullPreview ? "none" : "1px solid var(--border)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
      }}
    >
      {/* Scoped Markdown styles */}
      <style>{`
        .kunai-md-preview { padding: 22px 28px 44px; line-height: 1.65; font-size: 13.5px; color: var(--text-primary); max-width: 920px; }
        .kunai-md-preview h1, .kunai-md-preview h2, .kunai-md-preview h3, .kunai-md-preview h4 {
          margin: 1.25em 0 0.5em; font-weight: 650; line-height: 1.3; color: var(--text-primary);
        }
        .kunai-md-preview h1 { font-size: 1.75em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); margin-top: 0; }
        .kunai-md-preview h2 { font-size: 1.35em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border-subtle); }
        .kunai-md-preview h3 { font-size: 1.12em; }
        .kunai-md-preview p { margin: 0.65em 0; }
        .kunai-md-preview a { color: var(--accent); text-decoration: none; }
        .kunai-md-preview a:hover { text-decoration: underline; }
        .kunai-md-preview code {
          font-family: var(--font-mono); font-size: 0.88em; padding: 2px 5px;
          border-radius: 4px; background: var(--bg-elevated); color: var(--cyan);
        }
        .kunai-md-preview pre {
          background: var(--bg-secondary); border: 1px solid var(--border);
          border-radius: 6px; padding: 12px 14px; overflow-x: auto; margin: 12px 0;
        }
        .kunai-md-preview pre code { background: transparent; padding: 0; color: var(--text-primary); font-size: 12px; }
        .kunai-md-preview blockquote {
          margin: 12px 0; padding: 6px 14px; border-left: 3px solid var(--accent);
          background: var(--accent-soft); border-radius: 0 5px 5px 0; color: var(--text-secondary);
        }
        .kunai-md-preview table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 12.5px; }
        .kunai-md-preview th, .kunai-md-preview td {
          border: 1px solid var(--border); padding: 6px 10px; text-align: left;
        }
        .kunai-md-preview th { background: var(--bg-secondary); font-weight: 600; }
        .kunai-md-preview ul, .kunai-md-preview ol { padding-left: 22px; margin: 0.6em 0; }
        .kunai-md-preview li { margin: 0.25em 0; }
        .kunai-md-preview hr { border: none; border-top: 1px solid var(--border); margin: 18px 0; }
        .kunai-md-preview input[type="checkbox"] { accent-color: var(--accent); margin-right: 6px; }
      `}</style>

      {/* Header Bar */}
      <div
        style={{
          height: 34,
          minHeight: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 10px",
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          gap: 8,
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {mode === "diff" ? (
            <GitCompare size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
          ) : !safety.allowed ? (
            <ShieldAlert size={13} style={{ color: "var(--warning)", flexShrink: 0 }} />
          ) : (
            <Eye size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
          )}

          <span style={{ fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>
            {headerTitle}
          </span>

          {isFullPreview && mode === "preview" && safety.allowed && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 999,
                background: "var(--accent-soft)",
                border: "1px solid var(--accent-border)",
                color: "var(--accent)",
                flexShrink: 0,
              }}
            >
              FULL PREVIEW
            </span>
          )}

          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {tab.title}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {mode === "preview" && safety.allowed && (
            <button
              type="button"
              onClick={onToggleSideBySide}
              title={
                isFullPreview
                  ? "Open Markup & Preview Side-by-Side (Ctrl+Shift+V)"
                  : "Toggle Preview Mode (Ctrl+Shift+V)"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 23,
                padding: "0 8px",
                borderRadius: 4,
                border: isFullPreview
                  ? "1px solid var(--accent-border)"
                  : "1px solid var(--border)",
                background: isFullPreview ? "var(--accent-soft)" : "var(--bg-elevated)",
                color: isFullPreview ? "var(--accent)" : "var(--text-secondary)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <Columns2 size={11} />
              <span>{isFullPreview ? "Edit Side-by-Side" : "Side-by-Side"}</span>
              {isFullPreview && (
                <kbd
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9.5,
                    opacity: 0.85,
                    padding: "0 3px",
                    borderRadius: 3,
                    background: "var(--bg-secondary)",
                  }}
                >
                  Ctrl+Shift+V
                </kbd>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            title={isFullPreview ? "Return to Editor" : "Close Pane"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ================= SECURITY BLOCKED PANEL ================= */}
      {mode === "preview" && !safety.allowed && (
        <div
          className="kunai-preview-blocked"
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 28,
          }}
        >
          <div
            style={{
              maxWidth: 460,
              padding: "22px 24px",
              borderRadius: 10,
              border: "1px solid var(--border-strong)",
              background: "var(--bg-secondary)",
              boxShadow: "var(--shadow-sm)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "var(--warning-soft)",
                  color: "var(--warning)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <ShieldAlert size={20} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text-primary)" }}>
                  Preview Blocked for Security
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {tab.title}
                </div>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
              {safety.reason ??
                "Executable and scriptable files are never previewed in Kunai to prevent untrusted code or script execution."}
            </p>

            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-muted)",
                background: "var(--bg-tertiary)",
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid var(--border-subtle)",
              }}
            >
              Safe preview formats: <strong style={{ color: "var(--text-secondary)" }}>Markdown, JSON, YAML, TOML, XML, CSS, SQL, CSV</strong>.
            </div>

            <div>
              <button
                type="button"
                onClick={onClose}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 30,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: "1px solid var(--accent-border)",
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <ArrowLeft size={13} />
                <span>Return to Editor</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DIFF VIEWER MODE ================= */}
      {mode === "diff" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 10px",
              background: "var(--bg-tertiary)",
              borderBottom: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Compare with:</span>
              <select
                value={diffTargetId}
                onChange={(e) => {
                  const val = e.target.value;
                  setDiffTargetId(val);
                  if (val === "__clipboard__") loadClipboard();
                }}
                style={{
                  height: 24,
                  padding: "0 8px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                  fontSize: 11.5,
                  outline: "none",
                }}
              >
                <option value="__saved__">Saved Version ({tab.title})</option>
                <option value="__clipboard__">Clipboard / Paste Text</option>
                {otherTabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    Tab: {t.title}
                  </option>
                ))}
              </select>

              {diffTargetId === "__clipboard__" && (
                <button type="button" onClick={loadClipboard} style={miniBtnStyle}>
                  <Clipboard size={11} />
                  <span>Read Clipboard</span>
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {diffResult && (
                <>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--success-soft)",
                      color: "var(--success)",
                    }}
                  >
                    +{diffResult.additions}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--danger-soft)",
                      color: "var(--danger)",
                    }}
                  >
                    -{diffResult.deletions}
                  </span>
                </>
              )}
              <div
                style={{
                  display: "inline-flex",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={() => setDiffStyle("split")}
                  style={segBtn(diffStyle === "split")}
                >
                  Side-by-Side
                </button>
                <button
                  type="button"
                  onClick={() => setDiffStyle("unified")}
                  style={segBtn(diffStyle === "unified")}
                >
                  Unified
                </button>
              </div>
            </div>
          </div>

          {diffTargetId === "__clipboard__" && (
            <div
              style={{
                padding: "6px 10px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-secondary)",
              }}
            >
              <textarea
                value={clipboardText}
                onChange={(e) => setClipboardText(e.target.value)}
                placeholder="Paste text here to diff against the current tab..."
                rows={3}
                style={{
                  width: "100%",
                  resize: "vertical",
                  borderRadius: 5,
                  border: "1px solid var(--border)",
                  background: "var(--bg-primary)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  padding: 6,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}

          {diffStyle === "split" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                background: "var(--bg-secondary)",
                borderBottom: "1px solid var(--border)",
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              <div style={{ padding: "4px 10px", borderRight: "1px solid var(--border)" }}>
                Left: <strong style={{ color: "var(--text-secondary)" }}>{diffLeftLabel}</strong>
              </div>
              <div style={{ padding: "4px 10px" }}>
                Right: <strong style={{ color: "var(--text-secondary)" }}>{tab.title} (Current)</strong>
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
            {diffResult && diffResult.additions === 0 && diffResult.deletions === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--text-muted)" }}>
                Files are identical — 0 differences found.
              </div>
            ) : diffStyle === "split" ? (
              <div style={{ minWidth: 520 }}>
                {sideBySideRows.map((row, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        borderRight: "1px solid var(--border)",
                        background:
                          row.left?.kind === "delete"
                            ? "var(--diff-del-bg)"
                            : !row.left
                              ? "var(--bg-secondary)"
                              : "transparent",
                        minHeight: 20,
                      }}
                    >
                      <span
                        style={{
                          width: 38,
                          padding: "1px 6px",
                          textAlign: "right",
                          color: "var(--text-muted)",
                          background: row.left?.kind === "delete" ? "var(--diff-del-gutter)" : "transparent",
                          userSelect: "none",
                          flexShrink: 0,
                        }}
                      >
                        {row.left?.left_line ?? ""}
                      </span>
                      <pre
                        style={{
                          margin: 0,
                          padding: "1px 8px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          flex: 1,
                        }}
                      >
                        {row.left?.text ?? ""}
                      </pre>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        background:
                          row.right?.kind === "insert"
                            ? "var(--diff-add-bg)"
                            : !row.right
                              ? "var(--bg-secondary)"
                              : "transparent",
                        minHeight: 20,
                      }}
                    >
                      <span
                        style={{
                          width: 38,
                          padding: "1px 6px",
                          textAlign: "right",
                          color: "var(--text-muted)",
                          background: row.right?.kind === "insert" ? "var(--diff-add-gutter)" : "transparent",
                          userSelect: "none",
                          flexShrink: 0,
                        }}
                      >
                        {row.right?.right_line ?? ""}
                      </span>
                      <pre
                        style={{
                          margin: 0,
                          padding: "1px 8px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          flex: 1,
                        }}
                      >
                        {row.right?.text ?? ""}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div>
                {(diffResult?.hunks ?? []).map((h, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      background:
                        h.kind === "insert"
                          ? "var(--diff-add-bg)"
                          : h.kind === "delete"
                            ? "var(--diff-del-bg)"
                            : "transparent",
                    }}
                  >
                    <span style={{ width: 36, padding: "1px 5px", textAlign: "right", color: "var(--text-muted)", flexShrink: 0 }}>
                      {h.left_line ?? ""}
                    </span>
                    <span style={{ width: 36, padding: "1px 5px", textAlign: "right", color: "var(--text-muted)", flexShrink: 0 }}>
                      {h.right_line ?? ""}
                    </span>
                    <span
                      style={{
                        width: 16,
                        textAlign: "center",
                        color:
                          h.kind === "insert"
                            ? "var(--success)"
                            : h.kind === "delete"
                              ? "var(--danger)"
                              : "var(--text-muted)",
                        flexShrink: 0,
                      }}
                    >
                      {h.kind === "insert" ? "+" : h.kind === "delete" ? "-" : " "}
                    </span>
                    <pre style={{ margin: 0, padding: "1px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}>
                      {h.text}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= MARKDOWN SANITIZED PREVIEW ================= */}
      {mode === "preview" && safeFormat === "markdown" && (
        <div
          className="kunai-md-preview"
          style={{ flex: 1, overflowY: "auto" }}
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      )}

      {/* ================= SAFE PRETTY-PRINTED FORMAT PREVIEWS ================= */}
      {mode === "preview" && isCodeFormat && safeFormat && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {/* Preview Toolbar: Sub-view tabs + Convert + Copy Formatted */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 10px",
              background: "var(--bg-tertiary)",
              borderBottom: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {isTreeCapable && (
                <div
                  style={{
                    display: "inline-flex",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setStructuredTab("pretty")}
                    style={segBtn(structuredTab === "pretty")}
                  >
                    <Code2 size={11} style={{ marginRight: 4 }} />
                    <span>Pretty Formatted</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setStructuredTab("tree")}
                    style={segBtn(structuredTab === "tree")}
                  >
                    <ListTree size={11} style={{ marginRight: 4 }} />
                    <span>Tree &amp; Query</span>
                  </button>
                </div>
              )}

              {safeFormat === "csv" && (
                <div
                  style={{
                    display: "inline-flex",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setCsvTab("pretty")}
                    style={segBtn(csvTab === "pretty")}
                  >
                    <Code2 size={11} style={{ marginRight: 4 }} />
                    <span>Pretty Aligned</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCsvTab("table")}
                    style={segBtn(csvTab === "table")}
                  >
                    <Table size={11} style={{ marginRight: 4 }} />
                    <span>Table</span>
                  </button>
                </div>
              )}

              {!isTreeCapable && safeFormat !== "csv" && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--accent)",
                  }}
                >
                  <Code2 size={12} />
                  <span>Pretty Formatted {safeFormat.toUpperCase()}</span>
                </span>
              )}

              {(isTreeCapable || safeFormat === "csv") && (
                <div style={{ display: "flex", alignItems: "center", gap: 3, marginLeft: 4 }}>
                  {(["json", "yaml", "toml", "csv"] as const).map((fmt) => {
                    const isCurrent = safeFormat === fmt;
                    return (
                      <button
                        key={fmt}
                        type="button"
                        disabled={isCurrent}
                        onClick={() => onConvertFormat(fmt)}
                        title={`Convert to ${fmt.toUpperCase()}`}
                        style={{
                          ...miniBtnStyle,
                          opacity: isCurrent ? 0.4 : 1,
                          cursor: isCurrent ? "default" : "pointer",
                          fontWeight: 600,
                        }}
                      >
                        →{fmt.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {isTreeCapable && structuredTab === "tree" && (
                <>
                  <button
                    type="button"
                    title="Expand All"
                    onClick={() => setExpandSignal((s) => ({ version: s.version + 1, open: true }))}
                    style={miniBtnStyle}
                  >
                    <ChevronsUpDown size={11} />
                  </button>
                  <button
                    type="button"
                    title="Collapse All"
                    onClick={() => setExpandSignal((s) => ({ version: s.version + 1, open: false }))}
                    style={miniBtnStyle}
                  >
                    <ChevronsDownUp size={11} />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() =>
                  onCopyText(
                    activeFormatted?.ok ? activeFormatted.output : tab.content,
                    `Copied formatted ${safeFormat.toUpperCase()}`
                  )
                }
                style={miniBtnStyle}
              >
                <Copy size={11} />
                <span>Copy Formatted</span>
              </button>
            </div>
          </div>

          {/* Syntax error callout (if parse/format failed) */}
          {activeFormatted && !activeFormatted.ok && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "7px 12px",
                background: "var(--danger-soft)",
                borderBottom: "1px solid var(--danger)",
                color: "var(--danger)",
                fontSize: 11.5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {activeFormatted.error ?? `Invalid ${safeFormat.toUpperCase()}`}
                  {activeFormatted.error_line
                    ? ` (Ln ${activeFormatted.error_line}, Col ${activeFormatted.error_col ?? 1})`
                    : ""}
                </span>
              </div>
              {activeFormatted.error_line && onJumpToLine && (
                <button
                  type="button"
                  onClick={() => onJumpToLine(activeFormatted.error_line!)}
                  style={{
                    ...miniBtnStyle,
                    borderColor: "var(--danger)",
                    color: "var(--danger)",
                    flexShrink: 0,
                  }}
                >
                  Jump to Ln {activeFormatted.error_line}
                </button>
              )}
            </div>
          )}

          {/* TREE & QUERY VIEW (for JSON / YAML / TOML when selected) */}
          {isTreeCapable && structuredTab === "tree" ? (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-secondary)",
                }}
              >
                <Search size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <input
                  type="text"
                  value={jsonPath}
                  onChange={(e) => setJsonPath(e.target.value)}
                  placeholder="JSONPath query (e.g. $.services[*].name or $.server.port)"
                  style={{
                    flex: 1,
                    height: 24,
                    padding: "0 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    outline: "none",
                  }}
                />
                {jsonPath !== "$" && (
                  <button type="button" onClick={() => setJsonPath("$")} style={miniBtnStyle}>
                    Reset
                  </button>
                )}
              </div>

              {queryResult && (
                <div
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-tertiary)",
                    maxHeight: "34%",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "4px 10px",
                      fontSize: 10.5,
                      color: queryResult.ok ? "var(--accent)" : "var(--danger)",
                      fontWeight: 600,
                    }}
                  >
                    <span>
                      {queryResult.ok ? `Query Result: ${jsonPath}` : `Query Error: ${queryResult.error}`}
                    </span>
                    {queryResult.ok && (
                      <button
                        type="button"
                        onClick={() => onCopyText(queryResult.output, "Query result copied")}
                        style={miniBtnStyle}
                      >
                        <Copy size={10} />
                        <span>Copy</span>
                      </button>
                    )}
                  </div>
                  {queryResult.ok && (
                    <pre
                      style={{
                        margin: 0,
                        padding: "4px 10px 10px",
                        overflow: "auto",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        color: "var(--text-primary)",
                      }}
                    >
                      {queryResult.output}
                    </pre>
                  )}
                </div>
              )}

              <div style={{ flex: 1, overflow: "auto", padding: "8px 6px" }}>
                {!parsedStructured.ok ? (
                  <div style={{ padding: 16, color: "var(--danger)", fontSize: 12 }}>
                    Fix syntax errors to inspect the interactive tree.
                  </div>
                ) : (
                  <JsonTreeNode
                    label="$"
                    value={parsedStructured.data}
                    path="$"
                    depth={0}
                    defaultOpenDepth={3}
                    expandSignal={expandSignal}
                    onCopyPath={(p) => {
                      setJsonPath(p);
                      onCopyText(p, `Copied ${p}`);
                    }}
                  />
                )}
              </div>
            </div>
          ) : safeFormat === "csv" && csvTab === "table" && csvRows.length > 0 ? (
            /* CSV TABLE VIEW (100% React-escaped) */
            <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                }}
              >
                <thead>
                  <tr>
                    <th style={csvThStyle}>#</th>
                    {csvRows[0].map((col, ci) => (
                      <th key={ci} style={csvThStyle}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvRows.slice(1).map((row, ri) => (
                    <tr key={ri}>
                      <td style={{ ...csvTdStyle, color: "var(--text-muted)", width: 32 }}>
                        {ri + 1}
                      </td>
                      {csvRows[0].map((_, ci) => (
                        <td key={ci} style={csvTdStyle}>
                          {row[ci] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* DEFAULT PRETTY-PRINTED FORMATTED VIEW (JSON/YAML/TOML/XML/CSS/SQL/CSV) */
            <PrettyCodeView
              code={activeFormatted?.ok ? activeFormatted.output : tab.content}
              format={safeFormat}
            />
          )}
        </div>
      )}
    </section>
  );
};

const miniBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 22,
  padding: "0 7px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: 10.5,
  cursor: "pointer",
};

function segBtn(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 22,
    padding: "0 8px",
    border: "none",
    background: active ? "var(--accent-soft)" : "var(--bg-elevated)",
    color: active ? "var(--accent)" : "var(--text-muted)",
    fontSize: 10.5,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
  };
}

const csvThStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  padding: "5px 8px",
  textAlign: "left",
  fontWeight: 600,
  color: "var(--text-primary)",
  position: "sticky",
  top: 0,
};

const csvTdStyle: React.CSSProperties = {
  border: "1px solid var(--border-subtle)",
  padding: "4px 8px",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};

export default FormatPreview;

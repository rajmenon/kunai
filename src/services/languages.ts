import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";

import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { go } from "@codemirror/lang-go";
import { php } from "@codemirror/lang-php";

import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";

import type { LanguageId, ThemeId, ValidationResult } from "../types/editor";

export interface LanguageMeta {
  id: LanguageId;
  label: string;
  shortLabel: string;
  color: string;
  extensions: string[];
  formattable?: boolean;
  validatable?: boolean;
  previewable?: boolean;
}

export const LANGUAGE_META: Record<LanguageId, LanguageMeta> = {
  typescript: {
    id: "typescript",
    label: "TypeScript",
    shortLabel: "TS",
    color: "#3178c6",
    extensions: ["ts", "tsx", "mts", "cts"],
  },
  javascript: {
    id: "javascript",
    label: "JavaScript",
    shortLabel: "JS",
    color: "#f7df1e",
    extensions: ["js", "jsx", "mjs", "cjs"],
  },
  rust: {
    id: "rust",
    label: "Rust",
    shortLabel: "RS",
    color: "#dea584",
    extensions: ["rs"],
  },
  python: {
    id: "python",
    label: "Python",
    shortLabel: "PY",
    color: "#3776ab",
    extensions: ["py", "pyw", "pyi"],
  },
  json: {
    id: "json",
    label: "JSON",
    shortLabel: "JSON",
    color: "#fbbf24",
    extensions: ["json", "jsonc", "geojson"],
    formattable: true,
    validatable: true,
    previewable: true,
  },
  yaml: {
    id: "yaml",
    label: "YAML",
    shortLabel: "YAML",
    color: "#f472b6",
    extensions: ["yaml", "yml"],
    formattable: true,
    validatable: true,
    previewable: true,
  },
  toml: {
    id: "toml",
    label: "TOML",
    shortLabel: "TOML",
    color: "#fb923c",
    extensions: ["toml"],
    formattable: true,
    validatable: true,
    previewable: true,
  },
  xml: {
    id: "xml",
    label: "XML",
    shortLabel: "XML",
    color: "#38bdf8",
    extensions: ["xml", "svg", "xhtml", "plist", "csproj"],
    formattable: true,
    validatable: true,
    previewable: true,
  },
  html: {
    id: "html",
    label: "HTML",
    shortLabel: "HTML",
    color: "#e34f26",
    extensions: ["html", "htm"],
    formattable: true,
    previewable: false,
  },
  css: {
    id: "css",
    label: "CSS",
    shortLabel: "CSS",
    color: "#38bdf8",
    extensions: ["css", "scss", "less"],
    formattable: true,
    previewable: true,
  },
  sql: {
    id: "sql",
    label: "SQL",
    shortLabel: "SQL",
    color: "#a78bfa",
    extensions: ["sql", "ddl", "dml"],
    formattable: true,
    previewable: true,
  },
  markdown: {
    id: "markdown",
    label: "Markdown",
    shortLabel: "MD",
    color: "#60a5fa",
    extensions: ["md", "markdown", "mdx"],
    previewable: true,
  },
  csv: {
    id: "csv",
    label: "CSV",
    shortLabel: "CSV",
    color: "#4ade80",
    extensions: ["csv", "tsv"],
    formattable: true,
    previewable: true,
  },
  cpp: {
    id: "cpp",
    label: "C / C++",
    shortLabel: "C++",
    color: "#659ad2",
    extensions: ["c", "h", "cpp", "hpp", "cc", "cxx"],
  },
  java: {
    id: "java",
    label: "Java",
    shortLabel: "JAVA",
    color: "#f89820",
    extensions: ["java"],
  },
  go: {
    id: "go",
    label: "Go",
    shortLabel: "GO",
    color: "#00add8",
    extensions: ["go"],
  },
  php: {
    id: "php",
    label: "PHP",
    shortLabel: "PHP",
    color: "#8892bf",
    extensions: ["php"],
  },
  shell: {
    id: "shell",
    label: "Shell",
    shortLabel: "SH",
    color: "#4ade80",
    extensions: ["sh", "bash", "zsh", "ps1", "bat", "cmd", "env"],
  },
  pdf: {
    id: "pdf",
    label: "PDF Document",
    shortLabel: "PDF",
    color: "#f43f5e",
    extensions: ["pdf"],
    previewable: true,
  },
  plaintext: {
    id: "plaintext",
    label: "Plain Text",
    shortLabel: "TXT",
    color: "#94a3b8",
    extensions: ["txt", "log", "ini", "conf", "gitignore"],
  },
};

export const LANGUAGE_LIST: LanguageMeta[] = Object.values(LANGUAGE_META);

export const THEME_OPTIONS: { id: ThemeId; label: string; isLight: boolean }[] = [
  { id: "zed-dark", label: "Zed One Dark", isLight: false },
  { id: "sublime-mariana", label: "Sublime Mariana", isLight: false },
  { id: "tokyo-night", label: "Tokyo Night", isLight: false },
  { id: "catppuccin-latte", label: "Catppuccin Latte", isLight: true },
];

export function detectLanguageFromPath(pathOrName: string): LanguageId {
  const normalized = pathOrName.replace(/\\/g, "/");
  const baseName = normalized.split("/").pop()?.toLowerCase() ?? "";

  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.")) return "shell";
  if (baseName === "makefile" || baseName === ".bashrc" || baseName === ".zshrc") return "shell";
  if (baseName === "cargo.lock") return "toml";

  const dotIdx = baseName.lastIndexOf(".");
  if (dotIdx <= 0) return "plaintext";
  const ext = baseName.slice(dotIdx + 1);

  for (const meta of LANGUAGE_LIST) {
    if (meta.extensions.includes(ext)) {
      return meta.id;
    }
  }
  return "plaintext";
}

export function getLanguageExtension(lang: LanguageId): Extension {
  switch (lang) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ typescript: false, jsx: true });
    case "rust":
      return rust();
    case "python":
      return python();
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "toml":
      return StreamLanguage.define(toml);
    case "xml":
      return xml();
    case "html":
      return html();
    case "css":
      return css();
    case "sql":
      return sql();
    case "markdown":
      return markdown();
    case "cpp":
      return cpp();
    case "java":
      return java();
    case "go":
      return go();
    case "php":
      return php();
    case "shell":
      return StreamLanguage.define(shell);
    case "csv":
    case "plaintext":
    default:
      return [];
  }
}

export function isValidatableLanguage(lang: LanguageId): boolean {
  return lang === "json" || lang === "yaml" || lang === "toml" || lang === "xml";
}

export function createFormatLinter(
  lang: LanguageId,
  validateFn: (content: string, format: string) => Promise<ValidationResult>
): Extension {
  if (!isValidatableLanguage(lang)) return [];

  return linter(
    async (view): Promise<Diagnostic[]> => {
      const content = view.state.doc.toString();
      if (!content.trim()) return [];
      try {
        const res = await validateFn(content, lang);
        if (res.valid || !res.error) return [];

        const lineNum = Math.min(Math.max(1, res.line ?? 1), view.state.doc.lines);
        const line = view.state.doc.line(lineNum);
        const colOffset = Math.max(0, (res.column ?? 1) - 1);
        const from = Math.min(line.from + colOffset, line.to);
        const to = Math.min(Math.max(from + 1, line.to), view.state.doc.length);

        return [
          {
            from: Math.min(from, view.state.doc.length),
            to: Math.max(Math.min(from, view.state.doc.length), to),
            severity: "error",
            message: res.error,
          },
        ];
      } catch {
        return [];
      }
    },
    { delay: 320 }
  );
}

// ============================================================================
// Handcrafted CodeMirror 6 Themes
// ============================================================================

interface ThemePalette {
  dark: boolean;
  bg: string;
  gutterBg: string;
  gutterText: string;
  gutterActive: string;
  text: string;
  caret: string;
  selection: string;
  activeLine: string;
  matchingBracket: string;
  searchMatch: string;
  searchMatchSelected: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  func: string;
  type: string;
  property: string;
  variable: string;
  operator: string;
  tag: string;
  attribute: string;
  heading: string;
}

const PALETTES: Record<ThemeId, ThemePalette> = {
  "zed-dark": {
    dark: true,
    bg: "#1a1d24",
    gutterBg: "#1a1d24",
    gutterText: "#4f586b",
    gutterActive: "#9aa6be",
    text: "#dce3ef",
    caret: "#60a5fa",
    selection: "rgba(96, 165, 250, 0.24)",
    activeLine: "rgba(255, 255, 255, 0.035)",
    matchingBracket: "rgba(96, 165, 250, 0.25)",
    searchMatch: "rgba(251, 191, 36, 0.22)",
    searchMatchSelected: "rgba(251, 191, 36, 0.45)",
    comment: "#647087",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    func: "#61afef",
    type: "#e5c07b",
    property: "#e06c75",
    variable: "#dce3ef",
    operator: "#56b6c2",
    tag: "#e06c75",
    attribute: "#d19a66",
    heading: "#61afef",
  },
  "sublime-mariana": {
    dark: true,
    bg: "#303841",
    gutterBg: "#303841",
    gutterText: "#6f7d8c",
    gutterActive: "#c8d0db",
    text: "#d8dee9",
    caret: "#f9ae58",
    selection: "rgba(102, 153, 204, 0.3)",
    activeLine: "rgba(255, 255, 255, 0.045)",
    matchingBracket: "rgba(95, 180, 180, 0.28)",
    searchMatch: "rgba(250, 199, 97, 0.24)",
    searchMatchSelected: "rgba(250, 199, 97, 0.48)",
    comment: "#7f8c9a",
    keyword: "#c695c6",
    string: "#99c794",
    number: "#f9ae58",
    func: "#6699cc",
    type: "#5fb4b4",
    property: "#ec5f66",
    variable: "#d8dee9",
    operator: "#f97b58",
    tag: "#ec5f66",
    attribute: "#c695c6",
    heading: "#6699cc",
  },
  "tokyo-night": {
    dark: true,
    bg: "#1a1b26",
    gutterBg: "#1a1b26",
    gutterText: "#485175",
    gutterActive: "#9aa5ce",
    text: "#c0caf5",
    caret: "#7aa2f7",
    selection: "rgba(122, 162, 247, 0.26)",
    activeLine: "rgba(41, 46, 66, 0.52)",
    matchingBracket: "rgba(125, 207, 255, 0.26)",
    searchMatch: "rgba(224, 175, 104, 0.22)",
    searchMatchSelected: "rgba(224, 175, 104, 0.45)",
    comment: "#565f89",
    keyword: "#bb9af7",
    string: "#9ece6a",
    number: "#ff9e64",
    func: "#7aa2f7",
    type: "#2ac3de",
    property: "#73daca",
    variable: "#c0caf5",
    operator: "#89ddff",
    tag: "#f7768e",
    attribute: "#bb9af7",
    heading: "#7aa2f7",
  },
  "catppuccin-latte": {
    dark: false,
    bg: "#eff1f5",
    gutterBg: "#eff1f5",
    gutterText: "#9ca0b0",
    gutterActive: "#4c4f69",
    text: "#4c4f69",
    caret: "#1e66f5",
    selection: "rgba(30, 102, 245, 0.16)",
    activeLine: "rgba(76, 79, 105, 0.05)",
    matchingBracket: "rgba(30, 102, 245, 0.2)",
    searchMatch: "rgba(223, 142, 29, 0.22)",
    searchMatchSelected: "rgba(223, 142, 29, 0.44)",
    comment: "#8c8fa1",
    keyword: "#8839ef",
    string: "#40a02b",
    number: "#fe640b",
    func: "#1e66f5",
    type: "#df8e1d",
    property: "#d20f39",
    variable: "#4c4f69",
    operator: "#04a5e5",
    tag: "#1e66f5",
    attribute: "#df8e1d",
    heading: "#1e66f5",
  },
};

export function getThemeExtension(themeId: ThemeId, fontSize: number): Extension {
  const p = PALETTES[themeId] ?? PALETTES["zed-dark"];

  const editorTheme = EditorView.theme(
    {
      "&": {
        color: p.text,
        backgroundColor: p.bg,
        fontSize: `${fontSize}px`,
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.6",
        overflow: "auto",
      },
      ".cm-content": {
        caretColor: p.caret,
        padding: "10px 0 80px 0",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: p.caret,
        borderLeftWidth: "2px",
      },
      ".cm-cursor-secondary": {
        borderLeftColor: p.caret,
        borderLeftWidth: "2px",
        opacity: "0.9",
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: p.selection,
        },
      ".cm-activeLine": {
        backgroundColor: p.activeLine,
      },
      ".cm-gutters": {
        backgroundColor: p.gutterBg,
        color: p.gutterText,
        border: "none",
        paddingRight: "6px",
        userSelect: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 10px 0 14px",
        minWidth: "42px",
      },
      ".cm-activeLineGutter": {
        backgroundColor: p.activeLine,
        color: p.gutterActive,
        fontWeight: "500",
      },
      ".cm-foldGutter .cm-gutterElement": {
        padding: "0 4px",
        opacity: "0.65",
      },
      ".cm-foldGutter .cm-gutterElement:hover": {
        opacity: "1",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: p.matchingBracket,
        outline: `1px solid ${p.caret}55`,
        borderRadius: "2px",
      },
      ".cm-searchMatch": {
        backgroundColor: p.searchMatch,
        borderRadius: "2px",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: p.searchMatchSelected,
        outline: `1px solid ${p.caret}`,
      },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        color: "var(--text-primary)",
        borderRadius: "6px",
        boxShadow: "var(--shadow-sm)",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-soft)",
        color: "var(--text-primary)",
      },
      ".cm-diagnostic-error": {
        borderLeft: "3px solid var(--danger)",
        paddingLeft: "8px",
      },
    },
    { dark: p.dark }
  );

  const highlightStyle = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment], color: p.comment, fontStyle: "italic" },
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.inserted], color: p.string },
    { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.null], color: p.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.func },
    { tag: [t.typeName, t.className, t.namespace, t.macroName], color: p.type },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: p.property },
    { tag: [t.variableName, t.definition(t.variableName)], color: p.variable },
    { tag: [t.operator, t.punctuation, t.derefOperator], color: p.operator },
    { tag: [t.tagName], color: p.tag },
    { tag: [t.attributeName], color: p.attribute },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: p.heading, fontWeight: "700" },
    { tag: [t.strong], fontWeight: "700" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.link, t.url], color: p.func, textDecoration: "underline" },
    { tag: [t.invalid], color: "#f87171", textDecoration: "underline wavy" },
  ]);

  return [editorTheme, syntaxHighlighting(highlightStyle)];
}

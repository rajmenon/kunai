import type { LanguageId } from "../types/editor";

// ============================================================================
// Kunai — Preview Security Policy & Strict DOM-Based Markdown Sanitizer
// ============================================================================
// Single audited source of truth for preview safety:
// 1. Strict ALLOWLIST of non-executable natively supported formats.
// 2. Strict DENYLIST of executable/scriptable file extensions (defense-in-depth,
//    ALWAYS enforced regardless of the editor's active language mode).
// 3. Strict DOMParser-based allowlist HTML sanitizer for Markdown GFM rendering
//    (rebuilds a clean DOM tree from scratch — zero scripts, handlers, iframes,
//    SVGs, styles, or unsafe URI schemes).

export type SafePreviewFormat =
  | "markdown"
  | "json"
  | "yaml"
  | "toml"
  | "xml"
  | "css"
  | "sql"
  | "csv";

export interface PreviewSafetyResult {
  allowed: boolean;
  format?: SafePreviewFormat;
  reason?: string;
}

export const SAFE_PREVIEW_FORMATS: ReadonlySet<SafePreviewFormat> = new Set<SafePreviewFormat>([
  "markdown",
  "json",
  "yaml",
  "toml",
  "xml",
  "css",
  "sql",
  "csv",
]);

/**
 * Defense-in-depth extension denylist. Any file whose extension matches this
 * set is NEVER previewed, even if the user manually switches language mode.
 */
export const BLOCKED_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  // Web / active markup / scriptable vector formats
  ".html",
  ".htm",
  ".xhtml",
  ".mhtml",
  ".hta",
  ".svg",
  ".svgz",
  ".xsl",
  ".xslt",
  ".xaml",
  // JavaScript / TypeScript / Web frameworks
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".mdx",
  ".vue",
  ".svelte",
  ".astro",
  // Server-side & template languages
  ".php",
  ".phtml",
  ".jsp",
  ".asp",
  ".aspx",
  ".erb",
  ".ejs",
  ".hbs",
  // Scripting & shell languages
  ".py",
  ".pyw",
  ".rb",
  ".pl",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".lua",
  ".r",
  // Compiled languages & binaries
  ".rs",
  ".go",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".java",
  ".cs",
  ".swift",
  ".kt",
  ".exe",
  ".dll",
  ".com",
  ".msi",
  ".scr",
  ".wasm",
  ".jar",
  ".class",
]);

const EXECUTABLE_LANGUAGES: ReadonlySet<LanguageId> = new Set<LanguageId>([
  "html",
  "javascript",
  "typescript",
  "rust",
  "python",
  "shell",
  "php",
  "cpp",
  "java",
  "go",
]);

function extractExtension(filePathOrName?: string | null): string | null {
  if (!filePathOrName) return null;
  const normalized = filePathOrName.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) return null;
  return base.slice(dotIdx).toLowerCase();
}

/**
 * Determines whether a document is safe to render in Kunai's Preview pane.
 * Enforces BOTH the blocked extension denylist and the safe format allowlist.
 */
export function isSafeToPreview(
  language: LanguageId,
  filePathOrName?: string | null
): PreviewSafetyResult {
  // 1. Defense-in-depth: ALWAYS block executable / scriptable extensions first,
  // regardless of the language mode chosen in the editor.
  const ext = extractExtension(filePathOrName);
  if (ext && BLOCKED_PREVIEW_EXTENSIONS.has(ext)) {
    return {
      allowed: false,
      reason: `Executable or scriptable file type (${ext}) cannot be previewed for security.`,
    };
  }

  // 2. Strict allowlist check on language mode.
  if (SAFE_PREVIEW_FORMATS.has(language as SafePreviewFormat)) {
    return {
      allowed: true,
      format: language as SafePreviewFormat,
    };
  }

  if (EXECUTABLE_LANGUAGES.has(language)) {
    return {
      allowed: false,
      reason: `Executable or scriptable language (${language}) cannot be previewed for security.`,
    };
  }

  return {
    allowed: false,
    reason: `No formatted preview is enabled for ${language} files.`,
  };
}

// ============================================================================
// Strict DOMParser-Based Markdown HTML Sanitizer
// ============================================================================

const DROP_SUBTREE_TAGS: ReadonlySet<string> = new Set<string>([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "form",
  "textarea",
  "select",
  "button",
  "meta",
  "link",
  "base",
  "template",
  "noscript",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
]);

const ALLOWED_MARKDOWN_TAGS: ReadonlySet<string> = new Set<string>([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "del",
  "s",
  "sub",
  "sup",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "input",
  "span",
  "div",
  "dl",
  "dt",
  "dd",
  "kbd",
  "mark",
]);

const SAFE_CODE_CLASS_RE = /^language-[a-z0-9_+-]+$/i;
const SAFE_ALIGN_VALUES: ReadonlySet<string> = new Set(["left", "center", "right"]);

function stripControlChars(value: string): string {
  // Remove ASCII control characters (0x00-0x1F, 0x7F) that browsers ignore inside URLs
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += value[i];
    }
  }
  return out.trim();
}

function sanitizeHref(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = stripControlChars(raw);
  if (!cleaned) return null;

  // Fragment-only links (#heading) are safe
  if (cleaned.startsWith("#")) {
    return cleaned;
  }

  // Block protocol-relative URLs (//evil.example)
  if (cleaned.startsWith("//")) {
    return null;
  }

  try {
    const parsed = new URL(cleaned);
    if (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:"
    ) {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeImageSrc(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = stripControlChars(raw);
  if (!cleaned || cleaned.startsWith("//")) return null;

  try {
    const parsed = new URL(cleaned);
    // Strictly allow ONLY https: or http: — never javascript:, data:, file:, blob:, etc.
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeNode(node: Node, outDoc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return outDoc.createTextNode(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    // Drop comments, processing instructions, doctypes, etc.
    return null;
  }

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // Drop dangerous subtrees completely (including all descendants)
  if (DROP_SUBTREE_TAGS.has(tag)) {
    return null;
  }

  // Unknown tags not in the strict allowlist: unwrap safe children into a fragment
  if (!ALLOWED_MARKDOWN_TAGS.has(tag)) {
    const frag = outDoc.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) {
      const cleanChild = sanitizeNode(child, outDoc);
      if (cleanChild) frag.appendChild(cleanChild);
    }
    return frag;
  }

  // Special handling for <input>: ONLY GFM task-list checkboxes (forced disabled)
  if (tag === "input") {
    const inputType = el.getAttribute("type")?.toLowerCase();
    if (inputType !== "checkbox") {
      return null;
    }
    const cleanInput = outDoc.createElement("input");
    cleanInput.setAttribute("type", "checkbox");
    cleanInput.setAttribute("disabled", "true");
    if (el.hasAttribute("checked")) {
      cleanInput.setAttribute("checked", "");
    }
    return cleanInput;
  }

  // Create a brand-new clean element with ZERO copied attributes by default
  const cleanEl = outDoc.createElement(tag);

  if (tag === "a") {
    const safeHref = sanitizeHref(el.getAttribute("href"));
    if (safeHref) {
      cleanEl.setAttribute("href", safeHref);
      cleanEl.setAttribute("target", "_blank");
      cleanEl.setAttribute("rel", "noopener noreferrer nofollow");
    }
    const title = el.getAttribute("title");
    if (title) cleanEl.setAttribute("title", title);
  } else if (tag === "img") {
    const safeSrc = sanitizeImageSrc(el.getAttribute("src"));
    if (!safeSrc) {
      // Do not render broken/unsafe image tags; preserve alt text safely if available
      const alt = el.getAttribute("alt");
      return alt ? outDoc.createTextNode(`[image: ${alt}]`) : null;
    }
    cleanEl.setAttribute("src", safeSrc);
    const alt = el.getAttribute("alt");
    if (alt !== null) cleanEl.setAttribute("alt", alt);
    const title = el.getAttribute("title");
    if (title) cleanEl.setAttribute("title", title);
  } else if (tag === "code" || tag === "pre") {
    const cls = el.getAttribute("class")?.trim();
    if (cls && SAFE_CODE_CLASS_RE.test(cls)) {
      cleanEl.setAttribute("class", cls);
    }
  } else if (tag === "td" || tag === "th") {
    const align = el.getAttribute("align")?.trim().toLowerCase();
    if (align && SAFE_ALIGN_VALUES.has(align)) {
      cleanEl.setAttribute("align", align);
    }
  }

  // Recursively sanitize child nodes
  for (const child of Array.from(el.childNodes)) {
    const cleanChild = sanitizeNode(child, outDoc);
    if (cleanChild) cleanEl.appendChild(cleanChild);
  }

  return cleanEl;
}

/**
 * Strictly sanitizes rendered Markdown HTML using DOMParser + an element/attribute
 * allowlist, rebuilding a brand-new sanitized DOM tree from scratch.
 */
export function sanitizeMarkdownHtml(rawHtml: string): string {
  if (!rawHtml) return "";
  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawHtml, "text/html");
  const outDoc = document.implementation.createHTMLDocument("");
  const container = outDoc.createElement("div");

  for (const child of Array.from(parsed.body.childNodes)) {
    const clean = sanitizeNode(child, outDoc);
    if (clean) container.appendChild(clean);
  }

  return container.innerHTML;
}

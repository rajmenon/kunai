// ============================================================================
// Kunai — Minimal Valid Multi-Page PDF 1.4 Generator (Built-in Demo Document)
// ============================================================================
// Generates a clean, valid 3-page PDF in pure TypeScript with accurate xref
// offsets so the PDF viewer can be tested immediately in both desktop & web mode.

interface PdfPageSpec {
  title: string;
  subtitle: string;
  lines: string[];
}

function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, " ");
}

function buildPageStream(page: PdfPageSpec, pageNumber: number, totalPages: number): string {
  const ops: string[] = [];

  // Subtle dark slate header bar
  ops.push("0.08 0.11 0.18 rg");
  ops.push("0 712 612 80 re f");

  // Accent indigo stripe
  ops.push("0.38 0.56 0.98 rg");
  ops.push("0 708 612 4 re f");

  // Header title
  ops.push("1 1 1 rg");
  ops.push("BT /F2 20 Tf 48 756 Td (" + escapePdfText(page.title) + ") Tj ET");

  // Header subtitle
  ops.push("0.72 0.80 0.94 rg");
  ops.push("BT /F1 10.5 Tf 48 732 Td (" + escapePdfText(page.subtitle) + ") Tj ET");

  // Body lines
  ops.push("0.12 0.15 0.22 rg");
  let y = 664;
  for (const rawLine of page.lines) {
    if (rawLine === "") {
      y -= 12;
      continue;
    }
    if (rawLine.startsWith("## ")) {
      y -= 6;
      ops.push("0.20 0.36 0.72 rg");
      ops.push("BT /F2 13 Tf 48 " + y + " Td (" + escapePdfText(rawLine.slice(3)) + ") Tj ET");
      ops.push("0.12 0.15 0.22 rg");
      y -= 20;
    } else if (rawLine.startsWith("- ")) {
      ops.push("BT /F1 10.5 Tf 60 " + y + " Td (" + escapePdfText("* " + rawLine.slice(2)) + ") Tj ET");
      y -= 17;
    } else {
      ops.push("BT /F1 10.5 Tf 48 " + y + " Td (" + escapePdfText(rawLine) + ") Tj ET");
      y -= 17;
    }
  }

  // Footer rule & page number
  ops.push("0.84 0.87 0.92 RG 0.75 w 48 52 m 564 52 l S");
  ops.push("0.42 0.47 0.56 rg");
  ops.push("BT /F1 9 Tf 48 34 Td (Kunai Rust + Tauri v2 Smart Editor — Sandboxed PDF Viewer) Tj ET");
  ops.push(
    `BT /F1 9 Tf 508 34 Td (Page ${pageNumber} of ${totalPages}) Tj ET`
  );

  return ops.join("\n") + "\n";
}

function buildMinimalPdfBytes(pages: PdfPageSpec[]): Uint8Array {
  const objects: string[] = [];
  // 1: Catalog, 2: Pages, 3: Helvetica (/F1), 4: Helvetica-Bold (/F2)
  // For each page i: pageObjId = 5 + i*2, contentObjId = 6 + i*2
  const pageObjIds = pages.map((_, i) => 5 + i * 2);

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`
  );
  objects.push(
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  );
  objects.push(
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n"
  );

  pages.forEach((page, i) => {
    const pageId = 5 + i * 2;
    const contentId = 6 + i * 2;
    const stream = buildPageStream(page, i + 1, pages.length);
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
    );
    objects.push(
      `${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`
    );
  });

  const header = "%PDF-1.4\n";
  const offsets: number[] = [0];
  let body = header;
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(body + xref + trailer);
}

let cachedSamplePdfBase64: string | null = null;

export function getSampleGuidePdfBase64(): string {
  if (cachedSamplePdfBase64) return cachedSamplePdfBase64;
  const bytes = buildMinimalPdfBytes([
    {
      title: "Kunai — Fast PDF Viewer",
      subtitle: "Rust + Tauri v2 Desktop Editor  |  HiDPI Canvas Rendering  |  Zero Scripting",
      lines: [
        "Welcome to Kunai's built-in fast PDF viewer.",
        "Open any local PDF via Ctrl+O, Explorer, Quick Open (Ctrl+P), or Drag & Drop.",
        "",
        "## Performance Highlights",
        "- Lazy IntersectionObserver rendering: only visible pages render onto HiDPI canvas.",
        "- Dedicated local PDF.js Web Worker bundled offline (zero external network calls).",
        "- Instant zoom presets (Fit Width, Fit Page, 50% to 200%), rotation, and page jump.",
        "- Fast in-PDF full-text search (Ctrl+F) with page match navigation.",
        "- One-click 'Extract Text' dumps PDF text into an editable Kunai tab for multi-cursor work.",
        "",
        "## Security Architecture",
        "- Rendered strictly on HTML5 Canvas — zero <iframe>, zero <embed>, zero plugins.",
        "- PDF JavaScript execution disabled (enableScripting: false, isEvalSupported: false).",
        "- Runs cleanly under Kunai's strict Tauri v2 Content Security Policy.",
      ],
    },
    {
      title: "Keyboard Shortcuts & Multi-Cursor",
      subtitle: "Sublime Text + Zed Ergonomics  |  Notepad++ Power Utilities",
      lines: [
        "## Multi-Cursor & Selection",
        "- Ctrl+D : Select next occurrence of current word or selection",
        "- Ctrl+Shift+L : Split multi-line selection into per-line cursors",
        "- Alt+Click : Place an additional cursor anywhere",
        "- Alt+Drag : Column / rectangular box selection",
        "- Ctrl+Alt+Up / Down : Add cursor above or below",
        "",
        "## Preview & Side-by-Side Workflows",
        "- Ctrl+Alt+P : Toggle Always Open in Preview mode",
        "- Ctrl+Shift+V : Toggle Markup + Preview Side-by-Side",
        "- Ctrl+\\ : Split Editor side-by-side (read this PDF beside Markdown or Rust!)",
        "- Ctrl+Shift+P : Fuzzy Command Palette across all transforms & formatters",
        "- Ctrl+Shift+D : Side-by-Side Diff Viewer against saved file, tab, or clipboard",
      ],
    },
    {
      title: "Native Format Engine",
      subtitle: "JSON  |  YAML  |  TOML  |  XML  |  Markdown  |  SQL  |  CSS  |  CSV  |  PDF",
      lines: [
        "## Pretty-Printed Safe Previews",
        "- JSON / YAML / TOML: Pretty-printed preview, interactive Tree Inspector, and JSONPath.",
        "- XML / CSS / SQL: Indented, syntax-colored pretty-printed previews.",
        "- CSV / TSV: Aligned column text and interactive data table.",
        "- Markdown: Strictly DOM-sanitized GFM preview with scripts & event handlers stripped.",
        "",
        "## Rust Native Utilities",
        "- Encoding & EOL aware I/O (UTF-8, UTF-8-BOM, UTF-16LE/BE, Windows-1252, LF/CRLF).",
        "- Line sort, dedupe, regex filter, 9 case modes, Base64/URL/Hex, JWT decode, SHA-256.",
        "- Try searching 'JSONPath' or 'Multi-Cursor' in this PDF using the toolbar search bar!",
      ],
    },
  ]);

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  cachedSamplePdfBase64 = btoa(binary);
  return cachedSamplePdfBase64;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

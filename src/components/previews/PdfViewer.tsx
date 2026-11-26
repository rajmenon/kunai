import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Search,
  PanelLeft,
  FileText,
  ShieldCheck,
  Maximize2,
  Minimize2,
  X,
  BookOpen,
  AlertTriangle,
} from "lucide-react";
import { base64ToUint8Array } from "../../utils/samplePdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfViewerProps {
  title: string;
  base64Data: string;
  sizeBytes?: number;
  onExtractTextToTab?: (title: string, extractedText: string) => void;
  onCopyText?: (text: string, label?: string) => void;
}

type ZoomMode = "fit-width" | "fit-page" | "custom";

interface OutlineEntry {
  title: string;
  pageNumber: number | null;
  children: OutlineEntry[];
}

interface SearchHit {
  pageNumber: number;
  snippet: string;
  matchCount: number;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================================
// Lazy HiDPI Canvas Page (IntersectionObserver + Render Cancellation)
// ============================================================================

interface PdfPageCanvasProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  defaultWidth: number;
  defaultHeight: number;
  isSearchMatch: boolean;
  isActiveMatch: boolean;
  scrollRoot: HTMLElement | null;
  registerPageEl: (pageNumber: number, el: HTMLDivElement | null) => void;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = React.memo(
  ({
    pdf,
    pageNumber,
    scale,
    rotation,
    defaultWidth,
    defaultHeight,
    isSearchMatch,
    isActiveMatch,
    scrollRoot,
    registerPageEl,
  }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [inView, setInView] = useState(pageNumber <= 2);
    const [dimensions, setDimensions] = useState<{ w: number; h: number }>({
      w: Math.round(defaultWidth * scale),
      h: Math.round(defaultHeight * scale),
    });
    const [renderedKey, setRenderedKey] = useState("");

    const setRefs = useCallback(
      (el: HTMLDivElement | null) => {
        containerRef.current = el;
        registerPageEl(pageNumber, el);
      },
      [pageNumber, registerPageEl]
    );

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) setInView(entry.isIntersecting);
        },
        {
          root: scrollRoot,
          rootMargin: "700px 0px",
          threshold: 0.01,
        }
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, [scrollRoot]);

    useEffect(() => {
      const isRotated = rotation % 180 !== 0;
      const baseW = isRotated ? defaultHeight : defaultWidth;
      const baseH = isRotated ? defaultWidth : defaultHeight;
      setDimensions({
        w: Math.max(120, Math.round(baseW * scale)),
        h: Math.max(120, Math.round(baseH * scale)),
      });
    }, [defaultWidth, defaultHeight, scale, rotation]);

    useEffect(() => {
      if (!inView) return;
      const targetKey = `${pageNumber}@${scale.toFixed(3)}@${rotation}`;
      if (renderedKey === targetKey) return;

      let cancelled = false;
      let renderTask: RenderTask | null = null;

      void (async () => {
        try {
          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;

          const viewport = page.getViewport({ scale, rotation });
          const cssW = Math.round(viewport.width);
          const cssH = Math.round(viewport.height);
          setDimensions({ w: cssW, h: cssH });

          const canvas = canvasRef.current;
          if (!canvas || cancelled) return;

          const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
          canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
          canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
          canvas.style.width = `${cssW}px`;
          canvas.style.height = `${cssH}px`;

          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx || cancelled) return;

          ctx.save();
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();

          const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
          renderTask = page.render({
            canvasContext: ctx,
            canvas,
            viewport,
            transform,
          });
          await renderTask.promise;
          if (!cancelled) {
            setRenderedKey(targetKey);
          }
        } catch (err: unknown) {
          const name = (err as { name?: string } | null)?.name;
          if (name !== "RenderingCancelledException" && !cancelled) {
            // Silently ignore transient cancellation errors on fast zoom/scroll
          }
        }
      })();

      return () => {
        cancelled = true;
        if (renderTask) {
          try {
            renderTask.cancel();
          } catch {
            // ignore
          }
        }
      };
    }, [inView, pdf, pageNumber, scale, rotation, renderedKey]);

    return (
      <div
        ref={setRefs}
        data-pdf-page={pageNumber}
        style={{
          position: "relative",
          width: dimensions.w,
          height: dimensions.h,
          margin: "0 auto 16px auto",
          background: "#ffffff",
          borderRadius: 4,
          boxShadow: isActiveMatch
            ? "0 0 0 2px var(--accent), 0 8px 28px rgba(0,0,0,0.38)"
            : isSearchMatch
              ? "0 0 0 2px var(--warning), 0 6px 20px rgba(0,0,0,0.32)"
              : "0 4px 20px rgba(0,0,0,0.32)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {inView ? (
          <canvas
            ref={canvasRef}
            style={{
              display: "block",
              width: dimensions.w,
              height: dimensions.h,
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#64748b",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              background: "#f8fafc",
            }}
          >
            Page {pageNumber}
          </div>
        )}
        <div
          style={{
            position: "absolute",
            right: 8,
            bottom: 6,
            padding: "1px 6px",
            borderRadius: 3,
            background: "rgba(15, 23, 42, 0.72)",
            color: "#e2e8f0",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            pointerEvents: "none",
          }}
        >
          {pageNumber}
        </div>
      </div>
    );
  }
);

PdfPageCanvas.displayName = "PdfPageCanvas";

// ============================================================================
// Lazy Thumbnail Item
// ============================================================================

const PdfThumbnail: React.FC<{
  pdf: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  hasMatch: boolean;
  onSelect: (pageNumber: number) => void;
}> = React.memo(({ pdf, pageNumber, active, hasMatch, onSelect }) => {
  const wrapRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 6);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { rootMargin: "200px 0px", threshold: 0.01 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || rendered) return;
    let cancelled = false;
    let task: RenderTask | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const thumbScale = 112 / Math.max(1, baseViewport.width);
        const viewport = page.getViewport({ scale: thumbScale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx || cancelled) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        task = page.render({ canvasContext: ctx, canvas, viewport });
        await task.promise;
        if (!cancelled) setRendered(true);
      } catch {
        // ignore cancellation
      }
    })();

    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        // ignore
      }
    };
  }, [visible, rendered, pdf, pageNumber]);

  return (
    <button
      ref={wrapRef}
      type="button"
      onClick={() => onSelect(pageNumber)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        width: "100%",
        padding: "8px 6px",
        borderRadius: 6,
        border: active
          ? "1.5px solid var(--accent)"
          : hasMatch
            ? "1.5px solid var(--warning)"
            : "1px solid transparent",
        background: active ? "var(--bg-active)" : "transparent",
        cursor: "pointer",
        color: "var(--text-secondary)",
      }}
    >
      <div
        style={{
          width: 112,
          minHeight: 140,
          background: "#ffffff",
          borderRadius: 3,
          overflow: "hidden",
          boxShadow: "0 2px 8px rgba(0,0,0,0.28)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block", width: 112, height: "auto" }} />
      </div>
      <span
        style={{
          fontSize: 10.5,
          fontFamily: "var(--font-mono)",
          color: active ? "var(--text-primary)" : "var(--text-muted)",
          fontWeight: active ? 600 : 400,
        }}
      >
        {pageNumber}
        {hasMatch ? " •" : ""}
      </span>
    </button>
  );
});

PdfThumbnail.displayName = "PdfThumbnail";

// ============================================================================
// Main Fast PDF Viewer Component
// ============================================================================

export const PdfViewer: React.FC<PdfViewerProps> = ({
  title,
  base64Data,
  sizeBytes,
  onExtractTextToTab,
  onCopyText,
}) => {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [basePageSize, setBasePageSize] = useState<{ w: number; h: number }>({
    w: 612,
    h: 792,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);

  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [customScale, setCustomScale] = useState<number>(1.2);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({
    w: 900,
    h: 700,
  });
  const [rotation, setRotation] = useState<number>(0);

  const [showRail, setShowRail] = useState<boolean>(false);
  const [railTab, setRailTab] = useState<"thumbs" | "outline">("thumbs");
  const [outline, setOutline] = useState<OutlineEntry[]>([]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [activeHitIdx, setActiveHitIdx] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);

  const pageTextCacheRef = useRef<Map<number, string>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Track viewport width/height for instant Fit Width / Fit Page calculation
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => {
      setViewportSize({
        w: Math.max(260, el.clientWidth - 48),
        h: Math.max(260, el.clientHeight - 48),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showRail]);

  // Load PDF bytes strictly without scripting / eval
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    const t0 = performance.now();

    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setCurrentPage(1);
    setPageInput("1");
    setOutline([]);
    setSearchHits([]);
    setActiveHitIdx(0);
    pageTextCacheRef.current.clear();

    void (async () => {
      try {
        const bytes = base64ToUint8Array(base64Data);
        loadingTask = pdfjsLib.getDocument({
          data: bytes,
          useSystemFonts: true,
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }

        const firstPage = await doc.getPage(1);
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        const vp = firstPage.getViewport({ scale: 1 });
        setBasePageSize({ w: vp.width, h: vp.height });
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setLoadMs(Math.max(1, Math.round(performance.now() - t0)));
        setLoading(false);

        // Load PDF bookmarks/outline asynchronously
        try {
          const rawOutline = await doc.getOutline();
          if (rawOutline && rawOutline.length > 0 && !cancelled) {
            const resolveItems = async (
              items: typeof rawOutline
            ): Promise<OutlineEntry[]> => {
              const out: OutlineEntry[] = [];
              for (const item of items) {
                let pageNum: number | null = null;
                try {
                  const dest =
                    typeof item.dest === "string"
                      ? await doc.getDestination(item.dest)
                      : item.dest;
                  if (Array.isArray(dest) && dest[0]) {
                    const idx = await doc.getPageIndex(dest[0]);
                    pageNum = idx + 1;
                  }
                } catch {
                  pageNum = null;
                }
                const children = item.items?.length
                  ? await resolveItems(item.items)
                  : [];
                out.push({ title: item.title || "Untitled", pageNumber: pageNum, children });
              }
              return out;
            };
            const resolved = await resolveItems(rawOutline);
            if (!cancelled) setOutline(resolved);
          }
        } catch {
          // Outline optional
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF document.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [base64Data]);

  // Compute effective zoom scale
  const effectiveScale = useMemo(() => {
    const isRotated = rotation % 180 !== 0;
    const pageW = isRotated ? basePageSize.h : basePageSize.w;
    const pageH = isRotated ? basePageSize.w : basePageSize.h;
    if (zoomMode === "fit-width") {
      return Math.max(0.4, Math.min(2.6, viewportSize.w / Math.max(1, pageW)));
    }
    if (zoomMode === "fit-page") {
      const sW = viewportSize.w / Math.max(1, pageW);
      const sH = viewportSize.h / Math.max(1, pageH);
      return Math.max(0.4, Math.min(2.6, Math.min(sW, sH)));
    }
    return customScale;
  }, [zoomMode, customScale, viewportSize, basePageSize, rotation]);

  const registerPageEl = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) {
      pageElementsRef.current.set(pageNumber, el);
    } else {
      pageElementsRef.current.delete(pageNumber);
    }
  }, []);

  const jumpToPage = useCallback(
    (target: number) => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, Math.round(target)));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      const el = pageElementsRef.current.get(clamped);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [numPages]
  );

  // Sync current page number while scrolling
  const handleScroll = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root || numPages === 0) return;
    const rootTop = root.getBoundingClientRect().top;
    const focusY = rootTop + root.clientHeight * 0.25;

    let bestPage = currentPage;
    let bestDist = Infinity;
    for (const [pg, el] of pageElementsRef.current.entries()) {
      const rect = el.getBoundingClientRect();
      const dist = Math.abs(rect.top - focusY);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = pg;
      }
    }
    if (bestPage !== currentPage) {
      setCurrentPage(bestPage);
      setPageInput(String(bestPage));
    }
  }, [currentPage, numPages]);

  const zoomIn = useCallback(() => {
    setZoomMode("custom");
    setCustomScale(() => Math.min(3.0, +(effectiveScale + 0.15).toFixed(2)));
  }, [effectiveScale]);

  const zoomOut = useCallback(() => {
    setZoomMode("custom");
    setCustomScale(() => Math.max(0.4, +(effectiveScale - 0.15).toFixed(2)));
  }, [effectiveScale]);

  // Ctrl + Mouse Wheel smooth zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    },
    [zoomIn, zoomOut]
  );

  // Extract page text helper (cached)
  const getPageText = useCallback(
    async (doc: PDFDocumentProxy, pageNum: number): Promise<string> => {
      const cached = pageTextCacheRef.current.get(pageNum);
      if (cached !== undefined) return cached;
      const page = await doc.getPage(pageNum);
      const tc = await page.getTextContent();
      const text = tc.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pageTextCacheRef.current.set(pageNum, text);
      return text;
    },
    []
  );

  // Full-text PDF search
  const runSearch = useCallback(
    async (query: string) => {
      const q = query.trim().toLowerCase();
      if (!q || !pdfDoc) {
        setSearchHits([]);
        setActiveHitIdx(0);
        return;
      }
      setIsSearching(true);
      const hits: SearchHit[] = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const text = await getPageText(pdfDoc, p);
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        if (idx !== -1) {
          let count = 0;
          let pos = idx;
          while (pos !== -1) {
            count++;
            pos = lower.indexOf(q, pos + q.length);
          }
          const start = Math.max(0, idx - 32);
          const end = Math.min(text.length, idx + q.length + 52);
          const snippet =
            (start > 0 ? "…" : "") +
            text.slice(start, end) +
            (end < text.length ? "…" : "");
          hits.push({ pageNumber: p, snippet, matchCount: count });
        }
      }
      setSearchHits(hits);
      setActiveHitIdx(0);
      setIsSearching(false);
      if (hits.length > 0) {
        jumpToPage(hits[0].pageNumber);
      }
    },
    [pdfDoc, getPageText, jumpToPage]
  );

  const stepSearchHit = useCallback(
    (delta: number) => {
      if (searchHits.length === 0) return;
      const next = (activeHitIdx + delta + searchHits.length) % searchHits.length;
      setActiveHitIdx(next);
      jumpToPage(searchHits[next].pageNumber);
    },
    [searchHits, activeHitIdx, jumpToPage]
  );

  const handleExtractText = useCallback(async () => {
    if (!pdfDoc) return;
    setIsExtracting(true);
    try {
      const parts: string[] = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const pageText = await getPageText(pdfDoc, p);
        parts.push(`--- Page ${p} of ${pdfDoc.numPages} ---\n${pageText}`);
      }
      const fullText = parts.join("\n\n");
      if (onExtractTextToTab) {
        const baseName = title.replace(/\.pdf$/i, "");
        onExtractTextToTab(`${baseName}.extracted.txt`, fullText);
      } else if (onCopyText) {
        onCopyText(fullText, "Copied extracted PDF text");
      }
    } finally {
      setIsExtracting(false);
    }
  }, [pdfDoc, getPageText, onExtractTextToTab, onCopyText, title]);

  // Keyboard shortcuts scoped to PDF viewer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  const matchPages = useMemo(
    () => new Set(searchHits.map((h) => h.pageNumber)),
    [searchHits]
  );
  const activeMatchPage = searchHits[activeHitIdx]?.pageNumber ?? -1;
  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, i) => i + 1),
    [numPages]
  );

  const renderOutlineItems = (items: OutlineEntry[], depth = 0): React.ReactNode =>
    items.map((item, idx) => (
      <div key={`${depth}-${idx}`}>
        <button
          type="button"
          onClick={() => item.pageNumber && jumpToPage(item.pageNumber)}
          disabled={!item.pageNumber}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            textAlign: "left",
            padding: `5px 8px 5px ${10 + depth * 12}px`,
            borderRadius: 4,
            border: "none",
            background:
              item.pageNumber === currentPage ? "var(--bg-active)" : "transparent",
            color: item.pageNumber ? "var(--text-primary)" : "var(--text-muted)",
            fontSize: 12,
            cursor: item.pageNumber ? "pointer" : "default",
            gap: 6,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.title}
          </span>
          {item.pageNumber && (
            <span
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                flexShrink: 0,
              }}
            >
              {item.pageNumber}
            </span>
          )}
        </button>
        {item.children.length > 0 && renderOutlineItems(item.children, depth + 1)}
      </div>
    ));

  return (
    <div
      className="kunai-pdf-viewer"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        minHeight: 0,
        background: "var(--bg-primary)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Sleek PDF Toolbar */}
      <div
        style={{
          height: 38,
          minHeight: 38,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "0 10px",
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          userSelect: "none",
          flexWrap: "nowrap",
          overflowX: "auto",
        }}
      >
        {/* Left: Thumbnails + Page Navigation */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className={`kunai-pdf-btn ${showRail ? "active" : ""}`}
            onClick={() => setShowRail((v) => !v)}
            title="Toggle Thumbnails & Bookmarks"
          >
            <PanelLeft size={14} />
          </button>

          <div className="kunai-pdf-divider" />

          <button
            type="button"
            className="kunai-pdf-btn"
            onClick={() => jumpToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            title="Previous Page"
          >
            <ChevronLeft size={14} />
          </button>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = parseInt(pageInput, 10);
              if (!Number.isNaN(parsed)) jumpToPage(parsed);
            }}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <input
              type="text"
              aria-label="Current PDF page"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => setPageInput(String(currentPage))}
              style={{
                width: 38,
                height: 22,
                textAlign: "center",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-primary)",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
              }}
            />
            <span
              style={{
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
              }}
            >
              / {numPages || "–"}
            </span>
          </form>

          <button
            type="button"
            className="kunai-pdf-btn"
            onClick={() => jumpToPage(currentPage + 1)}
            disabled={currentPage >= numPages}
            title="Next Page"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Center: Zoom & Rotate Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            className="kunai-pdf-btn"
            onClick={zoomOut}
            title="Zoom Out (Ctrl+-)"
          >
            <ZoomOut size={14} />
          </button>

          <span
            style={{
              minWidth: 46,
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--text-secondary)",
            }}
          >
            {Math.round(effectiveScale * 100)}%
          </span>

          <button
            type="button"
            className="kunai-pdf-btn"
            onClick={zoomIn}
            title="Zoom In (Ctrl++)"
          >
            <ZoomIn size={14} />
          </button>

          <button
            type="button"
            className={`kunai-pdf-btn text ${zoomMode === "fit-width" ? "active" : ""}`}
            onClick={() => setZoomMode("fit-width")}
            title="Fit Width"
          >
            <Maximize2 size={12} />
            <span>Fit Width</span>
          </button>

          <button
            type="button"
            className={`kunai-pdf-btn text ${zoomMode === "fit-page" ? "active" : ""}`}
            onClick={() => setZoomMode("fit-page")}
            title="Fit Page"
          >
            <Minimize2 size={12} />
            <span>Fit Page</span>
          </button>

          <button
            type="button"
            className="kunai-pdf-btn"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            title="Rotate 90° Clockwise"
          >
            <RotateCw size={13} />
          </button>
        </div>

        {/* Right: Search, Extract Text, Security Badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className={`kunai-pdf-btn text ${searchOpen ? "active" : ""}`}
            onClick={() => {
              setSearchOpen((v) => {
                const next = !v;
                if (next) requestAnimationFrame(() => searchInputRef.current?.focus());
                return next;
              });
            }}
            title="Search inside PDF (Ctrl+F)"
          >
            <Search size={13} />
            <span>Find</span>
          </button>

          <button
            type="button"
            className="kunai-pdf-btn text"
            onClick={() => void handleExtractText()}
            disabled={isExtracting || !pdfDoc}
            title="Extract all PDF text into a new editable Kunai tab"
          >
            <FileText size={13} />
            <span>{isExtracting ? "Extracting…" : "Extract Text"}</span>
          </button>

          <span
            title="Rendered strictly onto HTML5 Canvas with PDF scripting disabled (enableScripting: false, isEvalSupported: false, zero iframes)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 7px",
              borderRadius: 4,
              background: "rgba(34, 197, 94, 0.12)",
              color: "var(--success)",
              fontSize: 10.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <ShieldCheck size={12} />
            <span>No-JS Canvas</span>
          </span>

          {(sizeBytes || loadMs) && (
            <span
              style={{
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {[formatBytes(sizeBytes), loadMs ? `${loadMs}ms` : ""].filter(Boolean).join(" • ")}
            </span>
          )}
        </div>
      </div>

      {/* In-PDF Search Bar */}
      {searchOpen && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
          }}
        >
          <Search size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(searchQuery);
            }}
            style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, maxWidth: 420 }}
          >
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search text in PDF (Enter)…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                flex: 1,
                height: 24,
                padding: "0 8px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-primary)",
                color: "var(--text-primary)",
                fontSize: 12,
              }}
            />
            <button type="submit" className="kunai-pdf-btn text active">
              {isSearching ? "…" : "Search"}
            </button>
          </form>

          {searchHits.length > 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--accent)",
                  whiteSpace: "nowrap",
                }}
              >
                {activeHitIdx + 1} / {searchHits.length} pages (p.{searchHits[activeHitIdx].pageNumber})
              </span>
              <button
                type="button"
                className="kunai-pdf-btn"
                onClick={() => stepSearchHit(-1)}
                title="Previous matching page"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                className="kunai-pdf-btn"
                onClick={() => stepSearchHit(1)}
                title="Next matching page"
              >
                <ChevronRight size={13} />
              </button>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {searchHits[activeHitIdx].snippet}
              </span>
            </div>
          ) : (
            searchQuery.trim() &&
            !isSearching && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No matches</span>
            )
          )}

          <button
            type="button"
            className="kunai-pdf-btn"
            onClick={() => {
              setSearchOpen(false);
              setSearchHits([]);
            }}
            title="Close search"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Body: Optional Thumbnails/Bookmarks Rail + Scrollable HiDPI Canvas Stage */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {showRail && pdfDoc && (
          <div
            style={{
              width: 170,
              minWidth: 170,
              background: "var(--bg-secondary)",
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                borderBottom: "1px solid var(--border)",
                padding: 4,
                gap: 4,
              }}
            >
              <button
                type="button"
                className={`kunai-pdf-btn text ${railTab === "thumbs" ? "active" : ""}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setRailTab("thumbs")}
              >
                Pages
              </button>
              <button
                type="button"
                className={`kunai-pdf-btn text ${railTab === "outline" ? "active" : ""}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => setRailTab("outline")}
              >
                <BookOpen size={11} />
                <span>Outline</span>
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
              {railTab === "thumbs" ? (
                pageNumbers.map((pg) => (
                  <PdfThumbnail
                    key={pg}
                    pdf={pdfDoc}
                    pageNumber={pg}
                    active={pg === currentPage}
                    hasMatch={matchPages.has(pg)}
                    onSelect={jumpToPage}
                  />
                ))
              ) : outline.length > 0 ? (
                renderOutlineItems(outline)
              ) : (
                <div
                  style={{
                    padding: 12,
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                    textAlign: "center",
                  }}
                >
                  No PDF bookmarks in this document.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Main Canvas Viewport */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "auto",
            padding: "20px 24px 36px 24px",
            background: "var(--bg-tertiary, #11151d)",
          }}
        >
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--text-muted)",
                fontSize: 13,
                gap: 8,
              }}
            >
              Rendering {title}…
            </div>
          )}

          {error && (
            <div
              style={{
                maxWidth: 480,
                margin: "48px auto",
                padding: 20,
                borderRadius: 8,
                border: "1px solid var(--danger)",
                background: "var(--bg-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "var(--danger)",
                  fontWeight: 600,
                }}
              >
                <AlertTriangle size={16} />
                <span>Unable to render PDF</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{error}</div>
            </div>
          )}

          {!loading && !error && pdfDoc && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              {pageNumbers.map((pg) => (
                <PdfPageCanvas
                  key={pg}
                  pdf={pdfDoc}
                  pageNumber={pg}
                  scale={effectiveScale}
                  rotation={rotation}
                  defaultWidth={basePageSize.w}
                  defaultHeight={basePageSize.h}
                  isSearchMatch={matchPages.has(pg)}
                  isActiveMatch={pg === activeMatchPage}
                  scrollRoot={scrollContainerRef.current}
                  registerPageEl={registerPageEl}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

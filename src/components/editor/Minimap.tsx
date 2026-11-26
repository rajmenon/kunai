import React, { useCallback, useEffect, useRef } from "react";
import type { ThemeId } from "../../types/editor";

interface MinimapProps {
  content: string;
  theme: ThemeId;
  scrollRatio: number;
  viewportRatio: number;
  onScrollToRatio: (ratio: number) => void;
}

const LINE_HEIGHT_PX = 2.5;
const MAX_LINES_DRAWN = 2200;

export const Minimap: React.FC<MinimapProps> = ({
  content,
  theme,
  scrollRatio,
  viewportRatio,
  onScrollToRatio,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);

  const isLight = theme === "catppuccin-latte";

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = container.clientWidth || 84;
    const height = container.clientHeight || 500;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const lines = content.split("\n");
    const totalLines = Math.min(lines.length, MAX_LINES_DRAWN);
    const contentPixelHeight = totalLines * LINE_HEIGHT_PX;
    const maxOffset = Math.max(0, contentPixelHeight - height);
    const yOffset = maxOffset * Math.max(0, Math.min(1, scrollRatio));

    const startLine = Math.max(0, Math.floor(yOffset / LINE_HEIGHT_PX) - 2);
    const endLine = Math.min(
      totalLines,
      Math.ceil((yOffset + height) / LINE_HEIGHT_PX) + 2
    );

    const padX = 6;
    const usableW = width - padX * 2;

    for (let i = startLine; i < endLine; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const y = i * LINE_HEIGHT_PX - yOffset;
      const trimmed = line.trimStart();
      const indent = Math.min(line.length - trimmed.length, 48);
      const len = Math.min(trimmed.length, 95);

      const x = padX + (indent / 95) * usableW;
      const w = Math.max(2, (len / 95) * (usableW - (x - padX)));

      // Subtle semantic coloring for code overview
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("--") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      ) {
        ctx.fillStyle = isLight
          ? "rgba(108, 111, 133, 0.28)"
          : "rgba(148, 163, 184, 0.25)";
      } else if (
        /^(import|export|fn|pub|def|class|struct|impl|interface|type|const|let|return|SELECT|WITH|FROM)\b/.test(
          trimmed
        )
      ) {
        ctx.fillStyle = isLight
          ? "rgba(136, 57, 239, 0.42)"
          : "rgba(192, 132, 252, 0.46)";
      } else if (/^["'{[\]}]/.test(trimmed) || trimmed.includes('":')) {
        ctx.fillStyle = isLight
          ? "rgba(30, 102, 245, 0.36)"
          : "rgba(96, 165, 250, 0.42)";
      } else {
        ctx.fillStyle = isLight
          ? "rgba(76, 79, 105, 0.36)"
          : "rgba(216, 222, 233, 0.32)";
      }

      ctx.fillRect(x, y, w, 1.4);
    }
  }, [content, theme, isLight, scrollRatio]);

  const computeRatioFromClientY = useCallback((clientY: number) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const rel = (clientY - rect.top) / Math.max(1, rect.height);
    return Math.max(0, Math.min(1, rel));
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrollToRatio(computeRatioFromClientY(e.clientY));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    onScrollToRatio(computeRatioFromClientY(e.clientY));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore if pointer already released
    }
  };

  const clampedViewport = Math.max(0.08, Math.min(1, viewportRatio || 0.2));
  const sliderTopPct = Math.max(
    0,
    Math.min(1 - clampedViewport, scrollRatio * (1 - clampedViewport))
  ) * 100;
  const sliderHeightPct = clampedViewport * 100;

  return (
    <div
      ref={containerRef}
      className="kunai-minimap"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      title="Minimap — click or drag to scroll"
      aria-label="Code Minimap"
    >
      <canvas ref={canvasRef} className="kunai-minimap-canvas" />
      <div
        className="kunai-minimap-slider"
        style={{
          top: `${sliderTopPct}%`,
          height: `${sliderHeightPct}%`,
        }}
      />
    </div>
  );
};

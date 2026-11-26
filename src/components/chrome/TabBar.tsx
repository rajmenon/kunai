import React, { useState } from "react";
import { Plus, X, Pin, Sparkles, Eye, ShieldAlert, Columns2 } from "lucide-react";
import type { LanguageId, TabBarProps } from "../../types/editor";

const LANG_META: Record<LanguageId, { color: string; badge: string }> = {
  typescript: { color: "#3178c6", badge: "TS" },
  javascript: { color: "#f7df1e", badge: "JS" },
  rust: { color: "#f97316", badge: "RS" },
  python: { color: "#3b82f6", badge: "PY" },
  json: { color: "#fbbf24", badge: "{}" },
  yaml: { color: "#c084fc", badge: "YML" },
  toml: { color: "#38bdf8", badge: "TML" },
  xml: { color: "#fb923c", badge: "XML" },
  html: { color: "#f43f5e", badge: "HTM" },
  css: { color: "#06b6d4", badge: "CSS" },
  sql: { color: "#4ade80", badge: "SQL" },
  markdown: { color: "#60a5fa", badge: "MD" },
  csv: { color: "#22c55e", badge: "CSV" },
  cpp: { color: "#6366f1", badge: "C++" },
  java: { color: "#ef4444", badge: "JAV" },
  go: { color: "#22d3ee", badge: "GO" },
  php: { color: "#a855f7", badge: "PHP" },
  shell: { color: "#34d399", badge: "SH" },
  pdf: { color: "#f43f5e", badge: "PDF" },
  plaintext: { color: "#94a3b8", badge: "TXT" },
};

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onPinTab,
  onNewTab,
  onFormatActive,
  onTogglePreview,
  splitMode,
  canPreviewActive,
  previewBlockedReason,
}) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const sortedTabs = [...tabs].sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return 0;
  });

  const isPreviewOpen = splitMode === "preview" || splitMode === "preview-only";

  return (
    <div
      className="kunai-tabbar"
      style={{
        height: 34,
        minHeight: 34,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-between",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
      }}
    >
      {/* Scrollable Tabs Strip */}
      <div
        role="tablist"
        style={{
          display: "flex",
          alignItems: "stretch",
          overflowX: "auto",
          overflowY: "hidden",
          flex: 1,
          minWidth: 0,
          scrollbarWidth: "none",
        }}
      >
        {sortedTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isHovered = hoveredId === tab.id;
          const meta = LANG_META[tab.language] ?? LANG_META.plaintext;
          const hasError = tab.validation && !tab.validation.valid;

          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              title={tab.path ?? tab.title}
              onClick={() => onSelectTab(tab.id)}
              onMouseEnter={() => setHoveredId(tab.id)}
              onMouseLeave={() => setHoveredId((prev) => (prev === tab.id ? null : prev))}
              onAuxClick={(e) => {
                if (e.button === 1 && !tab.isPinned) {
                  e.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onDoubleClick={() => onPinTab(tab.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 10px",
                minWidth: 96,
                maxWidth: 210,
                cursor: "pointer",
                position: "relative",
                background: isActive
                  ? "var(--bg-primary)"
                  : isHovered
                    ? "var(--bg-hover)"
                    : "transparent",
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                borderRight: "1px solid var(--border-subtle)",
                boxShadow: isActive ? "inset 0 2px 0 0 var(--accent)" : "none",
                transition: "background 100ms ease, color 100ms ease",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  fontWeight: 700,
                  color: meta.color,
                  letterSpacing: "-0.02em",
                  minWidth: 18,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                {meta.badge}
              </span>

              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: isActive ? 500 : 400,
                  color: hasError ? "var(--danger)" : undefined,
                  flex: 1,
                }}
              >
                {tab.title}
              </span>

              {(tab.isPinned || isHovered) && (
                <button
                  type="button"
                  title={tab.isPinned ? "Unpin Tab" : "Pin Tab"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPinTab(tab.id);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    border: "none",
                    background: "transparent",
                    color: tab.isPinned ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  <Pin size={10} />
                </button>
              )}

              <button
                type="button"
                title={tab.isDirty ? "Unsaved changes — click to close" : "Close Tab (Ctrl+W)"}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 4,
                  border: "none",
                  background: isHovered ? "var(--bg-active)" : "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                {tab.isDirty && !isHovered ? (
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "var(--warning)",
                    }}
                  />
                ) : (
                  <X size={11} style={{ opacity: isActive || isHovered ? 0.9 : 0.45 }} />
                )}
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onNewTab}
          title="New Untitled Tab (Ctrl+N)"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            border: "none",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Right quick actions: Format & Preview / Side-by-Side */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 8px",
          borderLeft: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onFormatActive}
          title="Format Document (Shift+Alt+F)"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 22,
            padding: "0 7px",
            borderRadius: 4,
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-elevated)",
            color: "var(--text-secondary)",
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <Sparkles size={11} style={{ color: "var(--accent)" }} />
          <span>Format</span>
        </button>

        <button
          type="button"
          onClick={onTogglePreview}
          title={
            canPreviewActive
              ? "Toggle Preview & Markup Side-by-Side (Ctrl+Shift+V)"
              : previewBlockedReason ?? "Preview blocked for executable/scriptable files"
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 22,
            padding: "0 7px",
            borderRadius: 4,
            border: !canPreviewActive
              ? "1px solid var(--border-subtle)"
              : isPreviewOpen
                ? "1px solid var(--accent-border)"
                : "1px solid var(--border-subtle)",
            background: !canPreviewActive
              ? "var(--bg-tertiary)"
              : isPreviewOpen
                ? "var(--accent-soft)"
                : "var(--bg-elevated)",
            color: !canPreviewActive
              ? "var(--warning)"
              : isPreviewOpen
                ? "var(--accent)"
                : "var(--text-secondary)",
            opacity: !canPreviewActive ? 0.78 : 1,
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {!canPreviewActive ? (
            <ShieldAlert size={11} />
          ) : splitMode === "preview-only" ? (
            <Columns2 size={11} />
          ) : (
            <Eye size={11} />
          )}
          <span>
            {!canPreviewActive
              ? "No Preview"
              : splitMode === "preview-only"
                ? "Side-by-Side"
                : "Preview"}
          </span>
        </button>
      </div>
    </div>
  );
};

export default TabBar;

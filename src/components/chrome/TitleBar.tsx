import React, { useEffect, useRef, useState } from "react";
import {
  PanelLeft,
  Search,
  Terminal,
  Columns2,
  Eye,
  GitCompare,
  Square,
  FolderOpen,
  FilePlus2,
  Save,
  Palette,
  Check,
  ShieldAlert,
  BookOpenCheck,
} from "lucide-react";
import type { SplitMode, ThemeId, TitleBarProps } from "../../types/editor";

const THEMES: { id: ThemeId; label: string; dot: string }[] = [
  { id: "zed-dark", label: "Zed One Dark", dot: "#60a5fa" },
  { id: "sublime-mariana", label: "Sublime Mariana", dot: "#6699cc" },
  { id: "tokyo-night", label: "Tokyo Night", dot: "#bb9af7" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", dot: "#1e66f5" },
];

export const TitleBar: React.FC<TitleBarProps> = ({
  workspaceName,
  activeTab,
  sidebarOpen,
  onToggleSidebar,
  splitMode,
  onChangeSplitMode,
  alwaysOpenInPreview,
  onToggleAlwaysOpenInPreview,
  canPreviewActive,
  previewBlockedReason,
  theme,
  onChangeTheme,
  onOpenCommandPalette,
  onOpenQuickOpen,
  onOpenFile,
  onOpenFolder,
  onSaveFile,
  isTauri,
}) => {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThemeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [themeMenuOpen]);

  const currentTheme = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  const splitOptions: {
    mode: SplitMode;
    label: string;
    title: string;
    icon: React.ReactNode;
    active: boolean;
    blocked?: boolean;
  }[] = [
    {
      mode: "none",
      label: "Editor",
      title: "Single Editor Pane",
      icon: <Square size={12} />,
      active: splitMode === "none",
    },
    {
      mode: "editor",
      label: "Split",
      title: "Split Editor",
      icon: <Columns2 size={12} />,
      active: splitMode === "editor",
    },
    {
      mode: "preview",
      label: "Preview",
      title: canPreviewActive
        ? "Toggle Preview & Markup Side-by-Side (Ctrl+Shift+V)"
        : previewBlockedReason ?? "Preview blocked for executable/scriptable files",
      icon: canPreviewActive ? <Eye size={12} /> : <ShieldAlert size={12} />,
      active: splitMode === "preview" || splitMode === "preview-only",
      blocked: !canPreviewActive,
    },
    {
      mode: "diff",
      label: "Diff",
      title: "Side-by-Side Diff Viewer",
      icon: <GitCompare size={12} />,
      active: splitMode === "diff",
    },
  ];

  return (
    <header
      className="kunai-titlebar"
      style={{
        height: 38,
        minHeight: 38,
        display: "grid",
        gridTemplateColumns: "1fr minmax(200px, 400px) auto",
        alignItems: "center",
        padding: "0 10px",
        gap: 8,
        background: "var(--bg-tertiary)",
        borderBottom: "1px solid var(--border)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        userSelect: "none",
        position: "relative",
        zIndex: 30,
      }}
    >
      {/* Left: Brand, Sidebar toggle, File actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <button
          type="button"
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: 5,
            border: "1px solid transparent",
            background: sidebarOpen ? "var(--bg-active)" : "transparent",
            color: sidebarOpen ? "var(--accent)" : "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          <PanelLeft size={14} />
        </button>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px 2px 6px",
            borderRadius: 6,
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-border)",
            color: "var(--accent)",
            fontWeight: 600,
            letterSpacing: "0.02em",
            flexShrink: 0,
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 4L10 8l-3 5 4 4 5-3 4-10z" />
            <path d="M7 13l-2.5 2.5" />
            <circle cx="4.5" cy="19.5" r="2" />
          </svg>
          <span>Kunai</span>
        </div>

        <span
          title={workspaceName}
          style={{
            color: "var(--text-secondary)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0 4px",
          }}
        >
          {workspaceName}
        </span>

        <div
          style={{
            width: 1,
            height: 16,
            background: "var(--border)",
            margin: "0 2px",
            flexShrink: 0,
          }}
        />

        <button type="button" onClick={onOpenFile} title="Open File (Ctrl+O)" style={iconBtnStyle(false)}>
          <FilePlus2 size={13} />
        </button>
        <button type="button" onClick={onOpenFolder} title="Open Folder" style={iconBtnStyle(false)}>
          <FolderOpen size={13} />
        </button>
        <button
          type="button"
          onClick={onSaveFile}
          title="Save File (Ctrl+S)"
          style={{
            ...iconBtnStyle(Boolean(activeTab?.isDirty)),
            position: "relative",
          }}
        >
          <Save size={13} />
          {activeTab?.isDirty && (
            <span
              style={{
                position: "absolute",
                top: 3,
                right: 3,
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "var(--warning)",
              }}
            />
          )}
        </button>
      </div>

      {/* Center: Quick Open / Command Palette trigger bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}>
        <button
          type="button"
          onClick={onOpenQuickOpen}
          title="Quick Open File (Ctrl+P)"
          style={{
            flex: 1,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            minWidth: 0,
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <Search size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
              {activeTab ? activeTab.title : "Open file..."}
            </span>
            {activeTab?.isDirty && <span style={{ color: "var(--warning)", fontSize: 10 }}>●</span>}
          </span>
          <kbd style={kbdStyle}>Ctrl+P</kbd>
        </button>

        <button
          type="button"
          onClick={onOpenCommandPalette}
          title="Command Palette (Ctrl+Shift+P)"
          style={{
            height: 26,
            padding: "0 8px",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <Terminal size={12} style={{ color: "var(--accent)" }} />
          <kbd style={kbdStyle}>⌘P</kbd>
        </button>
      </div>

      {/* Right: Auto-Preview toggle + Split/Preview/Diff controls + Theme switcher */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <button
          type="button"
          aria-pressed={alwaysOpenInPreview}
          onClick={onToggleAlwaysOpenInPreview}
          title={
            alwaysOpenInPreview
              ? "Auto-Preview ON: Safe files open directly in preview (Ctrl+Alt+P)"
              : "Auto-Preview OFF: Click to always open safe files in preview (Ctrl+Alt+P)"
          }
          style={{
            height: 26,
            padding: "0 8px",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            borderRadius: 6,
            border: alwaysOpenInPreview
              ? "1px solid var(--accent-border)"
              : "1px solid var(--border)",
            background: alwaysOpenInPreview ? "var(--accent-soft)" : "var(--bg-secondary)",
            color: alwaysOpenInPreview ? "var(--accent)" : "var(--text-muted)",
            fontWeight: alwaysOpenInPreview ? 600 : 500,
            fontSize: 11,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <BookOpenCheck size={12} />
          <span>Auto-Preview</span>
        </button>

        <div
          role="group"
          aria-label="Layout Mode"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: 2,
            borderRadius: 6,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            gap: 1,
          }}
        >
          {splitOptions.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              onClick={() => onChangeSplitMode(opt.mode)}
              title={opt.title}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                height: 22,
                padding: "0 7px",
                borderRadius: 4,
                border: "none",
                background: opt.active ? "var(--accent-soft)" : "transparent",
                color: opt.blocked
                  ? "var(--warning)"
                  : opt.active
                    ? "var(--accent)"
                    : "var(--text-muted)",
                opacity: opt.blocked ? 0.72 : 1,
                fontWeight: opt.active ? 600 : 500,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>

        {/* Theme Switcher */}
        <div ref={themeMenuRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setThemeMenuOpen((v) => !v)}
            title={`Theme: ${currentTheme.label}`}
            style={{
              height: 26,
              padding: "0 8px",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: themeMenuOpen ? "var(--bg-active)" : "var(--bg-secondary)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            <Palette size={12} style={{ color: currentTheme.dot }} />
            <span style={{ maxWidth: 84, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentTheme.label.split(" ")[0]}
            </span>
          </button>

          {themeMenuOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                width: 196,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                borderRadius: 8,
                boxShadow: "var(--shadow-lg)",
                padding: 4,
                zIndex: 60,
              }}
            >
              <div
                style={{
                  padding: "4px 8px",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--text-muted)",
                  fontWeight: 600,
                }}
              >
                Color Theme
              </div>
              {THEMES.map((t) => {
                const selected = t.id === theme;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      onChangeTheme(t.id);
                      setThemeMenuOpen(false);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 5,
                      border: "none",
                      background: selected ? "var(--accent-soft)" : "transparent",
                      color: selected ? "var(--accent)" : "var(--text-primary)",
                      fontSize: 12,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: t.dot,
                          flexShrink: 0,
                        }}
                      />
                      <span>{t.label}</span>
                    </span>
                    {selected && <Check size={12} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <span
          title={isTauri ? "Running on Native Rust Tauri Engine" : "Running in Browser Preview Mode"}
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--bg-badge)",
            color: isTauri ? "var(--success)" : "var(--text-muted)",
            border: "1px solid var(--border-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {isTauri ? "NATIVE" : "WEB"}
        </span>
      </div>
    </header>
  );
};

function iconBtnStyle(highlight: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    borderRadius: 5,
    border: "1px solid transparent",
    background: highlight ? "var(--accent-soft)" : "transparent",
    color: highlight ? "var(--accent)" : "var(--text-secondary)",
    cursor: "pointer",
    flexShrink: 0,
  };
}

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "var(--bg-badge)",
  border: "1px solid var(--border-subtle)",
  color: "var(--text-muted)",
  flexShrink: 0,
};

export default TitleBar;

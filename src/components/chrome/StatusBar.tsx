import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  WrapText,
  Map,
  Palette,
  Layers,
  Check,
  BookOpenCheck,
  ShieldCheck,
} from "lucide-react";
import type {
  EncodingName,
  LanguageId,
  LineEnding,
  StatusBarProps,
  ThemeId,
} from "../../types/editor";

const LANGUAGES: { id: LanguageId; label: string }[] = [
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "rust", label: "Rust" },
  { id: "python", label: "Python" },
  { id: "json", label: "JSON" },
  { id: "yaml", label: "YAML" },
  { id: "toml", label: "TOML" },
  { id: "xml", label: "XML" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "sql", label: "SQL" },
  { id: "markdown", label: "Markdown" },
  { id: "csv", label: "CSV" },
  { id: "cpp", label: "C / C++" },
  { id: "java", label: "Java" },
  { id: "go", label: "Go" },
  { id: "php", label: "PHP" },
  { id: "shell", label: "Shell" },
  { id: "plaintext", label: "Plain Text" },
];

const ENCODINGS: EncodingName[] = ["UTF-8", "UTF-8-BOM", "UTF-16LE", "UTF-16BE", "Windows-1252"];
const LINE_ENDINGS: LineEnding[] = ["LF", "CRLF", "CR"];
const TAB_SIZES = [2, 4, 8];
const THEMES: { id: ThemeId; label: string }[] = [
  { id: "zed-dark", label: "Zed One Dark" },
  { id: "sublime-mariana", label: "Sublime Mariana" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "catppuccin-latte", label: "Catppuccin Latte" },
];

type PopoverId = "indent" | "encoding" | "eol" | "language" | "theme" | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  tab,
  cursor,
  docStats,
  settings,
  alwaysOpenInPreview,
  onToggleAlwaysOpenInPreview,
  canPreviewActive,
  previewBlockedReason,
  onOpenGotoLine,
  onChangeLanguage,
  onChangeEncoding,
  onChangeLineEnding,
  onToggleIndentMode,
  onChangeTabSize,
  onToggleWordWrap,
  onToggleMinimap,
  onChangeTheme,
  onValidateClick,
}) => {
  const [openPopover, setOpenPopover] = useState<PopoverId>(null);
  const [langFilter, setLangFilter] = useState("");
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openPopover) return;
    const handleClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenPopover(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPopover(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openPopover]);

  const togglePopover = (id: PopoverId) => {
    setLangFilter("");
    setOpenPopover((cur) => (cur === id ? null : id));
  };

  const langLabel =
    LANGUAGES.find((l) => l.id === tab?.language)?.label ?? tab?.language ?? "Plain Text";
  const validation = tab?.validation;
  const showValidation =
    tab && ["json", "yaml", "toml", "xml"].includes(tab.language) && validation;

  const filteredLanguages = langFilter.trim()
    ? LANGUAGES.filter((l) => l.label.toLowerCase().includes(langFilter.toLowerCase()))
    : LANGUAGES;

  return (
    <footer
      ref={barRef}
      className="kunai-statusbar"
      style={{
        height: 26,
        minHeight: 26,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 10px",
        gap: 8,
        background: "var(--bg-tertiary)",
        borderTop: "1px solid var(--border)",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        userSelect: "none",
        position: "relative",
        zIndex: 25,
      }}
    >
      {/* Left: Validation, Cursor, Multi-cursor, Selection, Stats */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {showValidation && (
          <button
            type="button"
            onClick={onValidateClick}
            title={
              validation.valid
                ? `${langLabel} syntax valid`
                : `${validation.error ?? "Invalid syntax"}${validation.line ? ` (Ln ${validation.line}, Col ${validation.column ?? 1})` : ""}`
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 19,
              padding: "0 7px",
              borderRadius: 999,
              border: "none",
              background: validation.valid ? "var(--success-soft)" : "var(--danger-soft)",
              color: validation.valid ? "var(--success)" : "var(--danger)",
              fontWeight: 600,
              fontSize: 10.5,
              cursor: onValidateClick ? "pointer" : "default",
              flexShrink: 0,
            }}
          >
            {validation.valid ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
            <span>
              {validation.valid
                ? `Valid ${tab.language.toUpperCase()}`
                : `Invalid${validation.line ? ` Ln ${validation.line}:${validation.column ?? 1}` : ""}`}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onOpenGotoLine}
          title="Go to Line (Ctrl+G)"
          style={statusBtnStyle(false)}
        >
          <span style={{ fontFamily: "var(--font-mono)" }}>
            Ln {cursor.line}, Col {cursor.col}
          </span>
        </button>

        {cursor.cursorCount > 1 && (
          <span
            title={`${cursor.cursorCount} active cursors`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 18,
              padding: "0 6px",
              borderRadius: 4,
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-border)",
              color: "var(--accent)",
              fontWeight: 600,
              fontSize: 10.5,
            }}
          >
            <Layers size={10} />
            <span>{cursor.cursorCount} cursors</span>
          </span>
        )}

        {cursor.selectionLength > 0 && (
          <span
            style={{
              color: "var(--text-primary)",
              padding: "0 4px",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
            }}
          >
            ({cursor.selectionLength} selected
            {cursor.selectionLines > 1 ? `, ${cursor.selectionLines} lines` : ""})
          </span>
        )}

        {docStats && (
          <span
            title={`Reading time ~${docStats.reading_time_sec}s · ${docStats.non_empty_lines} non-empty lines`}
            style={{
              color: "var(--text-muted)",
              padding: "0 4px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {docStats.lines} ln · {docStats.words} wd · {formatBytes(docStats.bytes)}
          </span>
        )}
      </div>

      {/* Right: Auto-Preview, Indent, Encoding, EOL, Language, Wrap, Minimap, Theme */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        {tab && !canPreviewActive && previewBlockedReason && (
          <span
            title={previewBlockedReason}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              height: 18,
              padding: "0 6px",
              borderRadius: 4,
              background: "var(--warning-soft)",
              color: "var(--warning)",
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            <ShieldCheck size={10} />
            <span>Protected</span>
          </span>
        )}

        <button
          type="button"
          onClick={onToggleAlwaysOpenInPreview}
          title={
            alwaysOpenInPreview
              ? "Auto-Preview: ON (Ctrl+Alt+P)"
              : "Auto-Preview: OFF (Ctrl+Alt+P)"
          }
          style={statusBtnStyle(alwaysOpenInPreview)}
        >
          <BookOpenCheck size={11} />
          <span>{alwaysOpenInPreview ? "Auto-Preview: ON" : "Auto-Preview"}</span>
        </button>

        <div style={{ width: 1, height: 13, background: "var(--border)", margin: "0 1px" }} />

        {/* Indent Picker */}
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => togglePopover("indent")}
            title="Indentation Settings"
            style={statusBtnStyle(openPopover === "indent")}
          >
            {settings.useTabs ? `Tabs: ${settings.tabSize}` : `Spaces: ${settings.tabSize}`}
          </button>
          {openPopover === "indent" && (
            <div style={popoverStyle(160)}>
              <div style={popoverHeaderStyle}>Indentation</div>
              <button
                type="button"
                onClick={() => {
                  onToggleIndentMode();
                  setOpenPopover(null);
                }}
                style={popoverItemStyle(false)}
              >
                <span>Switch to {settings.useTabs ? "Spaces" : "Tabs"}</span>
              </button>
              <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
              {TAB_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => {
                    onChangeTabSize(sz);
                    setOpenPopover(null);
                  }}
                  style={popoverItemStyle(settings.tabSize === sz)}
                >
                  <span>Tab Size: {sz}</span>
                  {settings.tabSize === sz && <Check size={11} />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Encoding Picker */}
        {tab && (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => togglePopover("encoding")}
              title="File Encoding"
              style={statusBtnStyle(openPopover === "encoding")}
            >
              {tab.encoding}
            </button>
            {openPopover === "encoding" && (
              <div style={popoverStyle(156)}>
                <div style={popoverHeaderStyle}>Encoding</div>
                {ENCODINGS.map((enc) => (
                  <button
                    key={enc}
                    type="button"
                    onClick={() => {
                      onChangeEncoding(enc);
                      setOpenPopover(null);
                    }}
                    style={popoverItemStyle(tab.encoding === enc)}
                  >
                    <span>{enc}</span>
                    {tab.encoding === enc && <Check size={11} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* EOL Picker */}
        {tab && (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => togglePopover("eol")}
              title="Line Ending Sequence"
              style={statusBtnStyle(openPopover === "eol")}
            >
              {tab.lineEnding}
            </button>
            {openPopover === "eol" && (
              <div style={popoverStyle(132)}>
                <div style={popoverHeaderStyle}>Line Ending</div>
                {LINE_ENDINGS.map((eol) => (
                  <button
                    key={eol}
                    type="button"
                    onClick={() => {
                      onChangeLineEnding(eol);
                      setOpenPopover(null);
                    }}
                    style={popoverItemStyle(tab.lineEnding === eol)}
                  >
                    <span>
                      {eol}{" "}
                      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                        {eol === "LF" ? "(\\n)" : eol === "CRLF" ? "(\\r\\n)" : "(\\r)"}
                      </span>
                    </span>
                    {tab.lineEnding === eol && <Check size={11} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Language Picker */}
        {tab && (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => togglePopover("language")}
              title="Select Language Mode"
              style={{
                ...statusBtnStyle(openPopover === "language"),
                color: "var(--text-primary)",
                fontWeight: 500,
              }}
            >
              {langLabel}
            </button>
            {openPopover === "language" && (
              <div style={{ ...popoverStyle(190), maxHeight: 300, display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "4px 4px 6px" }}>
                  <input
                    autoFocus
                    type="text"
                    value={langFilter}
                    onChange={(e) => setLangFilter(e.target.value)}
                    placeholder="Filter language..."
                    style={{
                      width: "100%",
                      height: 24,
                      padding: "0 7px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg-secondary)",
                      color: "var(--text-primary)",
                      fontSize: 11,
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <div style={{ overflowY: "auto", maxHeight: 240 }}>
                  {filteredLanguages.map((lang) => (
                    <button
                      key={lang.id}
                      type="button"
                      onClick={() => {
                        onChangeLanguage(lang.id);
                        setOpenPopover(null);
                      }}
                      style={popoverItemStyle(tab.language === lang.id)}
                    >
                      <span>{lang.label}</span>
                      {tab.language === lang.id && <Check size={11} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ width: 1, height: 13, background: "var(--border)", margin: "0 2px" }} />

        {/* Word Wrap Toggle */}
        <button
          type="button"
          onClick={onToggleWordWrap}
          title={settings.wordWrap ? "Word Wrap: On (Alt+Z)" : "Word Wrap: Off (Alt+Z)"}
          style={statusBtnStyle(settings.wordWrap)}
        >
          <WrapText size={11} />
          <span>Wrap</span>
        </button>

        {/* Minimap Toggle */}
        <button
          type="button"
          onClick={onToggleMinimap}
          title={settings.showMinimap ? "Hide Minimap" : "Show Minimap"}
          style={statusBtnStyle(settings.showMinimap)}
        >
          <Map size={11} />
          <span>Map</span>
        </button>

        {/* Theme Picker */}
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => togglePopover("theme")}
            title="Switch Theme"
            style={statusBtnStyle(openPopover === "theme")}
          >
            <Palette size={11} />
          </button>
          {openPopover === "theme" && (
            <div style={popoverStyle(180)}>
              <div style={popoverHeaderStyle}>Theme</div>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onChangeTheme(t.id);
                    setOpenPopover(null);
                  }}
                  style={popoverItemStyle(settings.theme === t.id)}
                >
                  <span>{t.label}</span>
                  {settings.theme === t.id && <Check size={11} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
};

function statusBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 20,
    padding: "0 6px",
    borderRadius: 4,
    border: "none",
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function popoverStyle(width: number): React.CSSProperties {
  return {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    right: 0,
    width,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: 7,
    boxShadow: "var(--shadow-lg)",
    padding: 4,
    zIndex: 70,
  };
}

const popoverHeaderStyle: React.CSSProperties = {
  padding: "3px 8px 4px",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

function popoverItemStyle(selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    padding: "5px 8px",
    borderRadius: 4,
    border: "none",
    background: selected ? "var(--accent-soft)" : "transparent",
    color: selected ? "var(--accent)" : "var(--text-primary)",
    fontSize: 11.5,
    cursor: "pointer",
    textAlign: "left",
  };
}

export default StatusBar;

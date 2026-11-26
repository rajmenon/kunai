import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Terminal,
  FileCode2,
  Hash,
  CornerDownLeft,
  X,
} from "lucide-react";
import type {
  CommandItem,
  CommandPaletteProps,
  PaletteMode,
  QuickOpenFileItem,
  QuickOpenProps,
} from "../../types/editor";

interface FuzzyMatch {
  score: number;
  indices: number[];
}

function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  let qi = 0;
  let score = 0;
  let streak = 0;
  const indices: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      streak++;
      score += 10 + streak * 5;
      if (ti === 0 || /[\s/\\._:-]/.test(text[ti - 1])) {
        score += 15; // word boundary bonus
      }
      qi++;
    } else {
      streak = 0;
    }
  }

  if (qi < q.length) return null;
  // Prefer shorter matches
  score -= text.length * 0.15;
  return { score, indices };
}

function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const idxSet = new Set(indices);
  return (
    <>
      {Array.from(text).map((ch, i) =>
        idxSet.has(i) ? (
          <mark
            key={i}
            style={{
              background: "transparent",
              color: "var(--accent)",
              fontWeight: 700,
            }}
          >
            {ch}
          </mark>
        ) : (
          <React.Fragment key={i}>{ch}</React.Fragment>
        )
      )}
    </>
  );
}

const MODE_META: { id: PaletteMode; label: string; placeholder: string; icon: React.ReactNode }[] = [
  {
    id: "commands",
    label: "Commands",
    placeholder: "Type a command (e.g. format, sort, base64, theme)...",
    icon: <Terminal size={13} />,
  },
  {
    id: "files",
    label: "Quick Open",
    placeholder: "Search files by name or path (type > for commands, : for line)...",
    icon: <FileCode2 size={13} />,
  },
  {
    id: "goto",
    label: "Go to Line",
    placeholder: "Enter line[:column] (e.g. 42 or 42:10)...",
    icon: <Hash size={13} />,
  },
];

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  mode,
  onClose,
  onSwitchMode,
  commands,
  files,
  onOpenFile,
  onJumpToLine,
  totalLines,
  currentLine,
}) => {
  const [localMode, setLocalMode] = useState<PaletteMode>(mode);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalMode(mode);
  }, [mode]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setLocalMode(mode);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen, mode]);

  const activeMode: PaletteMode = useMemo(() => {
    if (localMode === "files") {
      if (query.startsWith(">")) return "commands";
      if (query.startsWith(":")) return "goto";
    }
    return localMode;
  }, [localMode, query]);

  const effectiveQuery = useMemo(() => {
    if (localMode === "files" && (query.startsWith(">") || query.startsWith(":"))) {
      return query.slice(1).trimStart();
    }
    return query;
  }, [localMode, query]);

  const filteredCommands = useMemo(() => {
    if (activeMode !== "commands") return [];
    const results: { item: CommandItem; score: number; labelIndices: number[] }[] = [];
    for (const cmd of commands) {
      const labelMatch = fuzzyScore(effectiveQuery, cmd.label);
      const catMatch = fuzzyScore(effectiveQuery, `${cmd.category}: ${cmd.label}`);
      const kwMatch = cmd.keywords
        ? fuzzyScore(effectiveQuery, cmd.keywords.join(" "))
        : null;
      const best = Math.max(
        labelMatch ? labelMatch.score + 12 : -Infinity,
        catMatch ? catMatch.score : -Infinity,
        kwMatch ? kwMatch.score - 5 : -Infinity
      );
      if (best > -Infinity) {
        results.push({
          item: cmd,
          score: best,
          labelIndices: labelMatch?.indices ?? [],
        });
      }
    }
    if (effectiveQuery.trim()) {
      results.sort((a, b) => b.score - a.score);
    }
    return results.slice(0, 60);
  }, [activeMode, commands, effectiveQuery]);

  const filteredFiles = useMemo(() => {
    if (activeMode !== "files") return [];
    const results: { item: QuickOpenFileItem; score: number; nameIndices: number[] }[] = [];
    for (const f of files) {
      const nameMatch = fuzzyScore(effectiveQuery, f.name);
      const pathMatch = fuzzyScore(effectiveQuery, f.relativePath);
      const best = Math.max(
        nameMatch ? nameMatch.score + 20 : -Infinity,
        pathMatch ? pathMatch.score : -Infinity
      );
      if (best > -Infinity) {
        results.push({
          item: f,
          score: best + (f.isOpen ? 8 : 0),
          nameIndices: nameMatch?.indices ?? [],
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 60);
  }, [activeMode, files, effectiveQuery]);

  const gotoParsed = useMemo(() => {
    if (activeMode !== "goto") return null;
    const raw = effectiveQuery.trim();
    if (!raw) return { line: currentLine, col: 1, valid: true };
    const m = raw.match(/^(\d+)(?::(\d+))?$/);
    if (!m) return { line: currentLine, col: 1, valid: false };
    const line = Math.max(1, Math.min(totalLines || 1, parseInt(m[1], 10)));
    const col = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
    return { line, col, valid: true };
  }, [activeMode, effectiveQuery, currentLine, totalLines]);

  const itemCount =
    activeMode === "commands"
      ? filteredCommands.length
      : activeMode === "files"
        ? filteredFiles.length
        : 1;

  useEffect(() => {
    setSelectedIndex(0);
  }, [effectiveQuery, activeMode]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-palette-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const switchMode = (next: PaletteMode) => {
    setLocalMode(next);
    setQuery("");
    setSelectedIndex(0);
    onSwitchMode?.(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const executeSelection = () => {
    if (activeMode === "commands") {
      const chosen = filteredCommands[selectedIndex];
      if (chosen) {
        onClose();
        chosen.item.run();
      }
    } else if (activeMode === "files") {
      const chosen = filteredFiles[selectedIndex];
      if (chosen) {
        onClose();
        onOpenFile(chosen.item.path);
      }
    } else if (activeMode === "goto" && gotoParsed?.valid) {
      onClose();
      onJumpToLine(gotoParsed.line, gotoParsed.col);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (itemCount > 0) setSelectedIndex((i) => (i + 1) % itemCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (itemCount > 0) setSelectedIndex((i) => (i - 1 + itemCount) % itemCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeSelection();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const order: PaletteMode[] = ["commands", "files", "goto"];
      const next = order[(order.indexOf(activeMode) + 1) % order.length];
      switchMode(next);
    }
  };

  if (!isOpen) return null;

  const meta = MODE_META.find((m) => m.id === activeMode) ?? MODE_META[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={meta.label}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 100,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        onKeyDown={handleKeyDown}
        style={{
          width: "min(620px, 92vw)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Mode tabs strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 10px 0",
            background: "var(--bg-secondary)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {MODE_META.map((m) => {
              const active = activeMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => switchMode(m.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 9px 7px",
                    border: "none",
                    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                    background: "transparent",
                    color: active ? "var(--text-primary)" : "var(--text-muted)",
                    fontWeight: active ? 600 : 500,
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  {m.icon}
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              marginBottom: 4,
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

        {/* Search Input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elevated)",
          }}
        >
          <Search size={15} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={meta.placeholder}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 13.5,
              fontFamily: activeMode === "goto" ? "var(--font-mono)" : "var(--font-sans)",
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: 2,
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Results */}
        <div
          ref={listRef}
          style={{
            maxHeight: "52vh",
            overflowY: "auto",
            padding: 6,
          }}
        >
          {activeMode === "commands" && (
            <>
              {filteredCommands.length === 0 ? (
                <div style={emptyStyle}>No commands matching &ldquo;{effectiveQuery}&rdquo;</div>
              ) : (
                filteredCommands.map(({ item, labelIndices }, idx) => {
                  const selected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-palette-idx={idx}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => {
                        onClose();
                        item.run();
                      }}
                      style={rowStyle(selected)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: selected ? "var(--accent-soft)" : "var(--bg-badge)",
                            color: selected ? "var(--accent)" : "var(--text-muted)",
                            flexShrink: 0,
                          }}
                        >
                          {item.category}
                        </span>
                        <div style={{ minWidth: 0, overflow: "hidden" }}>
                          <div
                            style={{
                              fontSize: 12.5,
                              color: "var(--text-primary)",
                              fontWeight: selected ? 600 : 400,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            <HighlightedText text={item.label} indices={labelIndices} />
                          </div>
                          {item.description && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {item.description}
                            </div>
                          )}
                        </div>
                      </div>
                      {item.shortcut && <kbd style={shortcutStyle}>{item.shortcut}</kbd>}
                    </button>
                  );
                })
              )}
            </>
          )}

          {activeMode === "files" && (
            <>
              {filteredFiles.length === 0 ? (
                <div style={emptyStyle}>No files matching &ldquo;{effectiveQuery}&rdquo;</div>
              ) : (
                filteredFiles.map(({ item, nameIndices }, idx) => {
                  const selected = idx === selectedIndex;
                  return (
                    <button
                      key={item.path}
                      type="button"
                      data-palette-idx={idx}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => {
                        onClose();
                        onOpenFile(item.path);
                      }}
                      style={rowStyle(selected)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <FileCode2
                          size={14}
                          style={{
                            color: selected ? "var(--accent)" : "var(--text-muted)",
                            flexShrink: 0,
                          }}
                        />
                        <div style={{ minWidth: 0, overflow: "hidden" }}>
                          <div
                            style={{
                              fontSize: 12.5,
                              color: "var(--text-primary)",
                              fontWeight: 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            <HighlightedText text={item.name} indices={nameIndices} />
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              fontFamily: "var(--font-mono)",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {item.relativePath}
                          </div>
                        </div>
                      </div>
                      {item.isOpen && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--accent-soft)",
                            color: "var(--accent)",
                            fontWeight: 600,
                            flexShrink: 0,
                          }}
                        >
                          OPEN
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </>
          )}

          {activeMode === "goto" && (
            <div style={{ padding: "10px 10px" }}>
              {gotoParsed?.valid ? (
                <button
                  type="button"
                  onClick={executeSelection}
                  style={rowStyle(true)}
                >
                  <span style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                    Jump to{" "}
                    <strong style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                      Line {gotoParsed.line}, Column {gotoParsed.col}
                    </strong>{" "}
                    <span style={{ color: "var(--text-muted)" }}>
                      (document has {totalLines} lines · currently at line {currentLine})
                    </span>
                  </span>
                  <CornerDownLeft size={13} style={{ color: "var(--accent)" }} />
                </button>
              ) : (
                <div style={{ ...emptyStyle, color: "var(--danger)" }}>
                  Invalid format — use line number or line:column (e.g. 42 or 42:8)
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer hints */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 12px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            fontSize: 10.5,
          }}
        >
          <div style={{ display: "flex", gap: 12 }}>
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>Tab Switch mode</span>
            <span>Esc Dismiss</span>
          </div>
          <span>
            {activeMode === "commands"
              ? `${filteredCommands.length} commands`
              : activeMode === "files"
                ? `${filteredFiles.length} files`
                : `1–${totalLines}`}
          </span>
        </div>
      </div>
    </div>
  );
};

export const QuickOpen: React.FC<QuickOpenProps> = ({ isOpen, onClose, files, onOpenFile }) => (
  <CommandPalette
    isOpen={isOpen}
    mode="files"
    onClose={onClose}
    commands={[]}
    files={files}
    onOpenFile={onOpenFile}
    onJumpToLine={() => {}}
    totalLines={1}
    currentLine={1}
  />
);

function rowStyle(selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "7px 10px",
    borderRadius: 6,
    border: selected ? "1px solid var(--accent-border)" : "1px solid transparent",
    background: selected ? "var(--bg-active)" : "transparent",
    cursor: "pointer",
    textAlign: "left",
  };
}

const shortcutStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  padding: "2px 6px",
  borderRadius: 4,
  background: "var(--bg-badge)",
  border: "1px solid var(--border-subtle)",
  color: "var(--text-secondary)",
  flexShrink: 0,
};

const emptyStyle: React.CSSProperties = {
  padding: "24px 16px",
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 12,
};

export default CommandPalette;

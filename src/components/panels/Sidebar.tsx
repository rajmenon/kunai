import React, { useMemo, useState } from "react";
import {
  FolderTree,
  Search,
  ListTree,
  Wrench,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode2,
  FilePlus2,
  FolderPlus,
  RefreshCw,
  Trash2,
  Sparkles,
  Minimize2,
  Filter,
  Loader2,
} from "lucide-react";
import type {
  EditorTab,
  SearchMatch,
  SidebarProps,
  SidebarView,
  TreeNode,
} from "../../types/editor";

const VIEW_TABS: { id: SidebarView; label: string; icon: React.ReactNode }[] = [
  { id: "explorer", label: "Explorer", icon: <FolderTree size={14} /> },
  { id: "search", label: "Search", icon: <Search size={14} /> },
  { id: "outline", label: "Outline", icon: <ListTree size={14} /> },
  { id: "utilities", label: "Toolbox", icon: <Wrench size={14} /> },
];

const EXT_COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#38bdf8",
  js: "#f7df1e",
  jsx: "#f7df1e",
  rs: "#f97316",
  py: "#3b82f6",
  json: "#fbbf24",
  yaml: "#c084fc",
  yml: "#c084fc",
  toml: "#38bdf8",
  md: "#60a5fa",
  html: "#f43f5e",
  svg: "#fb923c",
  xml: "#fb923c",
  css: "#06b6d4",
  sql: "#4ade80",
  csv: "#22c55e",
  sh: "#34d399",
};

interface OutlineSymbol {
  label: string;
  kind: string;
  color: string;
  line: number;
  depth: number;
}

function extractOutline(tab: EditorTab | null): OutlineSymbol[] {
  if (!tab) return [];
  const lines = tab.content.split(/\r?\n/);
  const symbols: OutlineSymbol[] = [];
  const lang = tab.language;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;

    if (lang === "markdown") {
      const m = raw.match(/^(#{1,6})\s+(.+)/);
      if (m) {
        symbols.push({
          label: m[2].replace(/#+\s*$/, "").trim(),
          kind: `H${m[1].length}`,
          color: m[1].length === 1 ? "var(--accent)" : m[1].length === 2 ? "var(--cyan)" : "var(--purple)",
          line: lineNum,
          depth: m[1].length - 1,
        });
      }
      continue;
    }

    if (lang === "json") {
      const m = raw.match(/^(\s{0,4})"([^"]+)"\s*:\s*([{\[]|.+)/);
      if (m) {
        const depth = Math.floor(m[1].length / 2);
        const isContainer = m[3].startsWith("{") || m[3].startsWith("[");
        if (depth <= 2) {
          symbols.push({
            label: m[2],
            kind: m[3].startsWith("[") ? "arr" : isContainer ? "obj" : "key",
            color: isContainer ? "var(--warning)" : "var(--cyan)",
            line: lineNum,
            depth,
          });
        }
      }
      continue;
    }

    if (lang === "yaml") {
      const m = raw.match(/^(\s{0,4})([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/);
      if (m && !raw.trim().startsWith("#")) {
        const depth = Math.floor(m[1].length / 2);
        if (depth <= 1) {
          symbols.push({
            label: m[2],
            kind: m[3] ? "val" : "sec",
            color: depth === 0 ? "var(--purple)" : "var(--cyan)",
            line: lineNum,
            depth,
          });
        }
      }
      continue;
    }

    if (lang === "toml") {
      const m = raw.match(/^\s*(\[\[?[^\]]+\]\]?)/);
      if (m) {
        const isArr = m[1].startsWith("[[");
        symbols.push({
          label: m[1].replace(/^\[+|\]+$/g, ""),
          kind: isArr ? "arr" : "tbl",
          color: "var(--cyan)",
          line: lineNum,
          depth: isArr ? 1 : 0,
        });
      }
      continue;
    }

    if (lang === "rust") {
      const m = raw.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod|const|type)\s+([A-Za-z0-9_<>:]+)/);
      if (m) {
        const indent = raw.length - raw.trimStart().length;
        symbols.push({
          label: m[2],
          kind: m[1],
          color: m[1] === "fn" ? "var(--accent)" : m[1] === "struct" || m[1] === "enum" ? "var(--orange)" : "var(--purple)",
          line: lineNum,
          depth: indent >= 4 ? 1 : 0,
        });
      }
      continue;
    }

    if (lang === "python") {
      const m = raw.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
      if (m) {
        symbols.push({
          label: m[3],
          kind: m[2],
          color: m[2] === "class" ? "var(--warning)" : "var(--accent)",
          line: lineNum,
          depth: Math.min(2, Math.floor(m[1].length / 4)),
        });
      }
      continue;
    }

    if (lang === "typescript" || lang === "javascript") {
      const m =
        raw.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/) ??
        raw.match(/^\s*(?:export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      if (m) {
        symbols.push({
          label: m[2],
          kind: m[1] === "const" || m[1] === "let" ? "fn" : m[1].slice(0, 4),
          color: m[1] === "interface" || m[1] === "type" ? "var(--cyan)" : m[1] === "class" ? "var(--warning)" : "var(--accent)",
          line: lineNum,
          depth: raw.startsWith("  ") ? 1 : 0,
        });
      }
      continue;
    }

    if (lang === "css") {
      const m = raw.match(/^([.@#:a-zA-Z][^{]+)\{/);
      if (m) {
        const sel = m[1].trim();
        symbols.push({
          label: sel.length > 36 ? sel.slice(0, 36) + "…" : sel,
          kind: sel.startsWith("@") ? "at" : "css",
          color: sel.startsWith("@") ? "var(--purple)" : "var(--cyan)",
          line: lineNum,
          depth: 0,
        });
      }
      continue;
    }

    if (lang === "sql") {
      const m = raw.match(/^\s*(CREATE\s+(?:TABLE|VIEW|INDEX)|SELECT|WITH|ALTER\s+TABLE|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b(.*)/i);
      if (m) {
        symbols.push({
          label: `${m[1].toUpperCase()} ${(m[2] ?? "").trim().slice(0, 28)}`.trim(),
          kind: "sql",
          color: "var(--success)",
          line: lineNum,
          depth: 0,
        });
      }
      continue;
    }

    if (lang === "go" || lang === "java" || lang === "cpp" || lang === "php") {
      const m = raw.match(/^\s*(?:public|private|protected|static|export)?\s*(func|function|class|struct|interface|type)\s+([A-Za-z_]\w*)/);
      if (m) {
        symbols.push({
          label: m[2],
          kind: m[1].slice(0, 4),
          color: "var(--accent)",
          line: lineNum,
          depth: 0,
        });
      }
    }
  }

  return symbols;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  activeView,
  onSelectView,
  width,
  workspaceName,
  tree,
  activeFilePath,
  onOpenFile,
  onOpenFolder,
  onRefreshTree,
  onNewFile,
  onNewFolder,
  onDeleteEntry,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  isSearching,
  onRunSearch,
  onJumpToMatch,
  activeTab,
  onJumpToLine,
  onRunTransform,
  onFormatDocument,
  onConvertFormat,
  selectionInfo,
  docStats,
}) => {
  // Explorer tree state
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);

  // Search options
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);

  // Outline filter
  const [outlineFilter, setOutlineFilter] = useState("");

  // Utilities state
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    format: true,
    lines: true,
    filter: true,
    case: true,
    encode: true,
    crypto: true,
  });
  const [regexArg, setRegexArg] = useState("");
  const [affixArg, setAffixArg] = useState("");
  const [joinSep, setJoinSep] = useState(", ");

  const outlineSymbols = useMemo(() => extractOutline(activeTab), [activeTab]);
  const filteredOutline = useMemo(() => {
    const q = outlineFilter.trim().toLowerCase();
    if (!q) return outlineSymbols;
    return outlineSymbols.filter(
      (s) => s.label.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q)
    );
  }, [outlineSymbols, outlineFilter]);

  const groupedSearch = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of searchResults) {
      const list = map.get(m.path) ?? [];
      list.push(m);
      map.set(m.path, list);
    }
    return Array.from(map.entries());
  }, [searchResults]);

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const triggerSearch = (q = searchQuery) => {
    onRunSearch(q, { isRegex, caseSensitive, wholeWord });
  };

  const renderTree = (nodes: TreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      const isDir = node.is_dir;
      const isCollapsed = Boolean(collapsedDirs[node.path]);
      const isActive = !isDir && activeFilePath === node.path;
      const isHovered = hoveredPath === node.path;
      const extColor = node.extension ? EXT_COLORS[node.extension.toLowerCase()] : undefined;

      return (
        <div key={node.path}>
          <div
            onClick={() => (isDir ? toggleDir(node.path) : onOpenFile(node.path))}
            onMouseEnter={() => setHoveredPath(node.path)}
            onMouseLeave={() => setHoveredPath((cur) => (cur === node.path ? null : cur))}
            title={node.path}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 4,
              height: 25,
              paddingLeft: 8 + depth * 14,
              paddingRight: 6,
              cursor: "pointer",
              borderRadius: 4,
              margin: "1px 4px",
              background: isActive
                ? "var(--accent-soft)"
                : isHovered
                  ? "var(--bg-hover)"
                  : "transparent",
              color: isActive ? "var(--accent)" : "var(--text-primary)",
              fontWeight: isActive ? 500 : 400,
              fontSize: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, flex: 1 }}>
              {isDir ? (
                <>
                  {isCollapsed ? (
                    <ChevronRight size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  ) : (
                    <ChevronDown size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  )}
                  {isCollapsed ? (
                    <Folder size={13} style={{ color: "var(--warning)", flexShrink: 0 }} />
                  ) : (
                    <FolderOpen size={13} style={{ color: "var(--warning)", flexShrink: 0 }} />
                  )}
                </>
              ) : (
                <>
                  <span style={{ width: 12, flexShrink: 0 }} />
                  <FileCode2
                    size={13}
                    style={{ color: extColor ?? "var(--text-muted)", flexShrink: 0 }}
                  />
                </>
              )}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {node.name}
              </span>
            </div>

            {isHovered && (
              <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                {isDir && (
                  <button
                    type="button"
                    title="New File in Folder"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewFile(node.path);
                    }}
                    style={tinyActionBtn}
                  >
                    <FilePlus2 size={11} />
                  </button>
                )}
                {onDeleteEntry && (
                  <button
                    type="button"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteEntry(node.path);
                    }}
                    style={{ ...tinyActionBtn, color: "var(--danger)" }}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            )}
          </div>

          {isDir && !isCollapsed && node.children && node.children.length > 0 && (
            <div>{renderTree(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });

  return (
    <div
      className="kunai-sidebar-shell"
      style={{
        display: "flex",
        flexShrink: 0,
        height: "100%",
        userSelect: "none",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
      }}
    >
      {/* 44px Left Activity Rail (always visible) */}
      <nav
        aria-label="Sidebar Views"
        style={{
          width: 44,
          minWidth: 44,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 6,
          gap: 4,
          background: "var(--bg-tertiary)",
          borderRight: "1px solid var(--border)",
        }}
      >
        {VIEW_TABS.map((v) => {
          const active = isOpen && activeView === v.id;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={active}
              title={v.label}
              onClick={() => onSelectView(v.id)}
              style={{
                position: "relative",
                width: 34,
                height: 34,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                border: active ? "1px solid var(--accent-border)" : "1px solid transparent",
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {active && (
                <span
                  style={{
                    position: "absolute",
                    left: -5,
                    top: 6,
                    bottom: 6,
                    width: 2.5,
                    borderRadius: 2,
                    background: "var(--accent)",
                  }}
                />
              )}
              {v.icon}
            </button>
          );
        })}
      </nav>

      {/* Collapsible Panel Content */}
      {isOpen && (
        <aside
          className="kunai-sidebar"
          style={{
            width,
            minWidth: 200,
            maxWidth: 480,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-secondary)",
            borderRight: "1px solid var(--border)",
            color: "var(--text-primary)",
            overflow: "hidden",
          }}
        >
          {/* Active view header */}
          <div
            style={{
              height: 34,
              minHeight: 34,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-secondary)",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-secondary)",
              }}
            >
              {VIEW_TABS.find((t) => t.id === activeView)?.label ?? "Explorer"}
            </span>
            {activeView === "utilities" && (
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 600,
                  padding: "1px 5px",
                  borderRadius: 4,
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                NPP+
              </span>
            )}
          </div>

      {/* ================= EXPLORER VIEW ================= */}
      {activeView === "explorer" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={sectionHeaderStyle}>
            <span
              title={workspaceName}
              style={{
                fontWeight: 600,
                fontSize: 11,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {workspaceName}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button type="button" onClick={() => onNewFile()} title="New File" style={tinyActionBtn}>
                <FilePlus2 size={13} />
              </button>
              {onNewFolder && (
                <button
                  type="button"
                  onClick={() => onNewFolder()}
                  title="New Folder"
                  style={tinyActionBtn}
                >
                  <FolderPlus size={13} />
                </button>
              )}
              <button type="button" onClick={onOpenFolder} title="Open Folder" style={tinyActionBtn}>
                <FolderOpen size={13} />
              </button>
              <button type="button" onClick={onRefreshTree} title="Refresh Tree" style={tinyActionBtn}>
                <RefreshCw size={12} />
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {tree.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>
                <p style={{ margin: "0 0 10px" }}>No files in workspace</p>
                <button type="button" onClick={onOpenFolder} style={primaryMiniBtn}>
                  Open Folder
                </button>
              </div>
            ) : (
              renderTree(tree, 0)
            )}
          </div>
        </div>
      )}

      {/* ================= GLOBAL SEARCH VIEW ================= */}
      {activeView === "search" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") triggerSearch(searchQuery);
                }}
                placeholder="Search workspace..."
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => triggerSearch(searchQuery)}
                style={{
                  ...primaryMiniBtn,
                  padding: "0 9px",
                  flexShrink: 0,
                }}
              >
                {isSearching ? <Loader2 size={12} className="spin" /> : "Find"}
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  title="Match Case"
                  onClick={() => {
                    const next = !caseSensitive;
                    setCaseSensitive(next);
                    if (searchQuery) onRunSearch(searchQuery, { isRegex, caseSensitive: next, wholeWord });
                  }}
                  style={toggleChipStyle(caseSensitive)}
                >
                  Aa
                </button>
                <button
                  type="button"
                  title="Whole Word"
                  onClick={() => {
                    const next = !wholeWord;
                    setWholeWord(next);
                    if (searchQuery) onRunSearch(searchQuery, { isRegex, caseSensitive, wholeWord: next });
                  }}
                  style={toggleChipStyle(wholeWord)}
                >
                  ab
                </button>
                <button
                  type="button"
                  title="Regular Expression"
                  onClick={() => {
                    const next = !isRegex;
                    setIsRegex(next);
                    if (searchQuery) onRunSearch(searchQuery, { isRegex: next, caseSensitive, wholeWord });
                  }}
                  style={toggleChipStyle(isRegex)}
                >
                  .*
                </button>
              </div>
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                {searchResults.length} {searchResults.length === 1 ? "match" : "matches"}
              </span>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {groupedSearch.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 11.5 }}>
                {searchQuery ? "No matches found" : "Type a query and press Enter"}
              </div>
            ) : (
              groupedSearch.map(([filePath, matches]) => {
                const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
                return (
                  <div key={filePath} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "4px 10px",
                        fontSize: 11,
                        fontWeight: 600,
                        color: "var(--text-secondary)",
                        background: "var(--bg-tertiary)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {fileName}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "0 5px",
                          borderRadius: 999,
                          background: "var(--bg-badge)",
                          color: "var(--text-muted)",
                        }}
                      >
                        {matches.length}
                      </span>
                    </div>
                    {matches.map((m, idx) => (
                      <button
                        key={`${m.path}:${m.line_number}:${idx}`}
                        type="button"
                        onClick={() => onJumpToMatch(m)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "baseline",
                          gap: 6,
                          padding: "4px 10px",
                          border: "none",
                          background: "transparent",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                        }}
                      >
                        <span style={{ color: "var(--text-muted)", minWidth: 24, textAlign: "right", flexShrink: 0 }}>
                          {m.line_number}
                        </span>
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {m.line_text.trim()}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ================= OUTLINE VIEW ================= */}
      {activeView === "outline" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <input
              type="text"
              value={outlineFilter}
              onChange={(e) => setOutlineFilter(e.target.value)}
              placeholder="Filter symbols..."
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {!activeTab ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>
                No active document
              </div>
            ) : filteredOutline.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>
                No outline symbols found
              </div>
            ) : (
              filteredOutline.map((sym, idx) => (
                <button
                  key={`${sym.line}-${sym.label}-${idx}`}
                  type="button"
                  onClick={() => onJumpToLine(sym.line)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                    padding: `4px 10px 4px ${10 + sym.depth * 12}px`,
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 12,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 9.5,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        color: sym.color,
                        minWidth: 26,
                        flexShrink: 0,
                      }}
                    >
                      {sym.kind}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {sym.label}
                    </span>
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  >
                    :{sym.line}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* ================= NOTEPAD++ UTILITY TOOLBOX ================= */}
      {activeView === "utilities" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {/* Active Scope Banner */}
          <div
            style={{
              padding: "7px 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-tertiary)",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Target Scope
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: selectionInfo.selectionLength > 0 ? "var(--accent-soft)" : "var(--bg-badge)",
                  color: selectionInfo.selectionLength > 0 ? "var(--accent)" : "var(--text-muted)",
                }}
              >
                {selectionInfo.selectionLength > 0
                  ? `Selection (${selectionInfo.selectionLength} ch)`
                  : "Whole Doc"}
              </span>
            </div>
            {docStats && (
              <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {docStats.lines} ln · {docStats.words} wd · {docStats.chars} ch · ~{docStats.reading_time_sec}s
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px 16px" }}>
            {/* Group 1: Format & Convert */}
            <AccordionGroup
              title="Format & Convert"
              isOpen={openGroups.format}
              onToggle={() => toggleGroup("format")}
            >
              <div style={gridTwoStyle}>
                <button type="button" onClick={() => onFormatDocument(false)} style={toolBtnPrimary}>
                  <Sparkles size={11} />
                  <span>Format</span>
                </button>
                <button type="button" onClick={() => onFormatDocument(true)} style={toolBtnStyle}>
                  <Minimize2 size={11} />
                  <span>Minify</span>
                </button>
                <button type="button" onClick={() => onRunTransform("json_sort_keys")} style={{ ...toolBtnStyle, gridColumn: "span 2" }}>
                  Sort JSON Keys Recursively
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginTop: 5 }}>
                {(["json", "yaml", "toml", "csv"] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => onConvertFormat(fmt)}
                    title={`Convert document to ${fmt.toUpperCase()}`}
                    style={toolBtnStyle}
                  >
                    →{fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </AccordionGroup>

            {/* Group 2: Line Operations */}
            <AccordionGroup
              title="Line Operations"
              isOpen={openGroups.lines}
              onToggle={() => toggleGroup("lines")}
            >
              <div style={gridTwoStyle}>
                <button type="button" onClick={() => onRunTransform("sort_asc")} style={toolBtnStyle}>Sort A → Z</button>
                <button type="button" onClick={() => onRunTransform("sort_desc")} style={toolBtnStyle}>Sort Z → A</button>
                <button type="button" onClick={() => onRunTransform("sort_ci_asc")} style={toolBtnStyle}>Sort A → z (CI)</button>
                <button type="button" onClick={() => onRunTransform("sort_length_asc")} style={toolBtnStyle}>Sort Length</button>
                <button type="button" onClick={() => onRunTransform("sort_numeric_asc")} style={toolBtnStyle}>Sort Num ↑</button>
                <button type="button" onClick={() => onRunTransform("sort_numeric_desc")} style={toolBtnStyle}>Sort Num ↓</button>
                <button type="button" onClick={() => onRunTransform("dedupe_lines")} style={toolBtnStyle}>Dedupe Lines</button>
                <button type="button" onClick={() => onRunTransform("reverse_lines")} style={toolBtnStyle}>Reverse Lines</button>
                <button type="button" onClick={() => onRunTransform("remove_empty_lines")} style={toolBtnStyle}>Rm Empty</button>
                <button type="button" onClick={() => onRunTransform("remove_blank_lines")} style={toolBtnStyle}>Rm Blank</button>
                <button type="button" onClick={() => onRunTransform("trim_trailing")} style={toolBtnStyle}>Trim Trailing</button>
                <button type="button" onClick={() => onRunTransform("trim_leading")} style={toolBtnStyle}>Trim Leading</button>
                <button type="button" onClick={() => onRunTransform("trim_both")} style={toolBtnStyle}>Trim Both</button>
                <button type="button" onClick={() => onRunTransform("number_lines")} style={toolBtnStyle}>Number Lines</button>
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
                <input
                  type="text"
                  value={joinSep}
                  onChange={(e) => setJoinSep(e.target.value)}
                  placeholder="Separator..."
                  style={{ ...inputStyle, height: 24, fontSize: 11 }}
                />
                <button
                  type="button"
                  onClick={() => onRunTransform("join_lines", joinSep)}
                  style={{ ...toolBtnStyle, flexShrink: 0, padding: "0 8px" }}
                >
                  Join
                </button>
              </div>
            </AccordionGroup>

            {/* Group 3: Regex Filter & Affix */}
            <AccordionGroup
              title="Regex Filter & Affix"
              isOpen={openGroups.filter}
              onToggle={() => toggleGroup("filter")}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <input
                  type="text"
                  value={regexArg}
                  onChange={(e) => setRegexArg(e.target.value)}
                  placeholder="Regex pattern (e.g. ^ERROR|WARN)"
                  style={{ ...inputStyle, height: 25, fontSize: 11, fontFamily: "var(--font-mono)" }}
                />
                <div style={gridTwoStyle}>
                  <button
                    type="button"
                    onClick={() => onRunTransform("filter_keep_regex", regexArg)}
                    style={toolBtnStyle}
                  >
                    <Filter size={10} />
                    <span>Keep Match</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRunTransform("filter_remove_regex", regexArg)}
                    style={toolBtnStyle}
                  >
                    <Filter size={10} />
                    <span>Remove Match</span>
                  </button>
                </div>

                <input
                  type="text"
                  value={affixArg}
                  onChange={(e) => setAffixArg(e.target.value)}
                  placeholder="Prefix / Suffix text..."
                  style={{ ...inputStyle, height: 25, fontSize: 11, fontFamily: "var(--font-mono)", marginTop: 2 }}
                />
                <div style={gridTwoStyle}>
                  <button
                    type="button"
                    onClick={() => onRunTransform("add_prefix", affixArg)}
                    style={toolBtnStyle}
                  >
                    + Add Prefix
                  </button>
                  <button
                    type="button"
                    onClick={() => onRunTransform("add_suffix", affixArg)}
                    style={toolBtnStyle}
                  >
                    + Add Suffix
                  </button>
                </div>
              </div>
            </AccordionGroup>

            {/* Group 4: Case Convert */}
            <AccordionGroup
              title="Case Convert"
              isOpen={openGroups.case}
              onToggle={() => toggleGroup("case")}
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                <button type="button" onClick={() => onRunTransform("upper")} style={toolBtnStyle}>UPPER</button>
                <button type="button" onClick={() => onRunTransform("lower")} style={toolBtnStyle}>lower</button>
                <button type="button" onClick={() => onRunTransform("title")} style={toolBtnStyle}>Title</button>
                <button type="button" onClick={() => onRunTransform("camel")} style={toolBtnStyle}>camelCase</button>
                <button type="button" onClick={() => onRunTransform("pascal")} style={toolBtnStyle}>Pascal</button>
                <button type="button" onClick={() => onRunTransform("snake")} style={toolBtnStyle}>snake_c</button>
                <button type="button" onClick={() => onRunTransform("kebab")} style={toolBtnStyle}>kebab-c</button>
                <button type="button" onClick={() => onRunTransform("screaming_snake")} style={toolBtnStyle}>CONST</button>
                <button type="button" onClick={() => onRunTransform("invert_case")} style={toolBtnStyle}>iNVERT</button>
              </div>
            </AccordionGroup>

            {/* Group 5: Encode / Decode / JWT */}
            <AccordionGroup
              title="Encode / Decode / JWT"
              isOpen={openGroups.encode}
              onToggle={() => toggleGroup("encode")}
            >
              <div style={gridTwoStyle}>
                <button type="button" onClick={() => onRunTransform("base64_encode")} style={toolBtnStyle}>Base64 Enc</button>
                <button type="button" onClick={() => onRunTransform("base64_decode")} style={toolBtnStyle}>Base64 Dec</button>
                <button type="button" onClick={() => onRunTransform("url_encode")} style={toolBtnStyle}>URL Enc</button>
                <button type="button" onClick={() => onRunTransform("url_decode")} style={toolBtnStyle}>URL Dec</button>
                <button type="button" onClick={() => onRunTransform("html_encode")} style={toolBtnStyle}>HTML Enc</button>
                <button type="button" onClick={() => onRunTransform("html_decode")} style={toolBtnStyle}>HTML Dec</button>
                <button type="button" onClick={() => onRunTransform("hex_encode")} style={toolBtnStyle}>Hex Enc</button>
                <button type="button" onClick={() => onRunTransform("hex_decode")} style={toolBtnStyle}>Hex Dec</button>
                <button type="button" onClick={() => onRunTransform("unicode_escape")} style={toolBtnStyle}>Unicode Esc</button>
                <button type="button" onClick={() => onRunTransform("unicode_unescape")} style={toolBtnStyle}>Unicode Unesc</button>
                <button type="button" onClick={() => onRunTransform("json_escape")} style={toolBtnStyle}>JSON Esc</button>
                <button type="button" onClick={() => onRunTransform("json_unescape")} style={toolBtnStyle}>JSON Unesc</button>
                <button
                  type="button"
                  onClick={() => onRunTransform("jwt_decode")}
                  style={{ ...toolBtnPrimary, gridColumn: "span 2" }}
                >
                  Decode JWT Token
                </button>
              </div>
            </AccordionGroup>

            {/* Group 6: Hash / UUID / Timestamps */}
            <AccordionGroup
              title="Hash / UUID / Time"
              isOpen={openGroups.crypto}
              onToggle={() => toggleGroup("crypto")}
            >
              <div style={gridTwoStyle}>
                <button type="button" onClick={() => onRunTransform("hash_md5")} style={toolBtnStyle}>MD5</button>
                <button type="button" onClick={() => onRunTransform("hash_sha1")} style={toolBtnStyle}>SHA-1</button>
                <button type="button" onClick={() => onRunTransform("hash_sha256")} style={toolBtnStyle}>SHA-256</button>
                <button type="button" onClick={() => onRunTransform("hash_sha512")} style={toolBtnStyle}>SHA-512</button>
                <button type="button" onClick={() => onRunTransform("timestamp_to_iso")} style={toolBtnStyle}>Unix → ISO</button>
                <button type="button" onClick={() => onRunTransform("iso_to_timestamp")} style={toolBtnStyle}>ISO → Unix</button>
                <button
                  type="button"
                  onClick={() => onRunTransform("gen_uuid")}
                  style={{ ...toolBtnPrimary, gridColumn: "span 2" }}
                >
                  Generate UUID v4
                </button>
              </div>
            </AccordionGroup>
          </div>
        </div>
      )}
        </aside>
      )}
    </div>
  );
};

function AccordionGroup({
  title,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        marginBottom: 8,
        borderRadius: 6,
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-primary)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          border: "none",
          background: "var(--bg-tertiary)",
          color: "var(--text-secondary)",
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{title}</span>
      </button>
      {isOpen && <div style={{ padding: 6 }}>{children}</div>}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 8px 6px 10px",
  borderBottom: "1px solid var(--border-subtle)",
  gap: 6,
};

const tinyActionBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 26,
  padding: "0 8px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const primaryMiniBtn: React.CSSProperties = {
  height: 26,
  padding: "0 10px",
  borderRadius: 5,
  border: "1px solid var(--accent-border)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
};

function toggleChipStyle(active: boolean): React.CSSProperties {
  return {
    height: 21,
    padding: "0 6px",
    borderRadius: 4,
    border: active ? "1px solid var(--accent-border)" : "1px solid var(--border)",
    background: active ? "var(--accent-soft)" : "var(--bg-primary)",
    color: active ? "var(--accent)" : "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    fontWeight: 600,
    cursor: "pointer",
  };
}

const gridTwoStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 4,
};

const toolBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  height: 25,
  padding: "0 6px",
  borderRadius: 4,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const toolBtnPrimary: React.CSSProperties = {
  ...toolBtnStyle,
  border: "1px solid var(--accent-border)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
  fontWeight: 600,
};

export default Sidebar;

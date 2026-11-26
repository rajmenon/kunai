import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type {
  CommandItem,
  CursorInfo,
  DocStats,
  EditorHandle,
  EditorSettings,
  EditorTab,
  EncodingName,
  LanguageId,
  LineEnding,
  PaletteMode,
  QuickOpenFileItem,
  SearchMatch,
  SidebarView,
  SplitMode,
  ThemeId,
  ToastMessage,
  TreeNode,
} from "./types/editor";
import {
  computeDiff,
  computeStats,
  convertFormat,
  createFsEntry,
  deleteFsEntry,
  formatDocument,
  getDemoWorkspaceInfo,
  isPdfPath,
  isTauriRuntime,
  listWorkspaceTree,
  pickOpenFile,
  pickOpenFolder,
  pickSaveAsPath,
  queryJson,
  readBinaryFile,
  readFileSmart,
  searchWorkspace,
  transformText,
  triggerBrowserDownload,
  validateDocument,
  writeFileSmart,
} from "./services/bridge";
import {
  detectLanguageFromPath,
  isValidatableLanguage,
  THEME_OPTIONS,
} from "./services/languages";
import { DEMO_WORKSPACE_ROOT, SAMPLE_FILES } from "./services/sampleFiles";
import { isSafeToPreview } from "./utils/previewSecurity";
import { EditorPane } from "./components/editor/EditorPane";
import { TitleBar } from "./components/chrome/TitleBar";
import { TabBar } from "./components/chrome/TabBar";
import { StatusBar } from "./components/chrome/StatusBar";
import { Sidebar } from "./components/panels/Sidebar";
import { CommandPalette } from "./components/overlays/CommandPalette";
import { FormatPreview } from "./components/previews/FormatPreview";
import { PdfViewer } from "./components/previews/PdfViewer";
import { uint8ArrayToBase64 } from "./utils/samplePdf";

const SETTINGS_STORAGE_KEY = "kunai-settings-v1";

const DEFAULT_SETTINGS: EditorSettings = {
  theme: "zed-dark",
  fontSize: 13.5,
  tabSize: 2,
  useTabs: false,
  wordWrap: false,
  showMinimap: true,
  showLineNumbers: true,
  alwaysOpenInPreview: false,
};

function loadSavedSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function makeTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createInitialTabs(): EditorTab[] {
  const starterNames = [
    "welcome.md",
    "config.json",
    "engine.rs",
    "docker-compose.yaml",
    "Cargo.toml",
  ];
  const chosen = starterNames
    .map((n) => SAMPLE_FILES.find((f) => f.name === n))
    .filter((f): f is (typeof SAMPLE_FILES)[number] => Boolean(f));

  return chosen.map((file, idx) => ({
    id: `starter-${idx}-${file.name}`,
    title: file.name,
    path: file.path,
    content: file.content,
    savedContent: file.content,
    language: detectLanguageFromPath(file.name),
    encoding: "UTF-8",
    lineEnding: "LF",
    isDirty: false,
    isPinned: idx === 0,
    cursorLine: 1,
    cursorCol: 1,
    cursorCount: 1,
    selectionLength: 0,
  }));
}

function flattenTreeFiles(
  nodes: TreeNode[],
  rootPath: string | null,
  openPaths: Set<string>
): QuickOpenFileItem[] {
  const out: QuickOpenFileItem[] = [];
  const normRoot = rootPath ? rootPath.replace(/\\/g, "/").replace(/\/$/, "") : "";

  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.is_dir) {
        if (node.children) walk(node.children);
      } else {
        const normPath = node.path.replace(/\\/g, "/");
        const relativePath =
          normRoot && normPath.startsWith(normRoot + "/")
            ? normPath.slice(normRoot.length + 1)
            : node.name;
        out.push({
          path: node.path,
          name: node.name,
          relativePath,
          extension: node.extension,
          isOpen: openPaths.has(node.path),
        });
      }
    }
  };
  walk(nodes);
  return out;
}

export default function App() {
  const inTauri = useMemo(() => isTauriRuntime(), []);
  const demoInfo = useMemo(() => getDemoWorkspaceInfo(), []);

  const [settings, setSettings] = useState<EditorSettings>(loadSavedSettings);
  const [tabs, setTabs] = useState<EditorTab[]>(createInitialTabs);
  const [activeTabId, setActiveTabId] = useState<string>(
    () => createInitialTabs()[0]?.id ?? ""
  );

  const effectiveActiveTabId = useMemo(() => {
    if (tabs.some((t) => t.id === activeTabId)) return activeTabId;
    return tabs[0]?.id ?? "";
  }, [tabs, activeTabId]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === effectiveActiveTabId) ?? null,
    [tabs, effectiveActiveTabId]
  );

  const activePreviewSecurity = useMemo(() => {
    if (!activeTab) {
      return { allowed: false, reason: "No active file" };
    }
    return isSafeToPreview(activeTab.language, activeTab.path ?? activeTab.title);
  }, [activeTab]);

  const [secondaryTabId, setSecondaryTabId] = useState<string>("");
  const [splitMode, setSplitMode] = useState<SplitMode>("none");
  const [splitRatio, setSplitRatio] = useState<number>(0.48);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer");
  const [sidebarWidth, setSidebarWidth] = useState<number>(264);

  const [workspaceName, setWorkspaceName] = useState<string>(demoInfo.name);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(demoInfo.root);
  const [tree, setTree] = useState<TreeNode[]>([]);

  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("commands");

  const [cursorInfo, setCursorInfo] = useState<CursorInfo>({
    line: 1,
    col: 1,
    cursorCount: 1,
    selectionLength: 0,
    selectionLines: 0,
    selectedText: "",
  });
  const [docStats, setDocStats] = useState<DocStats | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);

  const editorRef = useRef<EditorHandle>(null);
  const untitledCounterRef = useRef<number>(1);
  const draggingResizeRef = useRef<"sidebar" | "split" | null>(null);
  const workspaceSplitRef = useRef<HTMLDivElement>(null);

  // Sync theme to document root & persist settings
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage quota errors
    }
  }, [settings]);

  const showToast = useCallback(
    (
      title: string,
      detail?: string,
      kind: ToastMessage["kind"] = "info"
    ) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { id, kind, title, detail }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3400);
    },
    []
  );

  // Enforce preview security + Always Open in Preview whenever active tab or language changes
  useEffect(() => {
    if (!activeTab) {
      setSplitMode((prev) =>
        prev === "preview" || prev === "preview-only" ? "none" : prev
      );
      return;
    }

    const sec = isSafeToPreview(activeTab.language, activeTab.path ?? activeTab.title);
    if (!sec.allowed) {
      // Executable/scriptable files are NEVER previewed
      setSplitMode((prev) =>
        prev === "preview" || prev === "preview-only" ? "none" : prev
      );
      return;
    }

    if (settings.alwaysOpenInPreview) {
      setSplitMode((prev) =>
        prev === "preview" || prev === "diff" ? prev : "preview-only"
      );
    }
  }, [activeTab?.id, activeTab?.language, activeTab?.path, activeTab?.title, settings.alwaysOpenInPreview]);

  // Toggle Always Open in Preview (Ctrl+Alt+P)
  const handleToggleAlwaysOpenInPreview = useCallback(() => {
    setSettings((prev) => {
      const next = !prev.alwaysOpenInPreview;
      if (next) {
        if (activeTab) {
          const sec = isSafeToPreview(
            activeTab.language,
            activeTab.path ?? activeTab.title
          );
          if (sec.allowed) {
            setSplitMode((curr) => (curr === "preview" ? "preview" : "preview-only"));
            showToast(
              "Always Open in Preview: ON",
              "Safe files open in formatted preview (Ctrl+Shift+V for side-by-side)",
              "success"
            );
          } else {
            setSplitMode((curr) =>
              curr === "preview" || curr === "preview-only" ? "none" : curr
            );
            showToast(
              "Always Open in Preview: ON",
              `Current file skipped (${sec.reason ?? "scriptable file"})`,
              "warning"
            );
          }
        } else {
          showToast("Always Open in Preview: ON", undefined, "success");
        }
      } else {
        setSplitMode((curr) => (curr === "preview-only" ? "none" : curr));
        showToast("Always Open in Preview: OFF", "Files open in editor mode", "info");
      }
      return { ...prev, alwaysOpenInPreview: next };
    });
  }, [activeTab, showToast]);

  // Quick keyboard toggle Ctrl+Shift+V (Markup + Preview Side-by-Side)
  const handleToggleSideBySidePreview = useCallback(() => {
    if (!activeTab) return;
    const sec = isSafeToPreview(
      activeTab.language,
      activeTab.path ?? activeTab.title
    );
    if (!sec.allowed) {
      setSplitMode((prev) =>
        prev === "preview" || prev === "preview-only" ? "none" : prev
      );
      showToast(
        "Preview blocked",
        sec.reason ?? "Executable and scriptable files cannot be previewed.",
        "warning"
      );
      return;
    }

    setSplitMode((prev) => {
      if (prev === "preview") {
        return settings.alwaysOpenInPreview ? "preview-only" : "none";
      }
      // From "none", "preview-only", "editor", or "diff" -> Side-by-Side!
      return "preview";
    });
  }, [activeTab, settings.alwaysOpenInPreview, showToast]);

  // Switch between Full Preview ("preview-only") and Side-by-Side ("preview") from FormatPreview header
  const handlePreviewHeaderToggleSideBySide = useCallback(() => {
    if (!activeTab) return;
    const sec = isSafeToPreview(
      activeTab.language,
      activeTab.path ?? activeTab.title
    );
    if (!sec.allowed) {
      setSplitMode("none");
      showToast(
        "Preview blocked",
        sec.reason ?? "Executable and scriptable files cannot be previewed.",
        "warning"
      );
      return;
    }
    setSplitMode((prev) => (prev === "preview-only" ? "preview" : "preview-only"));
  }, [activeTab, showToast]);

  const handleOpenFullPreviewOnly = useCallback(() => {
    if (!activeTab) return;
    const sec = isSafeToPreview(
      activeTab.language,
      activeTab.path ?? activeTab.title
    );
    if (!sec.allowed) {
      setSplitMode((prev) =>
        prev === "preview" || prev === "preview-only" ? "none" : prev
      );
      showToast(
        "Preview blocked",
        sec.reason ?? "Executable and scriptable files cannot be previewed.",
        "warning"
      );
      return;
    }
    setSplitMode("preview-only");
  }, [activeTab, showToast]);

  // Load workspace tree
  const refreshTree = useCallback(async () => {
    if (!workspaceRoot) return;
    try {
      const nodes = await listWorkspaceTree(workspaceRoot, 8);
      setTree(nodes);
    } catch (err) {
      showToast(
        "Failed to load workspace tree",
        err instanceof Error ? err.message : String(err),
        "error"
      );
    }
  }, [workspaceRoot, showToast]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  // Live debounced document stats & validation for active tab
  useEffect(() => {
    if (!activeTab || activeTab.isBinary) {
      setDocStats(null);
      return;
    }
    let cancelled = false;
    const tabId = activeTab.id;
    const content = activeTab.content;
    const language = activeTab.language;

    const timer = window.setTimeout(async () => {
      try {
        const stats = await computeStats(content);
        if (!cancelled) setDocStats(stats);
      } catch {
        // ignore stats error
      }

      if (isValidatableLanguage(language)) {
        try {
          const validation = await validateDocument(content, language);
          if (!cancelled) {
            setTabs((prev) =>
              prev.map((t) => (t.id === tabId ? { ...t, validation } : t))
            );
          }
        } catch {
          // ignore validation error
        }
      } else if (activeTab.validation !== undefined) {
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, validation: undefined } : t))
        );
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.content, activeTab?.language]);

  const updateTab = useCallback(
    (tabId: string, updater: (tab: EditorTab) => EditorTab) => {
      setTabs((prev) => prev.map((t) => (t.id === tabId ? updater(t) : t)));
    },
    []
  );

  const handleContentChange = useCallback(
    (tabId: string, newContent: string) => {
      updateTab(tabId, (tab) => ({
        ...tab,
        content: newContent,
        isDirty: newContent !== tab.savedContent,
      }));
    },
    [updateTab]
  );

  const handleCursorChange = useCallback(
    (info: CursorInfo) => {
      setCursorInfo(info);
      if (!effectiveActiveTabId) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === effectiveActiveTabId
            ? {
                ...t,
                cursorLine: info.line,
                cursorCol: info.col,
                cursorCount: info.cursorCount,
                selectionLength: info.selectionLength,
              }
            : t
        )
      );
    },
    [effectiveActiveTabId]
  );

  // Open a file by path (focuses existing tab if already open)
  const handleOpenFileByPath = useCallback(
    async (path: string) => {
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      try {
        if (isPdfPath(path)) {
          const bin = await readBinaryFile(path);
          const newTab: EditorTab = {
            id: makeTabId(),
            title: bin.name,
            path: bin.path,
            content: "",
            savedContent: "",
            language: "pdf",
            encoding: "UTF-8",
            lineEnding: "LF",
            isDirty: false,
            isPinned: false,
            cursorLine: 1,
            cursorCol: 1,
            cursorCount: 1,
            selectionLength: 0,
            isBinary: true,
            binaryBase64: bin.base64,
            sizeBytes: bin.size_bytes,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
          return;
        }
        const payload = await readFileSmart(path);
        const newTab: EditorTab = {
          id: makeTabId(),
          title: payload.name,
          path: payload.path,
          content: payload.content,
          savedContent: payload.content,
          language: detectLanguageFromPath(payload.name),
          encoding: (payload.encoding as EncodingName) || "UTF-8",
          lineEnding: (payload.line_ending as LineEnding) || "LF",
          isDirty: false,
          isPinned: false,
          cursorLine: 1,
          cursorCol: 1,
          cursorCount: 1,
          selectionLength: 0,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
      } catch (err) {
        showToast(
          "Could not open file",
          err instanceof Error ? err.message : String(err),
          "error"
        );
      }
    },
    [tabs, showToast]
  );

  const handleOpenFileDialog = useCallback(async () => {
    try {
      const picked = await pickOpenFile();
      if (!picked) return;
      const existing = tabs.find((t) => t.path === picked.payload.path);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      if (picked.kind === "binary") {
        const bin = picked.payload;
        const newTab: EditorTab = {
          id: makeTabId(),
          title: bin.name,
          path: bin.path,
          content: "",
          savedContent: "",
          language: "pdf",
          encoding: "UTF-8",
          lineEnding: "LF",
          isDirty: false,
          isPinned: false,
          cursorLine: 1,
          cursorCol: 1,
          cursorCount: 1,
          selectionLength: 0,
          isBinary: true,
          binaryBase64: bin.base64,
          sizeBytes: bin.size_bytes,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        void refreshTree();
        return;
      }
      const payload = picked.payload;
      const newTab: EditorTab = {
        id: makeTabId(),
        title: payload.name,
        path: payload.path,
        content: payload.content,
        savedContent: payload.content,
        language: detectLanguageFromPath(payload.name),
        encoding: (payload.encoding as EncodingName) || "UTF-8",
        lineEnding: (payload.line_ending as LineEnding) || "LF",
        isDirty: false,
        isPinned: false,
        cursorLine: 1,
        cursorCol: 1,
        cursorCount: 1,
        selectionLength: 0,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
      void refreshTree();
    } catch (err) {
      showToast(
        "Open File failed",
        err instanceof Error ? err.message : String(err),
        "error"
      );
    }
  }, [tabs, refreshTree, showToast]);

  const handleOpenFolderDialog = useCallback(async () => {
    try {
      const picked = await pickOpenFolder();
      if (!picked) {
        if (!inTauri) {
          showToast(
            "Browser Preview Mode",
            "Using built-in kunai-demo workspace. Run desktop app for native folder browsing.",
            "info"
          );
        }
        return;
      }
      setWorkspaceRoot(picked.root);
      setWorkspaceName(picked.name);
      showToast("Opened folder", picked.name, "success");
    } catch (err) {
      showToast(
        "Open Folder failed",
        err instanceof Error ? err.message : String(err),
        "error"
      );
    }
  }, [inTauri, showToast]);

  const handleNewTab = useCallback(() => {
    const num = untitledCounterRef.current++;
    const newTab: EditorTab = {
      id: makeTabId(),
      title: `Untitled-${num}.txt`,
      path: null,
      content: "",
      savedContent: "",
      language: "plaintext",
      encoding: "UTF-8",
      lineEnding: "LF",
      isDirty: false,
      isPinned: false,
      cursorLine: 1,
      cursorCol: 1,
      cursorCount: 1,
      selectionLength: 0,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleNewFileInTree = useCallback(
    async (parentPath?: string) => {
      const name = window.prompt("New file name (e.g. notes.md, script.ts):");
      if (!name || !name.trim()) return;
      const cleanName = name.trim().replace(/^[/\\]+/, "");
      const base = parentPath || workspaceRoot || DEMO_WORKSPACE_ROOT;
      const sep = base.includes("\\") ? "\\" : "/";
      const fullPath = `${base.replace(/[/\\]+$/, "")}${sep}${cleanName}`;

      try {
        await createFsEntry(fullPath, false);
        await refreshTree();
        await handleOpenFileByPath(fullPath);
        showToast("Created file", cleanName, "success");
      } catch (err) {
        showToast(
          "Create file failed",
          err instanceof Error ? err.message : String(err),
          "error"
        );
      }
    },
    [workspaceRoot, refreshTree, handleOpenFileByPath, showToast]
  );

  const handleNewFolderInTree = useCallback(
    async (parentPath?: string) => {
      const name = window.prompt("New folder name:");
      if (!name || !name.trim()) return;
      const cleanName = name.trim().replace(/^[/\\]+/, "");
      const base = parentPath || workspaceRoot || DEMO_WORKSPACE_ROOT;
      const sep = base.includes("\\") ? "\\" : "/";
      const fullPath = `${base.replace(/[/\\]+$/, "")}${sep}${cleanName}`;

      try {
        await createFsEntry(fullPath, true);
        await refreshTree();
        showToast("Created folder", cleanName, "success");
      } catch (err) {
        showToast(
          "Create folder failed",
          err instanceof Error ? err.message : String(err),
          "error"
        );
      }
    },
    [workspaceRoot, refreshTree, showToast]
  );

  const handleDeleteEntry = useCallback(
    async (path: string) => {
      try {
        await deleteFsEntry(path);
        await refreshTree();
        showToast("Deleted entry", path.split(/[/\\]/).pop(), "info");
      } catch (err) {
        showToast(
          "Delete failed",
          err instanceof Error ? err.message : String(err),
          "error"
        );
      }
    },
    [refreshTree, showToast]
  );

  const handleSaveActiveFile = useCallback(async () => {
    if (!activeTab) return;
    try {
      let targetPath = activeTab.path;
      if (!targetPath) {
        if (inTauri) {
          targetPath = await pickSaveAsPath(activeTab.title);
          if (!targetPath) return;
        } else {
          triggerBrowserDownload(activeTab.title, activeTab.content);
          updateTab(activeTab.id, (t) => ({
            ...t,
            savedContent: t.content,
            isDirty: false,
          }));
          showToast("Downloaded file", activeTab.title, "success");
          return;
        }
      }

      const payload = await writeFileSmart(
        targetPath,
        activeTab.content,
        activeTab.encoding,
        activeTab.lineEnding
      );
      updateTab(activeTab.id, (t) => ({
        ...t,
        path: payload.path,
        title: payload.name,
        savedContent: t.content,
        isDirty: false,
      }));
      void refreshTree();
      showToast(
        "Saved",
        `${payload.name} (${activeTab.encoding}, ${activeTab.lineEnding})`,
        "success"
      );
    } catch (err) {
      showToast(
        "Save failed",
        err instanceof Error ? err.message : String(err),
        "error"
      );
    }
  }, [activeTab, inTauri, updateTab, refreshTree, showToast]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== tabId);
        if (tabId === effectiveActiveTabId) {
          const fallback = next[Math.min(idx, next.length - 1)];
          setActiveTabId(fallback?.id ?? "");
        }
        return next;
      });
    },
    [effectiveActiveTabId]
  );

  const handlePinTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const updated = prev.map((t) =>
        t.id === tabId ? { ...t, isPinned: !t.isPinned } : t
      );
      return [
        ...updated.filter((t) => t.isPinned),
        ...updated.filter((t) => !t.isPinned),
      ];
    });
  }, []);

  // Format, Convert & Notepad++ Transforms
  const handleFormatDocument = useCallback(
    async (minify = false) => {
      if (!activeTab) return;
      const fmt = activeTab.language;
      const supported = ["json", "yaml", "toml", "xml", "html", "css", "sql", "csv"];
      if (!supported.includes(fmt)) {
        showToast(
          "Formatter unavailable",
          `No built-in formatter for ${fmt}. Try JSON, YAML, TOML, XML, HTML, CSS, SQL, or CSV.`,
          "warning"
        );
        return;
      }

      const res = await formatDocument(
        activeTab.content,
        fmt,
        settings.tabSize,
        settings.useTabs,
        minify
      );

      if (!res.ok) {
        const loc =
          res.error_line != null
            ? ` (Ln ${res.error_line}${res.error_col != null ? `, Col ${res.error_col}` : ""})`
            : "";
        showToast("Format Error", `${res.error ?? "Parse failed"}${loc}`, "error");
        if (res.error_line) {
          editorRef.current?.jumpToLine(res.error_line, res.error_col ?? 1);
        }
        return;
      }

      handleContentChange(activeTab.id, res.output);
      showToast(
        minify ? "Minified document" : "Formatted document",
        `${activeTab.title} (${fmt.toUpperCase()})`,
        "success"
      );
    },
    [activeTab, settings.tabSize, settings.useTabs, handleContentChange, showToast]
  );

  const handleConvertFormat = useCallback(
    async (toFormat: "json" | "yaml" | "toml" | "csv") => {
      if (!activeTab) return;
      const fromFormat = activeTab.language;
      if (!["json", "yaml", "toml", "csv"].includes(fromFormat)) {
        showToast(
          "Cannot convert format",
          `Source must be JSON, YAML, TOML, or CSV (currently ${fromFormat}).`,
          "warning"
        );
        return;
      }
      if (fromFormat === toFormat) {
        await handleFormatDocument(false);
        return;
      }

      const res = await convertFormat(activeTab.content, fromFormat, toFormat);
      if (!res.ok) {
        showToast("Conversion failed", res.error ?? "Invalid input", "error");
        return;
      }

      const base = activeTab.title.replace(/\.[^.]+$/, "");
      const newTab: EditorTab = {
        id: makeTabId(),
        title: `${base}.${toFormat}`,
        path: null,
        content: res.output,
        savedContent: "",
        language: toFormat as LanguageId,
        encoding: "UTF-8",
        lineEnding: activeTab.lineEnding,
        isDirty: true,
        isPinned: false,
        cursorLine: 1,
        cursorCol: 1,
        cursorCount: 1,
        selectionLength: 0,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
      showToast(
        `Converted ${fromFormat.toUpperCase()} → ${toFormat.toUpperCase()}`,
        `Opened ${newTab.title}`,
        "success"
      );
    },
    [activeTab, handleFormatDocument, showToast]
  );

  const handleRunTransform = useCallback(
    async (op: string, arg?: string) => {
      if (!activeTab) return;

      if (op === "gen_uuid") {
        const res = await transformText("", op, arg);
        if (res.ok) {
          if (editorRef.current) {
            editorRef.current.insertText(res.output);
          } else {
            handleContentChange(activeTab.id, activeTab.content + res.output);
          }
          showToast("Inserted UUID v4", res.output, "success");
        } else {
          showToast("Transform error", res.error ?? "Failed", "error");
        }
        return;
      }

      const handle = editorRef.current;
      if (!handle) {
        // In full preview-only mode, apply transform to whole document directly
        const res = await transformText(activeTab.content, op, arg);
        if (!res.ok) {
          showToast("Transform error", res.error ?? "Operation failed", "error");
          return;
        }
        handleContentChange(activeTab.id, res.output);
        showToast(
          `Applied: ${op.replace(/_/g, " ")}`,
          res.stats ?? "Applied to document",
          "success"
        );
        return;
      }

      const res = await handle.applyTransformToSelectionOrDoc((input) =>
        transformText(input, op, arg)
      );
      if (!res) return;

      if (!res.ok) {
        showToast("Transform error", res.error ?? "Operation failed", "error");
        return;
      }

      showToast(
        `Applied: ${op.replace(/_/g, " ")}`,
        res.stats ??
          (cursorInfo.selectionLength > 0
            ? "Applied to selection"
            : "Applied to document"),
        "success"
      );
    },
    [activeTab, cursorInfo.selectionLength, handleContentChange, showToast]
  );

  const handleRunSearch = useCallback(
    async (
      query: string,
      opts: { isRegex: boolean; caseSensitive: boolean; wholeWord: boolean }
    ) => {
      setSearchQuery(query);
      if (!query.trim() || !workspaceRoot) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      try {
        const matches = await searchWorkspace(
          workspaceRoot,
          query,
          opts.isRegex,
          opts.caseSensitive,
          opts.wholeWord,
          300
        );
        setSearchResults(matches);
      } catch (err) {
        showToast(
          "Search error",
          err instanceof Error ? err.message : String(err),
          "error"
        );
      } finally {
        setIsSearching(false);
      }
    },
    [workspaceRoot, showToast]
  );

  const handleJumpToMatch = useCallback(
    async (match: SearchMatch) => {
      await handleOpenFileByPath(match.path);
      setSplitMode((prev) => (prev === "preview-only" ? "preview" : prev));
      requestAnimationFrame(() => {
        editorRef.current?.jumpToLine(match.line_number, match.column);
      });
    },
    [handleOpenFileByPath]
  );

  const handleCopyText = useCallback(
    (text: string, label = "Copied to clipboard") => {
      navigator.clipboard?.writeText(text).catch(() => {});
      showToast(label, text.length > 60 ? `${text.slice(0, 60)}…` : text, "success");
    },
    [showToast]
  );

  const handleExtractPdfTextToTab = useCallback(
    (extractedTitle: string, extractedText: string) => {
      const newTab: EditorTab = {
        id: makeTabId(),
        title: extractedTitle,
        path: null,
        content: extractedText,
        savedContent: "",
        language: "plaintext",
        encoding: "UTF-8",
        lineEnding: "LF",
        isDirty: true,
        isPinned: false,
        cursorLine: 1,
        cursorCol: 1,
        cursorCount: 1,
        selectionLength: 0,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
      showToast("Extracted PDF text", `Opened ${extractedTitle}`, "success");
    },
    [showToast]
  );

  const handleChangeSplitMode = useCallback(
    (nextMode: SplitMode) => {
      if (nextMode === "preview") {
        handleToggleSideBySidePreview();
        return;
      }
      if (nextMode === "preview-only") {
        handleOpenFullPreviewOnly();
        return;
      }
      setSplitMode((prev) => {
        const resolved = prev === nextMode ? "none" : nextMode;
        if (resolved === "editor" && !secondaryTabId) {
          const other = tabs.find((t) => t.id !== effectiveActiveTabId) ?? tabs[0];
          if (other) setSecondaryTabId(other.id);
        }
        return resolved;
      });
    },
    [
      handleToggleSideBySidePreview,
      handleOpenFullPreviewOnly,
      secondaryTabId,
      tabs,
      effectiveActiveTabId,
    ]
  );

  // Drag resize handlers (sidebar & split pane)
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const mode = draggingResizeRef.current;
      if (!mode) return;
      if (mode === "sidebar") {
        setSidebarWidth(Math.max(200, Math.min(480, e.clientX - 44)));
      } else if (mode === "split" && workspaceSplitRef.current) {
        const rect = workspaceSplitRef.current.getBoundingClientRect();
        const rightWidth = rect.right - e.clientX;
        const ratio = Math.max(0.22, Math.min(0.75, rightWidth / Math.max(1, rect.width)));
        setSplitRatio(ratio);
      }
    };

    const onMouseUp = () => {
      draggingResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      if ((mod && e.shiftKey && e.key.toLowerCase() === "p") || e.key === "F1") {
        e.preventDefault();
        setPaletteMode("commands");
        setPaletteOpen(true);
        return;
      }
      if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        handleToggleAlwaysOpenInPreview();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteMode("files");
        setPaletteOpen(true);
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setPaletteMode("goto");
        setPaletteOpen(true);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSidebarOpen(true);
        setSidebarView("search");
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void handleOpenFileDialog();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveActiveFile();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewTab();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "w") {
        if (activeTab && !activeTab.isPinned) {
          e.preventDefault();
          handleCloseTab(activeTab.id);
        }
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        handleChangeSplitMode("editor");
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        handleToggleSideBySidePreview();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleChangeSplitMode("diff");
        return;
      }
      if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        void handleFormatDocument(false);
        return;
      }
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setSettings((s) => ({ ...s, fontSize: Math.min(24, s.fontSize + 1) }));
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        setSettings((s) => ({ ...s, fontSize: Math.max(10, s.fontSize - 1) }));
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeTab,
    handleChangeSplitMode,
    handleCloseTab,
    handleFormatDocument,
    handleNewTab,
    handleOpenFileDialog,
    handleSaveActiveFile,
    handleToggleAlwaysOpenInPreview,
    handleToggleSideBySidePreview,
  ]);

  // Drag & drop local files onto editor window
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingFile(false);
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        try {
          if (isPdfPath(file.name)) {
            const buffer = await file.arrayBuffer();
            const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
            const newTab: EditorTab = {
              id: makeTabId(),
              title: file.name,
              path: null,
              content: "",
              savedContent: "",
              language: "pdf",
              encoding: "UTF-8",
              lineEnding: "LF",
              isDirty: false,
              isPinned: false,
              cursorLine: 1,
              cursorCol: 1,
              cursorCount: 1,
              selectionLength: 0,
              isBinary: true,
              binaryBase64: base64,
              sizeBytes: file.size,
            };
            setTabs((prev) => [...prev, newTab]);
            setActiveTabId(newTab.id);
            showToast("Opened PDF", file.name, "success");
            continue;
          }
          const text = await file.text();
          const newTab: EditorTab = {
            id: makeTabId(),
            title: file.name,
            path: null,
            content: text,
            savedContent: text,
            language: detectLanguageFromPath(file.name),
            encoding: "UTF-8",
            lineEnding: text.includes("\r\n") ? "CRLF" : "LF",
            isDirty: false,
            isPinned: false,
            cursorLine: 1,
            cursorCol: 1,
            cursorCount: 1,
            selectionLength: 0,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
          showToast("Opened dropped file", file.name, "success");
        } catch {
          showToast("Could not read dropped file", file.name, "error");
        }
      }
    },
    [showToast]
  );

  const quickOpenFiles = useMemo(() => {
    const openPaths = new Set(
      tabs.map((t) => t.path).filter((p): p is string => Boolean(p))
    );
    return flattenTreeFiles(tree, workspaceRoot, openPaths);
  }, [tree, workspaceRoot, tabs]);

  // Command Palette registry
  const commands = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [
      // File
      {
        id: "file.new",
        label: "New File",
        category: "File",
        shortcut: "Ctrl+N",
        run: handleNewTab,
      },
      {
        id: "file.open",
        label: "Open File...",
        category: "File",
        run: () => void handleOpenFileDialog(),
      },
      {
        id: "file.openFolder",
        label: "Open Folder...",
        category: "File",
        run: () => void handleOpenFolderDialog(),
      },
      {
        id: "file.save",
        label: "Save File",
        category: "File",
        shortcut: "Ctrl+S",
        run: () => void handleSaveActiveFile(),
      },
      // Preview & View
      {
        id: "view.previewSideBySide",
        label: "Toggle: Preview & Markup Side-by-Side",
        category: "Preview",
        shortcut: "Ctrl+Shift+V",
        keywords: ["split", "preview", "markup", "formatted", "pretty"],
        run: handleToggleSideBySidePreview,
      },
      {
        id: "view.alwaysOpenInPreview",
        label: "Toggle: Always Open in Preview",
        category: "Preview",
        shortcut: "Ctrl+Alt+P",
        description: settings.alwaysOpenInPreview ? "Currently ON" : "Currently OFF",
        keywords: ["auto", "preview", "default"],
        run: handleToggleAlwaysOpenInPreview,
      },
      {
        id: "view.fullPreviewOnly",
        label: "Open Full Preview Only",
        category: "Preview",
        keywords: ["preview", "reader", "formatted"],
        run: handleOpenFullPreviewOnly,
      },
      {
        id: "view.sidebar",
        label: "Toggle Sidebar",
        category: "View",
        shortcut: "Ctrl+B",
        run: () => setSidebarOpen((v) => !v),
      },
      {
        id: "view.diff",
        label: "Toggle Side-by-Side Diff Viewer",
        category: "View",
        shortcut: "Ctrl+Shift+D",
        run: () => handleChangeSplitMode("diff"),
      },
      {
        id: "view.splitEditor",
        label: "Toggle Split Editor",
        category: "View",
        shortcut: "Ctrl+\\",
        run: () => handleChangeSplitMode("editor"),
      },
      {
        id: "view.minimap",
        label: "Toggle Minimap",
        category: "View",
        run: () => setSettings((s) => ({ ...s, showMinimap: !s.showMinimap })),
      },
      {
        id: "view.wordWrap",
        label: "Toggle Word Wrap",
        category: "View",
        run: () => setSettings((s) => ({ ...s, wordWrap: !s.wordWrap })),
      },
      {
        id: "view.find",
        label: "Find in File",
        category: "Search",
        shortcut: "Ctrl+F",
        run: () => editorRef.current?.openFind(false),
      },
      {
        id: "view.replace",
        label: "Find and Replace",
        category: "Search",
        shortcut: "Ctrl+H",
        run: () => editorRef.current?.openFind(true),
      },
      {
        id: "view.searchWorkspace",
        label: "Search Across Workspace",
        category: "Search",
        shortcut: "Ctrl+Shift+F",
        run: () => {
          setSidebarOpen(true);
          setSidebarView("search");
        },
      },
      // Multi-Cursor
      {
        id: "cursor.nextOccurrence",
        label: "Select Next Occurrence",
        category: "Multi-Cursor",
        shortcut: "Ctrl+D",
        run: () => editorRef.current?.selectNextOccurrence(),
      },
      {
        id: "cursor.allOccurrences",
        label: "Select All Occurrences",
        category: "Multi-Cursor",
        run: () => editorRef.current?.selectAllOccurrences(),
      },
      {
        id: "cursor.splitLines",
        label: "Split Selection into Lines",
        category: "Multi-Cursor",
        shortcut: "Ctrl+Shift+L",
        run: () => editorRef.current?.splitSelectionIntoLines(),
      },
      {
        id: "cursor.above",
        label: "Add Cursor Above",
        category: "Multi-Cursor",
        shortcut: "Ctrl+Alt+Up",
        run: () => editorRef.current?.addCursorAbove(),
      },
      {
        id: "cursor.below",
        label: "Add Cursor Below",
        category: "Multi-Cursor",
        shortcut: "Ctrl+Alt+Down",
        run: () => editorRef.current?.addCursorBelow(),
      },
      // Format & Convert
      {
        id: "format.pretty",
        label: "Format / Pretty-Print Document",
        category: "Format",
        shortcut: "Shift+Alt+F",
        run: () => void handleFormatDocument(false),
      },
      {
        id: "format.minify",
        label: "Minify Document",
        category: "Format",
        run: () => void handleFormatDocument(true),
      },
      {
        id: "format.toJson",
        label: "Convert Document to JSON",
        category: "Convert",
        run: () => void handleConvertFormat("json"),
      },
      {
        id: "format.toYaml",
        label: "Convert Document to YAML",
        category: "Convert",
        run: () => void handleConvertFormat("yaml"),
      },
      {
        id: "format.toToml",
        label: "Convert Document to TOML",
        category: "Convert",
        run: () => void handleConvertFormat("toml"),
      },
      {
        id: "format.toCsv",
        label: "Convert Document to CSV",
        category: "Convert",
        run: () => void handleConvertFormat("csv"),
      },
      {
        id: "format.jsonSortKeys",
        label: "JSON: Sort Keys Alphabetically",
        category: "Format",
        run: () => void handleRunTransform("json_sort_keys"),
      },
      // Notepad++ Line Operations
      {
        id: "lines.sortAsc",
        label: "Sort Lines Ascending (A → Z)",
        category: "Lines",
        run: () => void handleRunTransform("sort_asc"),
      },
      {
        id: "lines.sortDesc",
        label: "Sort Lines Descending (Z → A)",
        category: "Lines",
        run: () => void handleRunTransform("sort_desc"),
      },
      {
        id: "lines.sortCi",
        label: "Sort Lines Case-Insensitive",
        category: "Lines",
        run: () => void handleRunTransform("sort_ci_asc"),
      },
      {
        id: "lines.sortNumAsc",
        label: "Sort Lines Numerically (Ascending)",
        category: "Lines",
        run: () => void handleRunTransform("sort_numeric_asc"),
      },
      {
        id: "lines.sortNumDesc",
        label: "Sort Lines Numerically (Descending)",
        category: "Lines",
        run: () => void handleRunTransform("sort_numeric_desc"),
      },
      {
        id: "lines.sortLength",
        label: "Sort Lines by Length",
        category: "Lines",
        run: () => void handleRunTransform("sort_length_asc"),
      },
      {
        id: "lines.dedupe",
        label: "Remove Duplicate Lines (Dedupe)",
        category: "Lines",
        run: () => void handleRunTransform("dedupe_lines"),
      },
      {
        id: "lines.removeEmpty",
        label: "Remove Empty Lines",
        category: "Lines",
        run: () => void handleRunTransform("remove_empty_lines"),
      },
      {
        id: "lines.removeBlank",
        label: "Remove Blank / Whitespace-Only Lines",
        category: "Lines",
        run: () => void handleRunTransform("remove_blank_lines"),
      },
      {
        id: "lines.trimTrailing",
        label: "Trim Trailing Whitespace",
        category: "Lines",
        run: () => void handleRunTransform("trim_trailing"),
      },
      {
        id: "lines.trimLeading",
        label: "Trim Leading Whitespace",
        category: "Lines",
        run: () => void handleRunTransform("trim_leading"),
      },
      {
        id: "lines.trimBoth",
        label: "Trim Leading & Trailing Whitespace",
        category: "Lines",
        run: () => void handleRunTransform("trim_both"),
      },
      {
        id: "lines.reverse",
        label: "Reverse Line Order",
        category: "Lines",
        run: () => void handleRunTransform("reverse_lines"),
      },
      {
        id: "lines.join",
        label: "Join Lines",
        category: "Lines",
        run: () => void handleRunTransform("join_lines"),
      },
      {
        id: "lines.number",
        label: "Number Lines (1. 2. 3.)",
        category: "Lines",
        run: () => void handleRunTransform("number_lines"),
      },
      // Case Transforms
      {
        id: "case.upper",
        label: "Convert to UPPERCASE",
        category: "Case",
        run: () => void handleRunTransform("upper"),
      },
      {
        id: "case.lower",
        label: "Convert to lowercase",
        category: "Case",
        run: () => void handleRunTransform("lower"),
      },
      {
        id: "case.title",
        label: "Convert to Title Case",
        category: "Case",
        run: () => void handleRunTransform("title"),
      },
      {
        id: "case.camel",
        label: "Convert to camelCase",
        category: "Case",
        run: () => void handleRunTransform("camel"),
      },
      {
        id: "case.pascal",
        label: "Convert to PascalCase",
        category: "Case",
        run: () => void handleRunTransform("pascal"),
      },
      {
        id: "case.snake",
        label: "Convert to snake_case",
        category: "Case",
        run: () => void handleRunTransform("snake"),
      },
      {
        id: "case.kebab",
        label: "Convert to kebab-case",
        category: "Case",
        run: () => void handleRunTransform("kebab"),
      },
      {
        id: "case.screaming",
        label: "Convert to SCREAMING_SNAKE_CASE",
        category: "Case",
        run: () => void handleRunTransform("screaming_snake"),
      },
      {
        id: "case.invert",
        label: "Invert Case",
        category: "Case",
        run: () => void handleRunTransform("invert_case"),
      },
      // Encode / Crypto / Dev Utilities
      {
        id: "encode.b64enc",
        label: "Base64 Encode",
        category: "Encode",
        run: () => void handleRunTransform("base64_encode"),
      },
      {
        id: "encode.b64dec",
        label: "Base64 Decode",
        category: "Encode",
        run: () => void handleRunTransform("base64_decode"),
      },
      {
        id: "encode.urlenc",
        label: "URL Percent-Encode",
        category: "Encode",
        run: () => void handleRunTransform("url_encode"),
      },
      {
        id: "encode.urldec",
        label: "URL Percent-Decode",
        category: "Encode",
        run: () => void handleRunTransform("url_decode"),
      },
      {
        id: "encode.htmlenc",
        label: "HTML Entity Encode",
        category: "Encode",
        run: () => void handleRunTransform("html_encode"),
      },
      {
        id: "encode.htmldec",
        label: "HTML Entity Decode",
        category: "Encode",
        run: () => void handleRunTransform("html_decode"),
      },
      {
        id: "encode.hexenc",
        label: "Hex Encode",
        category: "Encode",
        run: () => void handleRunTransform("hex_encode"),
      },
      {
        id: "encode.hexdec",
        label: "Hex Decode",
        category: "Encode",
        run: () => void handleRunTransform("hex_decode"),
      },
      {
        id: "encode.jwt",
        label: "JWT Decode (Header + Payload JSON)",
        category: "Crypto",
        run: () => void handleRunTransform("jwt_decode"),
      },
      {
        id: "hash.md5",
        label: "Hash: MD5",
        category: "Crypto",
        run: () => void handleRunTransform("hash_md5"),
      },
      {
        id: "hash.sha1",
        label: "Hash: SHA-1",
        category: "Crypto",
        run: () => void handleRunTransform("hash_sha1"),
      },
      {
        id: "hash.sha256",
        label: "Hash: SHA-256",
        category: "Crypto",
        run: () => void handleRunTransform("hash_sha256"),
      },
      {
        id: "hash.sha512",
        label: "Hash: SHA-512",
        category: "Crypto",
        run: () => void handleRunTransform("hash_sha512"),
      },
      {
        id: "gen.uuid",
        label: "Insert UUID v4",
        category: "Generate",
        run: () => void handleRunTransform("gen_uuid"),
      },
      {
        id: "time.epochToIso",
        label: "Unix Epoch Timestamp → ISO-8601",
        category: "Generate",
        run: () => void handleRunTransform("timestamp_to_iso"),
      },
      {
        id: "time.isoToEpoch",
        label: "ISO-8601 Date → Unix Epoch Timestamp",
        category: "Generate",
        run: () => void handleRunTransform("iso_to_timestamp"),
      },
    ];

    for (const t of THEME_OPTIONS) {
      list.push({
        id: `theme.${t.id}`,
        label: `Theme: ${t.label}`,
        category: "Theme",
        run: () => {
          setSettings((s) => ({ ...s, theme: t.id }));
          showToast("Theme changed", t.label, "info");
        },
      });
    }

    return list;
  }, [
    handleChangeSplitMode,
    handleConvertFormat,
    handleFormatDocument,
    handleNewTab,
    handleOpenFileDialog,
    handleOpenFolderDialog,
    handleOpenFullPreviewOnly,
    handleRunTransform,
    handleSaveActiveFile,
    handleToggleAlwaysOpenInPreview,
    handleToggleSideBySidePreview,
    settings.alwaysOpenInPreview,
    showToast,
  ]);

  const secondaryTab = useMemo(() => {
    const found = tabs.find((t) => t.id === secondaryTabId);
    if (found) return found;
    return tabs.find((t) => t.id !== effectiveActiveTabId) ?? activeTab;
  }, [tabs, secondaryTabId, effectiveActiveTabId, activeTab]);

  const totalLines = useMemo(
    () => (activeTab ? activeTab.content.split("\n").length : 1),
    [activeTab]
  );

  return (
    <div
      className="kunai-app"
      onDragOver={(e) => {
        e.preventDefault();
        if (!isDraggingFile) setIsDraggingFile(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDraggingFile(false);
      }}
      onDrop={handleDrop}
    >
      <TitleBar
        workspaceName={workspaceName}
        activeTab={activeTab}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        splitMode={splitMode}
        onChangeSplitMode={handleChangeSplitMode}
        alwaysOpenInPreview={settings.alwaysOpenInPreview}
        onToggleAlwaysOpenInPreview={handleToggleAlwaysOpenInPreview}
        canPreviewActive={activePreviewSecurity.allowed}
        previewBlockedReason={activePreviewSecurity.reason}
        theme={settings.theme}
        onChangeTheme={(theme: ThemeId) => setSettings((s) => ({ ...s, theme }))}
        onOpenCommandPalette={() => {
          setPaletteMode("commands");
          setPaletteOpen(true);
        }}
        onOpenQuickOpen={() => {
          setPaletteMode("files");
          setPaletteOpen(true);
        }}
        onOpenFile={() => void handleOpenFileDialog()}
        onOpenFolder={() => void handleOpenFolderDialog()}
        onSaveFile={() => void handleSaveActiveFile()}
        isTauri={inTauri}
      />

      <div className="kunai-main">
        <Sidebar
          isOpen={sidebarOpen}
          activeView={sidebarView}
          onSelectView={(v) => {
            if (sidebarOpen && v === sidebarView) {
              setSidebarOpen(false);
            } else {
              setSidebarOpen(true);
              setSidebarView(v);
            }
          }}
          width={sidebarWidth}
          workspaceName={workspaceName}
          workspaceRoot={workspaceRoot}
          tree={tree}
          activeFilePath={activeTab?.path ?? null}
          onOpenFile={(p) => void handleOpenFileByPath(p)}
          onOpenFolder={() => void handleOpenFolderDialog()}
          onRefreshTree={() => void refreshTree()}
          onNewFile={(p) => void handleNewFileInTree(p)}
          onNewFolder={(p) => void handleNewFolderInTree(p)}
          onDeleteEntry={(p) => void handleDeleteEntry(p)}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          searchResults={searchResults}
          isSearching={isSearching}
          onRunSearch={(q, opts) => void handleRunSearch(q, opts)}
          onJumpToMatch={(m) => void handleJumpToMatch(m)}
          activeTab={activeTab}
          onJumpToLine={(ln) => {
            if (splitMode === "preview-only") {
              setSplitMode("preview");
              requestAnimationFrame(() => editorRef.current?.jumpToLine(ln, 1));
            } else {
              editorRef.current?.jumpToLine(ln, 1);
            }
          }}
          onRunTransform={(op, arg) => void handleRunTransform(op, arg)}
          onFormatDocument={(minify) => void handleFormatDocument(minify)}
          onConvertFormat={(fmt) => void handleConvertFormat(fmt)}
          selectionInfo={cursorInfo}
          docStats={docStats}
        />

        {sidebarOpen && (
          <div
            className="kunai-resize-handle"
            onMouseDown={() => {
              draggingResizeRef.current = "sidebar";
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
          />
        )}

        <div className="kunai-workbench">
          <TabBar
            tabs={tabs}
            activeTabId={effectiveActiveTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={handleCloseTab}
            onPinTab={handlePinTab}
            onNewTab={handleNewTab}
            onFormatActive={() => void handleFormatDocument(false)}
            onTogglePreview={handleToggleSideBySidePreview}
            splitMode={splitMode}
            alwaysOpenInPreview={settings.alwaysOpenInPreview}
            onToggleAlwaysOpenInPreview={handleToggleAlwaysOpenInPreview}
            canPreviewActive={activePreviewSecurity.allowed}
            previewBlockedReason={activePreviewSecurity.reason}
          />

          <div ref={workspaceSplitRef} className="kunai-workspace-split">
            {splitMode === "preview-only" && activeTab && activePreviewSecurity.allowed ? (
              <div className="kunai-full-preview-pane">
                <FormatPreview
                  mode="preview"
                  isFullPreview
                  tab={activeTab}
                  allTabs={tabs}
                  onToggleSideBySide={handlePreviewHeaderToggleSideBySide}
                  onFormatDocument={formatDocument}
                  tabSize={settings.tabSize}
                  useTabs={settings.useTabs}
                  onConvertFormat={(fmt) => void handleConvertFormat(fmt)}
                  onQueryJson={queryJson}
                  onComputeDiff={computeDiff}
                  onClose={() => setSplitMode("none")}
                  onCopyText={handleCopyText}
                  onJumpToLine={(ln) => {
                    setSplitMode("preview");
                    requestAnimationFrame(() =>
                      editorRef.current?.jumpToLine(ln, 1)
                    );
                  }}
                />
              </div>
            ) : (
              <>
                <div className="kunai-primary-pane">
                  {activeTab ? (
                    activeTab.language === "pdf" && activeTab.binaryBase64 ? (
                      <PdfViewer
                        title={activeTab.title}
                        base64Data={activeTab.binaryBase64}
                        sizeBytes={activeTab.sizeBytes}
                        onExtractTextToTab={handleExtractPdfTextToTab}
                        onCopyText={handleCopyText}
                      />
                    ) : (
                      <EditorPane
                        ref={editorRef}
                        tabId={activeTab.id}
                        content={activeTab.content}
                        language={activeTab.language}
                        settings={settings}
                        onChange={(val) => handleContentChange(activeTab.id, val)}
                        onCursorChange={handleCursorChange}
                        onValidate={validateDocument}
                        onRequestFormat={() => void handleFormatDocument(false)}
                      />
                    )
                  ) : (
                    <div className="kunai-empty-state">
                      <div className="kunai-empty-title">Kunai</div>
                      <div>Open a file or create a new buffer to start editing.</div>
                      <div className="kunai-empty-shortcuts">
                        <span>Command Palette</span>
                        <kbd className="kunai-kbd">Ctrl+Shift+P</kbd>
                        <span>Quick Open File</span>
                        <kbd className="kunai-kbd">Ctrl+P</kbd>
                        <span>Always Open in Preview</span>
                        <kbd className="kunai-kbd">Ctrl+Alt+P</kbd>
                        <span>Preview &amp; Markup Side-by-Side</span>
                        <kbd className="kunai-kbd">Ctrl+Shift+V</kbd>
                      </div>
                    </div>
                  )}
                </div>

                {splitMode !== "none" &&
                  splitMode !== "preview-only" &&
                  activeTab && (
                    <>
                      <div
                        className="kunai-resize-handle"
                        onMouseDown={() => {
                          draggingResizeRef.current = "split";
                          document.body.style.cursor = "col-resize";
                          document.body.style.userSelect = "none";
                        }}
                      />
                      <div
                        className="kunai-secondary-pane"
                        style={{ width: `${Math.round(splitRatio * 100)}%` }}
                      >
                        {splitMode === "editor" && secondaryTab ? (
                          <>
                            <div className="kunai-secondary-header">
                              <select
                                className="kunai-secondary-select"
                                value={secondaryTab.id}
                                onChange={(e) => setSecondaryTabId(e.target.value)}
                                aria-label="Secondary editor file"
                              >
                                {tabs.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.title}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="kunai-icon-btn sm"
                                onClick={() => setSplitMode("none")}
                                title="Close Split Editor"
                              >
                                <X size={14} />
                              </button>
                            </div>
                            {secondaryTab.language === "pdf" && secondaryTab.binaryBase64 ? (
                              <PdfViewer
                                title={secondaryTab.title}
                                base64Data={secondaryTab.binaryBase64}
                                sizeBytes={secondaryTab.sizeBytes}
                                onExtractTextToTab={handleExtractPdfTextToTab}
                                onCopyText={handleCopyText}
                              />
                            ) : (
                              <EditorPane
                                tabId={`split-${secondaryTab.id}`}
                                content={secondaryTab.content}
                                language={secondaryTab.language}
                                settings={settings}
                                onChange={(val) =>
                                  handleContentChange(secondaryTab.id, val)
                                }
                                onCursorChange={() => {}}
                                onValidate={validateDocument}
                                onRequestFormat={() => void handleFormatDocument(false)}
                              />
                            )}
                          </>
                        ) : (
                          <FormatPreview
                            mode={splitMode === "diff" ? "diff" : "preview"}
                            isFullPreview={false}
                            tab={activeTab}
                            allTabs={tabs}
                            onToggleSideBySide={handlePreviewHeaderToggleSideBySide}
                            onFormatDocument={formatDocument}
                            tabSize={settings.tabSize}
                            useTabs={settings.useTabs}
                            onConvertFormat={(fmt) => void handleConvertFormat(fmt)}
                            onQueryJson={queryJson}
                            onComputeDiff={computeDiff}
                            onClose={() => setSplitMode("none")}
                            onCopyText={handleCopyText}
                            onJumpToLine={(ln) => editorRef.current?.jumpToLine(ln, 1)}
                          />
                        )}
                      </div>
                    </>
                  )}
              </>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        tab={activeTab}
        cursor={cursorInfo}
        docStats={docStats}
        settings={settings}
        alwaysOpenInPreview={settings.alwaysOpenInPreview}
        onToggleAlwaysOpenInPreview={handleToggleAlwaysOpenInPreview}
        canPreviewActive={activePreviewSecurity.allowed}
        previewBlockedReason={activePreviewSecurity.reason}
        onOpenGotoLine={() => {
          setPaletteMode("goto");
          setPaletteOpen(true);
        }}
        onChangeLanguage={(lang) => {
          if (activeTab) {
            updateTab(activeTab.id, (t) => ({ ...t, language: lang }));
          }
        }}
        onChangeEncoding={(encoding) => {
          if (activeTab) {
            updateTab(activeTab.id, (t) => ({ ...t, encoding, isDirty: true }));
          }
        }}
        onChangeLineEnding={(lineEnding) => {
          if (activeTab) {
            updateTab(activeTab.id, (t) => ({ ...t, lineEnding, isDirty: true }));
          }
        }}
        onToggleIndentMode={() =>
          setSettings((s) => ({ ...s, useTabs: !s.useTabs }))
        }
        onChangeTabSize={(tabSize) =>
          setSettings((s) => ({ ...s, tabSize }))
        }
        onToggleWordWrap={() =>
          setSettings((s) => ({ ...s, wordWrap: !s.wordWrap }))
        }
        onToggleMinimap={() =>
          setSettings((s) => ({ ...s, showMinimap: !s.showMinimap }))
        }
        onChangeTheme={(theme) => setSettings((s) => ({ ...s, theme }))}
        onValidateClick={() => {
          if (
            activeTab?.validation &&
            !activeTab.validation.valid &&
            activeTab.validation.line
          ) {
            if (splitMode === "preview-only") setSplitMode("preview");
            const ln = activeTab.validation.line;
            const col = activeTab.validation.column ?? 1;
            requestAnimationFrame(() => editorRef.current?.jumpToLine(ln, col));
          }
        }}
      />

      <CommandPalette
        isOpen={paletteOpen}
        mode={paletteMode}
        onClose={() => {
          setPaletteOpen(false);
          editorRef.current?.focus();
        }}
        onSwitchMode={setPaletteMode}
        commands={commands}
        files={quickOpenFiles}
        onOpenFile={(path) => {
          setPaletteOpen(false);
          void handleOpenFileByPath(path);
        }}
        onJumpToLine={(line, col) => {
          setPaletteOpen(false);
          if (splitMode === "preview-only") {
            setSplitMode("preview");
            requestAnimationFrame(() =>
              editorRef.current?.jumpToLine(line, col ?? 1)
            );
          } else {
            editorRef.current?.jumpToLine(line, col ?? 1);
          }
        }}
        totalLines={totalLines}
        currentLine={cursorInfo.line}
      />

      {isDraggingFile && (
        <div className="kunai-drop-overlay">
          <div className="kunai-drop-card">Drop files to open in Kunai</div>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="kunai-toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`kunai-toast ${toast.kind}`}>
              <div className="kunai-toast-title">{toast.title}</div>
              {toast.detail && (
                <div className="kunai-toast-detail">{toast.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

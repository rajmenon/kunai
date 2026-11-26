// ============================================================================
// Kunai — Shared Types (Tauri IPC Contracts + Editor Domain + Component Props)
// ============================================================================

// --- Tauri IPC Types (exact snake_case matching Rust structs) ---

export interface FilePayload {
  path: string;
  name: string;
  content: string;
  encoding: string;
  line_ending: string;
  size_bytes: number;
  modified_ms: number;
}

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  extension: string | null;
  children?: TreeNode[];
}

export interface SearchMatch {
  path: string;
  line_number: number;
  column: number;
  line_text: string;
  match_text: string;
}

export interface FormatResult {
  ok: boolean;
  output: string;
  error: string | null;
  error_line: number | null;
  error_col: number | null;
}

export interface ValidationResult {
  valid: boolean;
  error: string | null;
  line: number | null;
  column: number | null;
}

export interface TransformResult {
  ok: boolean;
  output: string;
  error: string | null;
  stats: string | null;
}

export interface DiffLine {
  kind: "equal" | "insert" | "delete";
  left_line: number | null;
  right_line: number | null;
  text: string;
}

export interface DiffResult {
  hunks: DiffLine[];
  additions: number;
  deletions: number;
}

export interface DocStats {
  bytes: number;
  chars: number;
  words: number;
  lines: number;
  non_empty_lines: number;
  reading_time_sec: number;
}

// --- Editor Domain Types ---

export type LanguageId =
  | "typescript"
  | "javascript"
  | "rust"
  | "python"
  | "json"
  | "yaml"
  | "toml"
  | "xml"
  | "html"
  | "css"
  | "sql"
  | "markdown"
  | "csv"
  | "cpp"
  | "java"
  | "go"
  | "php"
  | "shell"
  | "plaintext";

export type ThemeId =
  | "zed-dark"
  | "sublime-mariana"
  | "tokyo-night"
  | "catppuccin-latte";

export type LineEnding = "LF" | "CRLF" | "CR";

export type EncodingName =
  | "UTF-8"
  | "UTF-8-BOM"
  | "UTF-16LE"
  | "UTF-16BE"
  | "Windows-1252";

export type SidebarView = "explorer" | "search" | "outline" | "utilities";

export type SplitMode = "none" | "editor" | "preview" | "preview-only" | "diff";

export type PaletteMode = "commands" | "files" | "goto";

export interface EditorTab {
  id: string;
  title: string;
  path: string | null;
  content: string;
  savedContent: string;
  language: LanguageId;
  encoding: EncodingName;
  lineEnding: LineEnding;
  isDirty: boolean;
  isPinned: boolean;
  cursorLine: number;
  cursorCol: number;
  cursorCount: number;
  selectionLength: number;
  validation?: ValidationResult;
}

export interface CursorInfo {
  line: number;
  col: number;
  cursorCount: number;
  selectionLength: number;
  selectionLines: number;
  selectedText: string;
}

export interface CommandItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  description?: string;
  keywords?: string[];
  run: () => void;
}

export interface EditorSettings {
  theme: ThemeId;
  fontSize: number;
  tabSize: number;
  useTabs: boolean;
  wordWrap: boolean;
  showMinimap: boolean;
  showLineNumbers: boolean;
  alwaysOpenInPreview: boolean;
}

export interface ToastMessage {
  id: string;
  kind: "info" | "success" | "error" | "warning";
  title: string;
  detail?: string;
}

export interface QuickOpenFileItem {
  path: string;
  name: string;
  relativePath: string;
  extension: string | null;
  isOpen?: boolean;
}

export interface EditorHandle {
  applyTransformToSelectionOrDoc: (
    transform: (input: string) => Promise<TransformResult> | TransformResult
  ) => Promise<TransformResult | null>;
  insertText: (text: string) => void;
  jumpToLine: (line: number, col?: number) => void;
  openFind: (withReplace?: boolean) => void;
  addCursorAbove: () => void;
  addCursorBelow: () => void;
  splitSelectionIntoLines: () => void;
  selectAllOccurrences: () => void;
  selectNextOccurrence: () => void;
  formatCurrentDoc: () => void;
  focus: () => void;
}

// --- Component Prop Contracts (shared with frontend-tools) ---

export interface CommandPaletteProps {
  isOpen: boolean;
  mode: PaletteMode;
  onClose: () => void;
  onSwitchMode?: (mode: PaletteMode) => void;
  commands: CommandItem[];
  files: QuickOpenFileItem[];
  onOpenFile: (path: string) => void;
  onJumpToLine: (line: number, col?: number) => void;
  totalLines: number;
  currentLine: number;
}

export interface QuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  files: QuickOpenFileItem[];
  onOpenFile: (path: string) => void;
}

export interface SidebarProps {
  isOpen: boolean;
  activeView: SidebarView;
  onSelectView: (view: SidebarView) => void;
  width: number;
  workspaceName: string;
  workspaceRoot: string | null;
  tree: TreeNode[];
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onRefreshTree: () => void;
  onNewFile: (parentPath?: string) => void;
  onNewFolder?: (parentPath?: string) => void;
  onDeleteEntry?: (path: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchResults: SearchMatch[];
  isSearching: boolean;
  onRunSearch: (
    query: string,
    opts: { isRegex: boolean; caseSensitive: boolean; wholeWord: boolean }
  ) => void;
  onJumpToMatch: (match: SearchMatch) => void;
  activeTab: EditorTab | null;
  onJumpToLine: (line: number) => void;
  onRunTransform: (op: string, arg?: string) => void;
  onFormatDocument: (minify?: boolean) => void;
  onConvertFormat: (toFormat: "json" | "yaml" | "toml" | "csv") => void;
  selectionInfo: CursorInfo;
  docStats: DocStats | null;
}

export interface FormatPreviewProps {
  mode: "preview" | "diff";
  tab: EditorTab;
  allTabs: EditorTab[];
  isFullPreview?: boolean;
  onToggleSideBySide: () => void;
  onFormatDocument: (
    content: string,
    format: string,
    indent: number,
    useTabs: boolean,
    minify: boolean
  ) => Promise<FormatResult>;
  tabSize: number;
  useTabs: boolean;
  onConvertFormat: (toFormat: "json" | "yaml" | "toml" | "csv") => void;
  onQueryJson: (content: string, path: string) => Promise<FormatResult>;
  onComputeDiff: (left: string, right: string) => Promise<DiffResult>;
  onClose: () => void;
  onCopyText: (text: string, label?: string) => void;
  onJumpToLine?: (line: number) => void;
}

export interface TitleBarProps {
  workspaceName: string;
  activeTab: EditorTab | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  splitMode: SplitMode;
  onChangeSplitMode: (mode: SplitMode) => void;
  alwaysOpenInPreview: boolean;
  onToggleAlwaysOpenInPreview: () => void;
  canPreviewActive: boolean;
  previewBlockedReason?: string;
  theme: ThemeId;
  onChangeTheme: (theme: ThemeId) => void;
  onOpenCommandPalette: () => void;
  onOpenQuickOpen: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onSaveFile: () => void;
  isTauri: boolean;
}

export interface TabBarProps {
  tabs: EditorTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onPinTab: (id: string) => void;
  onNewTab: () => void;
  onFormatActive: () => void;
  onTogglePreview: () => void;
  splitMode: SplitMode;
  alwaysOpenInPreview: boolean;
  onToggleAlwaysOpenInPreview: () => void;
  canPreviewActive: boolean;
  previewBlockedReason?: string;
}

export interface StatusBarProps {
  tab: EditorTab | null;
  cursor: CursorInfo;
  docStats: DocStats | null;
  settings: EditorSettings;
  alwaysOpenInPreview: boolean;
  onToggleAlwaysOpenInPreview: () => void;
  canPreviewActive: boolean;
  previewBlockedReason?: string;
  onOpenGotoLine: () => void;
  onChangeLanguage: (lang: LanguageId) => void;
  onChangeEncoding: (enc: EncodingName) => void;
  onChangeLineEnding: (eol: LineEnding) => void;
  onToggleIndentMode: () => void;
  onChangeTabSize: (size: number) => void;
  onToggleWordWrap: () => void;
  onToggleMinimap: () => void;
  onChangeTheme: (theme: ThemeId) => void;
  onValidateClick?: () => void;
}

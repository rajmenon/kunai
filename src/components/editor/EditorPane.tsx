import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  toggleComment,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  highlightSelectionMatches,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";

import type {
  CursorInfo,
  EditorHandle,
  EditorSettings,
  LanguageId,
  TransformResult,
  ValidationResult,
} from "../../types/editor";
import {
  createFormatLinter,
  getLanguageExtension,
  getThemeExtension,
} from "../../services/languages";
import { FindReplaceBar, type FindState } from "./FindReplaceBar";
import { Minimap } from "./Minimap";

// ============================================================================
// Custom Search Highlight Extension (drives FindReplaceBar match highlights)
// ============================================================================

interface MatchRange {
  from: number;
  to: number;
}

const setSearchHighlights = StateEffect.define<{
  matches: MatchRange[];
  activeIndex: number;
}>();

const searchHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlights)) {
        const builder = new RangeSetBuilder<Decoration>();
        const { matches, activeIndex } = effect.value;
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          if (m.from < m.to) {
            builder.add(
              m.from,
              m.to,
              Decoration.mark({
                class:
                  i === activeIndex
                    ? "cm-searchMatch cm-searchMatch-selected"
                    : "cm-searchMatch",
              })
            );
          }
        }
        return builder.finish();
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ============================================================================
// Custom Sublime/Zed Multi-Cursor Commands
// ============================================================================

function addCursorVertical(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view;
  const ranges = state.selection.ranges;
  const anchorRange = direction === -1 ? ranges[0] : ranges[ranges.length - 1];
  const currentLine = state.doc.lineAt(anchorRange.head);
  const targetLineNum = currentLine.number + direction;
  if (targetLineNum < 1 || targetLineNum > state.doc.lines) return false;

  const col = anchorRange.head - currentLine.from;
  const targetLine = state.doc.line(targetLineNum);
  const newPos = Math.min(targetLine.from + col, targetLine.to);

  const nextRanges: SelectionRange[] = [
    ...ranges,
    EditorSelection.cursor(newPos),
  ];
  view.dispatch({
    selection: EditorSelection.create(nextRanges, nextRanges.length - 1),
    scrollIntoView: true,
  });
  return true;
}

function splitSelectionIntoLinesCmd(view: EditorView): boolean {
  const { state } = view;
  const newRanges: SelectionRange[] = [];

  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endPos =
      range.to > range.from && state.doc.lineAt(range.to).from === range.to
        ? range.to - 1
        : range.to;
    const endLine = state.doc.lineAt(endPos).number;

    for (let ln = startLine; ln <= endLine; ln++) {
      const line = state.doc.line(ln);
      newRanges.push(EditorSelection.cursor(line.to));
    }
  }

  if (newRanges.length === 0) return false;
  view.dispatch({
    selection: EditorSelection.create(newRanges, newRanges.length - 1),
    scrollIntoView: true,
  });
  return true;
}

function computeMatchesInDoc(
  docText: string,
  find: FindState,
  selectionRange: { from: number; to: number } | null
): { matches: MatchRange[]; error: string | null } {
  if (!find.isOpen || !find.query) {
    return { matches: [], error: null };
  }

  const escaped = find.isRegex
    ? find.query
    : find.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = find.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
  const flags = find.caseSensitive ? "g" : "gi";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    return {
      matches: [],
      error: err instanceof Error ? err.message : "Invalid regex",
    };
  }

  const searchFrom =
    find.inSelection && selectionRange ? selectionRange.from : 0;
  const searchTo =
    find.inSelection && selectionRange ? selectionRange.to : docText.length;
  const slice = docText.slice(searchFrom, searchTo);

  const matches: MatchRange[] = [];
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = regex.exec(slice)) !== null && guard < 10000) {
    guard++;
    const from = searchFrom + match.index;
    const to = from + match[0].length;
    if (to > from) {
      matches.push({ from, to });
    } else {
      regex.lastIndex++;
    }
  }

  return { matches, error: null };
}

function readCursorInfo(state: EditorState): CursorInfo {
  const main = state.selection.main;
  const lineObj = state.doc.lineAt(main.head);
  let totalSelLen = 0;
  const lineSet = new Set<number>();

  for (const r of state.selection.ranges) {
    totalSelLen += r.to - r.from;
    if (r.to > r.from) {
      const startLn = state.doc.lineAt(r.from).number;
      const endLn = state.doc.lineAt(r.to).number;
      for (let ln = startLn; ln <= endLn; ln++) lineSet.add(ln);
    }
  }

  const selectedText = state.selection.ranges
    .filter((r) => r.to > r.from)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join("\n");

  return {
    line: lineObj.number,
    col: main.head - lineObj.from + 1,
    cursorCount: state.selection.ranges.length,
    selectionLength: totalSelLen,
    selectionLines: lineSet.size,
    selectedText,
  };
}

// ============================================================================
// EditorPane Component
// ============================================================================

export interface EditorPaneProps {
  tabId: string;
  content: string;
  language: LanguageId;
  settings: EditorSettings;
  onChange: (value: string) => void;
  onCursorChange: (info: CursorInfo) => void;
  onValidate: (content: string, format: string) => Promise<ValidationResult>;
  onRequestFormat: () => void;
  readOnly?: boolean;
}

export const EditorPane = forwardRef<EditorHandle, EditorPaneProps>(
  function EditorPane(
    {
      tabId,
      content,
      language,
      settings,
      onChange,
      onCursorChange,
      onValidate,
      onRequestFormat,
      readOnly = false,
    },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const tabStatesRef = useRef<Map<string, EditorState>>(new Map());
    const activeTabIdRef = useRef<string>(tabId);
    const suppressChangeRef = useRef(false);

    // Latest callback refs so CodeMirror extensions never capture stale closures
    const onChangeRef = useRef(onChange);
    const onCursorChangeRef = useRef(onCursorChange);
    const onValidateRef = useRef(onValidate);
    const onRequestFormatRef = useRef(onRequestFormat);
    onChangeRef.current = onChange;
    onCursorChangeRef.current = onCursorChange;
    onValidateRef.current = onValidate;
    onRequestFormatRef.current = onRequestFormat;

    // Compartments for zero-flicker live reconfig
    const compartments = useMemo(
      () => ({
        language: new Compartment(),
        theme: new Compartment(),
        wrap: new Compartment(),
        lineNumbers: new Compartment(),
        indent: new Compartment(),
        lint: new Compartment(),
        readOnly: new Compartment(),
      }),
      []
    );

    const [findState, setFindState] = useState<FindState>({
      isOpen: false,
      showReplace: false,
      query: "",
      replaceText: "",
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      inSelection: false,
    });
    const [activeMatchIndex, setActiveMatchIndex] = useState(0);
    const [selectionScope, setSelectionScope] = useState<{
      from: number;
      to: number;
    } | null>(null);

    const [scrollInfo, setScrollInfo] = useState({
      scrollRatio: 0,
      viewportRatio: 0.25,
    });

    const openFindInternal = useCallback((withReplace = false) => {
      const view = viewRef.current;
      let initialQuery: string | undefined;
      if (view) {
        const main = view.state.selection.main;
        if (main.to > main.from) {
          const sel = view.state.sliceDoc(main.from, main.to);
          if (!sel.includes("\n") && sel.length <= 120) {
            initialQuery = sel;
          } else {
            setSelectionScope({ from: main.from, to: main.to });
          }
        }
      }
      setFindState((prev) => ({
        ...prev,
        isOpen: true,
        showReplace: withReplace || prev.showReplace,
        query: initialQuery !== undefined ? initialQuery : prev.query,
      }));
    }, []);

    const buildBaseExtensions = useCallback(() => {
      const indentStr = settings.useTabs ? "\t" : " ".repeat(settings.tabSize);
      return [
        EditorState.allowMultipleSelections.of(true),
        EditorView.clickAddsSelectionRange.of((event) => event.altKey),
        rectangularSelection(),
        crosshairCursor(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        lintGutter(),
        searchHighlightField,
        compartments.lineNumbers.of(settings.showLineNumbers ? lineNumbers() : []),
        compartments.wrap.of(settings.wordWrap ? EditorView.lineWrapping : []),
        compartments.indent.of([
          EditorState.tabSize.of(settings.tabSize),
          indentUnit.of(indentStr),
        ]),
        compartments.readOnly.of(EditorState.readOnly.of(readOnly)),
        compartments.language.of(getLanguageExtension(language)),
        compartments.theme.of(getThemeExtension(settings.theme, settings.fontSize)),
        compartments.lint.of(
          createFormatLinter(language, (c, f) => onValidateRef.current(c, f))
        ),
        keymap.of([
          {
            key: "Mod-f",
            run: () => {
              openFindInternal(false);
              return true;
            },
          },
          {
            key: "Mod-h",
            run: () => {
              openFindInternal(true);
              return true;
            },
          },
          {
            key: "Mod-d",
            run: selectNextOccurrence,
          },
          {
            key: "Mod-Shift-l",
            run: splitSelectionIntoLinesCmd,
          },
          {
            key: "Ctrl-Alt-ArrowUp",
            run: (view) => addCursorVertical(view, -1),
          },
          {
            key: "Ctrl-Alt-ArrowDown",
            run: (view) => addCursorVertical(view, 1),
          },
          {
            key: "Alt-ArrowUp",
            run: moveLineUp,
          },
          {
            key: "Alt-ArrowDown",
            run: moveLineDown,
          },
          {
            key: "Shift-Alt-ArrowUp",
            run: copyLineUp,
          },
          {
            key: "Shift-Alt-ArrowDown",
            run: copyLineDown,
          },
          {
            key: "Mod-Shift-k",
            run: deleteLine,
          },
          {
            key: "Mod-/",
            run: toggleComment,
          },
          {
            key: "Mod-]",
            run: indentMore,
          },
          {
            key: "Mod-[",
            run: indentLess,
          },
          {
            key: "Shift-Alt-f",
            run: () => {
              onRequestFormatRef.current();
              return true;
            },
          },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressChangeRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            onCursorChangeRef.current(readCursorInfo(update.state));
          }
        }),
      ];
    }, [
      compartments,
      language,
      openFindInternal,
      readOnly,
      settings.fontSize,
      settings.showLineNumbers,
      settings.tabSize,
      settings.theme,
      settings.useTabs,
      settings.wordWrap,
    ]);

    // Mount CodeMirror EditorView once
    useEffect(() => {
      if (!hostRef.current) return;

      const initialState = EditorState.create({
        doc: content,
        extensions: buildBaseExtensions(),
      });

      const view = new EditorView({
        state: initialState,
        parent: hostRef.current,
      });

      viewRef.current = view;
      tabStatesRef.current.set(tabId, initialState);
      activeTabIdRef.current = tabId;
      onCursorChangeRef.current(readCursorInfo(initialState));

      const updateScroll = () => {
        const scroller = view.scrollDOM;
        const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        const scrollRatio =
          scroller.scrollHeight <= scroller.clientHeight
            ? 0
            : scroller.scrollTop / maxScroll;
        const viewportRatio =
          scroller.scrollHeight > 0
            ? Math.min(1, scroller.clientHeight / scroller.scrollHeight)
            : 1;
        setScrollInfo({ scrollRatio, viewportRatio });
      };

      const scroller = view.scrollDOM;
      scroller.addEventListener("scroll", updateScroll, { passive: true });
      const ro = new ResizeObserver(updateScroll);
      ro.observe(scroller);
      requestAnimationFrame(updateScroll);

      return () => {
        scroller.removeEventListener("scroll", updateScroll);
        ro.disconnect();
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Switch tab state cleanly while preserving per-tab undo history & cursor
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      if (activeTabIdRef.current !== tabId) {
        tabStatesRef.current.set(activeTabIdRef.current, view.state);
        activeTabIdRef.current = tabId;

        const cached = tabStatesRef.current.get(tabId);
        if (cached) {
          view.setState(cached);
          if (cached.doc.toString() !== content) {
            suppressChangeRef.current = true;
            view.dispatch({
              changes: { from: 0, to: cached.doc.length, insert: content },
            });
            suppressChangeRef.current = false;
          }
        } else {
          const nextState = EditorState.create({
            doc: content,
            extensions: buildBaseExtensions(),
          });
          view.setState(nextState);
          tabStatesRef.current.set(tabId, nextState);
        }

        // Ensure dynamic compartments match current settings/language
        const indentStr = settings.useTabs ? "\t" : " ".repeat(settings.tabSize);
        view.dispatch({
          effects: [
            compartments.language.reconfigure(getLanguageExtension(language)),
            compartments.theme.reconfigure(
              getThemeExtension(settings.theme, settings.fontSize)
            ),
            compartments.wrap.reconfigure(
              settings.wordWrap ? EditorView.lineWrapping : []
            ),
            compartments.lineNumbers.reconfigure(
              settings.showLineNumbers ? lineNumbers() : []
            ),
            compartments.indent.reconfigure([
              EditorState.tabSize.of(settings.tabSize),
              indentUnit.of(indentStr),
            ]),
            compartments.lint.reconfigure(
              createFormatLinter(language, (c, f) => onValidateRef.current(c, f))
            ),
            compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
          ],
        });
        onCursorChangeRef.current(readCursorInfo(view.state));
        return;
      }

      // Same tab: sync external content updates (e.g. Format, Convert, Reload)
      const currentDoc = view.state.doc.toString();
      if (currentDoc !== content) {
        suppressChangeRef.current = true;
        const mainPos = Math.min(view.state.selection.main.head, content.length);
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
          selection: EditorSelection.cursor(mainPos),
        });
        suppressChangeRef.current = false;
      }
    }, [tabId, content, buildBaseExtensions, compartments, language, readOnly, settings]);

    // Live reconfigure compartments when settings or language change
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const indentStr = settings.useTabs ? "\t" : " ".repeat(settings.tabSize);
      view.dispatch({
        effects: [
          compartments.language.reconfigure(getLanguageExtension(language)),
          compartments.theme.reconfigure(
            getThemeExtension(settings.theme, settings.fontSize)
          ),
          compartments.wrap.reconfigure(
            settings.wordWrap ? EditorView.lineWrapping : []
          ),
          compartments.lineNumbers.reconfigure(
            settings.showLineNumbers ? lineNumbers() : []
          ),
          compartments.indent.reconfigure([
            EditorState.tabSize.of(settings.tabSize),
            indentUnit.of(indentStr),
          ]),
          compartments.lint.reconfigure(
            createFormatLinter(language, (c, f) => onValidateRef.current(c, f))
          ),
          compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
        ],
      });
    }, [
      compartments,
      language,
      readOnly,
      settings.fontSize,
      settings.showLineNumbers,
      settings.tabSize,
      settings.theme,
      settings.useTabs,
      settings.wordWrap,
    ]);

    // Recompute search matches & highlight decorations
    const { matches, error: regexError } = useMemo(
      () => computeMatchesInDoc(content, findState, selectionScope),
      [content, findState, selectionScope]
    );

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const clampedIdx =
        matches.length === 0 ? 0 : Math.min(activeMatchIndex, matches.length - 1);
      if (clampedIdx !== activeMatchIndex) {
        setActiveMatchIndex(clampedIdx);
      }
      view.dispatch({
        effects: setSearchHighlights.of({
          matches: findState.isOpen ? matches : [],
          activeIndex: clampedIdx,
        }),
      });
    }, [matches, activeMatchIndex, findState.isOpen]);

    const jumpToMatch = useCallback(
      (idx: number) => {
        const view = viewRef.current;
        if (!view || matches.length === 0) return;
        const wrapped = ((idx % matches.length) + matches.length) % matches.length;
        const m = matches[wrapped];
        setActiveMatchIndex(wrapped);
        view.dispatch({
          selection: EditorSelection.range(m.from, m.to),
          effects: EditorView.scrollIntoView(m.from, { y: "center" }),
        });
      },
      [matches]
    );

    const handleFindNext = useCallback(() => {
      if (matches.length === 0) return;
      jumpToMatch(activeMatchIndex + 1);
    }, [activeMatchIndex, jumpToMatch, matches.length]);

    const handleFindPrev = useCallback(() => {
      if (matches.length === 0) return;
      jumpToMatch(activeMatchIndex - 1);
    }, [activeMatchIndex, jumpToMatch, matches.length]);

    const handleSelectAllMatches = useCallback(() => {
      const view = viewRef.current;
      if (!view || matches.length === 0) return;
      const ranges = matches.map((m) => EditorSelection.range(m.from, m.to));
      view.dispatch({
        selection: EditorSelection.create(ranges, 0),
        scrollIntoView: true,
      });
      view.focus();
    }, [matches]);

    const handleReplaceCurrent = useCallback(() => {
      const view = viewRef.current;
      if (!view || matches.length === 0) return;
      const idx = Math.min(activeMatchIndex, matches.length - 1);
      const m = matches[idx];
      view.dispatch({
        changes: { from: m.from, to: m.to, insert: findState.replaceText },
        selection: EditorSelection.cursor(m.from + findState.replaceText.length),
        scrollIntoView: true,
      });
    }, [activeMatchIndex, findState.replaceText, matches]);

    const handleReplaceAll = useCallback(() => {
      const view = viewRef.current;
      if (!view || matches.length === 0) return;
      const changes = matches.map((m) => ({
        from: m.from,
        to: m.to,
        insert: findState.replaceText,
      }));
      view.dispatch({ changes });
    }, [findState.replaceText, matches]);

    const handleMinimapScroll = useCallback((ratio: number) => {
      const view = viewRef.current;
      if (!view) return;
      const scroller = view.scrollDOM;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = ratio * maxScroll;
    }, []);

    // Expose Imperative Handle for App & Sidebar / Command Palette actions
    useImperativeHandle(
      ref,
      () => ({
        async applyTransformToSelectionOrDoc(transform) {
          const view = viewRef.current;
          if (!view) return null;

          const ranges = view.state.selection.ranges;
          const hasSelection = ranges.some((r) => r.to > r.from);

          if (!hasSelection) {
            const fullText = view.state.doc.toString();
            const res = await transform(fullText);
            if (res.ok) {
              view.dispatch({
                changes: { from: 0, to: fullText.length, insert: res.output },
              });
            }
            view.focus();
            return res;
          }

          // Multi-cursor aware: transform each selected range independently!
          const changes: { from: number; to: number; insert: string }[] = [];
          let lastResult: TransformResult | null = null;

          for (const r of ranges) {
            if (r.to === r.from) continue;
            const slice = view.state.sliceDoc(r.from, r.to);
            const res = await transform(slice);
            lastResult = res;
            if (!res.ok) {
              return res;
            }
            changes.push({ from: r.from, to: r.to, insert: res.output });
          }

          if (changes.length > 0) {
            const spec: TransactionSpec = { changes };
            view.dispatch(spec);
          }
          view.focus();
          return lastResult;
        },
        insertText(text: string) {
          const view = viewRef.current;
          if (!view) return;
          const changes = view.state.selection.ranges.map((r) => ({
            from: r.from,
            to: r.to,
            insert: text,
          }));
          view.dispatch({ changes });
          view.focus();
        },
        jumpToLine(line: number, col = 1) {
          const view = viewRef.current;
          if (!view) return;
          const clampedLine = Math.max(1, Math.min(line, view.state.doc.lines));
          const lineObj = view.state.doc.line(clampedLine);
          const pos = Math.min(lineObj.from + Math.max(0, col - 1), lineObj.to);
          view.dispatch({
            selection: EditorSelection.cursor(pos),
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
          view.focus();
        },
        openFind(withReplace = false) {
          openFindInternal(withReplace);
        },
        addCursorAbove() {
          if (viewRef.current) {
            addCursorVertical(viewRef.current, -1);
            viewRef.current.focus();
          }
        },
        addCursorBelow() {
          if (viewRef.current) {
            addCursorVertical(viewRef.current, 1);
            viewRef.current.focus();
          }
        },
        splitSelectionIntoLines() {
          if (viewRef.current) {
            splitSelectionIntoLinesCmd(viewRef.current);
            viewRef.current.focus();
          }
        },
        selectAllOccurrences() {
          if (viewRef.current) {
            selectSelectionMatches(viewRef.current);
            viewRef.current.focus();
          }
        },
        selectNextOccurrence() {
          if (viewRef.current) {
            selectNextOccurrence(viewRef.current);
            viewRef.current.focus();
          }
        },
        formatCurrentDoc() {
          onRequestFormatRef.current();
        },
        focus() {
          viewRef.current?.focus();
        },
      }),
      [openFindInternal]
    );

    return (
      <div className="kunai-editor-pane">
        <FindReplaceBar
          state={findState}
          matchCount={matches.length}
          activeMatchIndex={activeMatchIndex}
          regexError={regexError}
          onChange={(patch) => {
            if (patch.inSelection && viewRef.current) {
              const main = viewRef.current.state.selection.main;
              if (main.to > main.from) {
                setSelectionScope({ from: main.from, to: main.to });
              }
            }
            setFindState((prev) => ({ ...prev, ...patch }));
          }}
          onFindNext={handleFindNext}
          onFindPrev={handleFindPrev}
          onSelectAllMatches={handleSelectAllMatches}
          onReplaceCurrent={handleReplaceCurrent}
          onReplaceAll={handleReplaceAll}
          onClose={() => {
            setFindState((prev) => ({ ...prev, isOpen: false }));
            viewRef.current?.focus();
          }}
        />
        <div className="kunai-editor-body">
          <div ref={hostRef} className="kunai-cm-host" />
          {settings.showMinimap && (
            <Minimap
              content={content}
              theme={settings.theme}
              scrollRatio={scrollInfo.scrollRatio}
              viewportRatio={scrollInfo.viewportRatio}
              onScrollToRatio={handleMinimapScroll}
            />
          )}
        </div>
      </div>
    );
  }
);

import React, { useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  CopyCheck,
  Regex,
  Replace,
  ReplaceAll,
  TextSelect,
  WholeWord,
  X,
} from "lucide-react";

export interface FindState {
  isOpen: boolean;
  showReplace: boolean;
  query: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  inSelection: boolean;
}

interface FindReplaceBarProps {
  state: FindState;
  matchCount: number;
  activeMatchIndex: number;
  regexError: string | null;
  onChange: (patch: Partial<FindState>) => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onSelectAllMatches: () => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export const FindReplaceBar: React.FC<FindReplaceBarProps> = ({
  state,
  matchCount,
  activeMatchIndex,
  regexError,
  onChange,
  onFindNext,
  onFindPrev,
  onSelectAllMatches,
  onReplaceCurrent,
  onReplaceAll,
  onClose,
}) => {
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.isOpen) {
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    }
  }, [state.isOpen]);

  if (!state.isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onFindNext();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      onFindPrev();
    }
  };

  const countLabel = regexError
    ? "Invalid regex"
    : !state.query
    ? ""
    : matchCount === 0
    ? "No results"
    : `${Math.max(1, activeMatchIndex + 1)} of ${matchCount}`;

  return (
    <div
      className="kunai-find-bar"
      role="region"
      aria-label="Find and Replace"
      onKeyDown={handleKeyDown}
    >
      <div className="kunai-find-row">
        <button
          type="button"
          className="kunai-icon-btn sm"
          onClick={() => onChange({ showReplace: !state.showReplace })}
          title="Toggle Replace"
          aria-label="Toggle Replace"
        >
          {state.showReplace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className={`kunai-find-input-wrap ${regexError ? "has-error" : ""}`}>
          <input
            ref={findInputRef}
            type="text"
            className="kunai-find-input"
            placeholder="Find..."
            value={state.query}
            onChange={(e) => onChange({ query: e.target.value })}
            aria-label="Find query"
          />
          <div className="kunai-find-toggles">
            <button
              type="button"
              className={`kunai-find-toggle ${state.caseSensitive ? "active" : ""}`}
              onClick={() => onChange({ caseSensitive: !state.caseSensitive })}
              title="Match Case"
              aria-label="Match Case"
            >
              <CaseSensitive size={14} />
            </button>
            <button
              type="button"
              className={`kunai-find-toggle ${state.wholeWord ? "active" : ""}`}
              onClick={() => onChange({ wholeWord: !state.wholeWord })}
              title="Match Whole Word"
              aria-label="Match Whole Word"
            >
              <WholeWord size={14} />
            </button>
            <button
              type="button"
              className={`kunai-find-toggle ${state.isRegex ? "active" : ""}`}
              onClick={() => onChange({ isRegex: !state.isRegex })}
              title="Use Regular Expression"
              aria-label="Use Regular Expression"
            >
              <Regex size={14} />
            </button>
            <button
              type="button"
              className={`kunai-find-toggle ${state.inSelection ? "active" : ""}`}
              onClick={() => onChange({ inSelection: !state.inSelection })}
              title="Search in Selection"
              aria-label="Search in Selection"
            >
              <TextSelect size={14} />
            </button>
          </div>
        </div>

        <span
          className={`kunai-find-count ${
            regexError || (state.query && matchCount === 0) ? "empty" : ""
          }`}
          title={regexError ?? undefined}
        >
          {countLabel}
        </span>

        <button
          type="button"
          className="kunai-icon-btn sm"
          onClick={onFindPrev}
          disabled={matchCount === 0}
          title="Previous Match (Shift+Enter)"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          className="kunai-icon-btn sm"
          onClick={onFindNext}
          disabled={matchCount === 0}
          title="Next Match (Enter)"
        >
          <ArrowDown size={14} />
        </button>
        <button
          type="button"
          className="kunai-icon-btn sm"
          onClick={onSelectAllMatches}
          disabled={matchCount === 0}
          title="Select All Matches into Multi-Cursors"
        >
          <CopyCheck size={14} />
        </button>
        <button
          type="button"
          className="kunai-icon-btn sm"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close Find Bar"
        >
          <X size={14} />
        </button>
      </div>

      {state.showReplace && (
        <div className="kunai-find-row replace-row">
          <div className="kunai-find-spacer" />
          <div className="kunai-find-input-wrap">
            <input
              type="text"
              className="kunai-find-input"
              placeholder="Replace with..."
              value={state.replaceText}
              onChange={(e) => onChange({ replaceText: e.target.value })}
              aria-label="Replace text"
            />
          </div>
          <button
            type="button"
            className="kunai-find-action-btn"
            onClick={onReplaceCurrent}
            disabled={matchCount === 0}
            title="Replace Current Match"
          >
            <Replace size={13} />
            <span>Replace</span>
          </button>
          <button
            type="button"
            className="kunai-find-action-btn"
            onClick={onReplaceAll}
            disabled={matchCount === 0}
            title="Replace All Matches"
          >
            <ReplaceAll size={13} />
            <span>All</span>
          </button>
        </div>
      )}
    </div>
  );
};

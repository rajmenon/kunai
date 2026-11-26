// Pure TypeScript client-side transforms, formatters, validators, converters,
// JSONPath query engine, LCS diff, and document statistics.
// Provides 100% browser-mode fallback parity with the Rust Tauri backend.

import type {
  FormatResult,
  ValidationResult,
  DocStats,
  TransformResult,
  DiffLine,
  DiffResult,
} from "../types/editor";

export type { FormatResult, ValidationResult, DocStats, TransformResult, DiffLine, DiffResult };

// ============================================================================
// Document Stats
// ============================================================================

export function computeStats(content: string): DocStats {
  const bytes = new TextEncoder().encode(content).length;
  const chars = Array.from(content).length;
  const trimmed = content.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const splitLines = content.length === 0 ? [] : content.split(/\r\n|\r|\n/);
  const lines = splitLines.length;
  const non_empty_lines = splitLines.filter((l) => l.trim().length > 0).length;
  const reading_time_sec = words === 0 ? 0 : Math.max(1, Math.ceil((words / 200) * 60));
  return { bytes, chars, words, lines, non_empty_lines, reading_time_sec };
}

// ============================================================================
// Offset -> Line/Col helper
// ============================================================================

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let col = 1;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

function extractJsonErrorPosition(content: string, message: string): { line: number | null; col: number | null } {
  const lineColMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColMatch) {
    return { line: parseInt(lineColMatch[1], 10), col: parseInt(lineColMatch[2], 10) };
  }
  const posMatch = message.match(/position\s+(\d+)/i);
  if (posMatch) {
    const pos = parseInt(posMatch[1], 10);
    const lc = offsetToLineCol(content, pos);
    return { line: lc.line, col: lc.col };
  }
  return { line: 1, col: 1 };
}

// ============================================================================
// Pure-TS YAML Parser & Serializer
// ============================================================================

class ParseError extends Error {
  line: number;
  col: number;
  constructor(message: string, line = 1, col = 1) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

function parseYamlScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~' || trimmed === 'Null' || trimmed === 'NULL') {
    return null;
  }
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true;
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false;

  // Quoted string
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  // Inline flow JSON-like array or object
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Parse relaxed YAML flow syntax
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const inner = trimmed.slice(1, -1).trim();
        if (!inner) return [];
        return splitFlowItems(inner).map((item) => parseYamlScalar(item));
      }
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const inner = trimmed.slice(1, -1).trim();
        if (!inner) return {};
        const obj: Record<string, unknown> = {};
        for (const pair of splitFlowItems(inner)) {
          const idx = findUnquotedColon(pair);
          if (idx !== -1) {
            const k = unquoteKey(pair.slice(0, idx).trim());
            obj[k] = parseYamlScalar(pair.slice(idx + 1));
          }
        }
        return obj;
      }
    }
  }

  // Numbers
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    return parseInt(trimmed, 16);
  }
  return trimmed;
}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      current += ch;
      if (ch === '\\' && inQuote === '"' && i + 1 < inner.length) {
        current += inner[++i];
      } else if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
      current += ch;
    } else if (ch === ']' || ch === '}') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items;
}

function stripYamlComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '\\' && inQuote === '"') {
        i++;
      } else if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function findUnquotedColon(str: string): number {
  let inQuote: string | null = null;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === '\\' && inQuote === '"') i++;
      else if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ':' && depth === 0) {
      if (i + 1 === str.length || /\s/.test(str[i + 1])) {
        return i;
      }
    }
  }
  return -1;
}

function unquoteKey(key: string): string {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

interface YamlLine {
  lineNum: number;
  indent: number;
  text: string;
  raw: string;
}

export function parseYaml(content: string): unknown {
  const rawLines = content.split(/\r\n|\r|\n/);
  const lines: YamlLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (/^\t+/.test(raw)) {
      throw new ParseError('Tabs are not allowed for indentation in YAML', i + 1, 1);
    }
    const stripped = stripYamlComment(raw);
    const trimmed = stripped.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...') continue;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ lineNum: i + 1, indent, text: trimmed, raw });
  }

  if (lines.length === 0) return null;

  let idx = 0;

  function parseBlock(minIndent: number): unknown {
    if (idx >= lines.length) return null;
    const first = lines[idx];
    if (first.indent < minIndent) return null;

    if (first.text === '-' || first.text.startsWith('- ')) {
      return parseSequence(first.indent);
    }
    if (findUnquotedColon(first.text) !== -1) {
      return parseMapping(first.indent);
    }
    idx++;
    return parseYamlScalar(first.text);
  }

  function parseBlockScalar(parentIndent: number, indicator: string, startLineNum: number): string {
    const fold = indicator.startsWith('>');
    const chomp = indicator.includes('-') ? 'strip' : indicator.includes('+') ? 'keep' : 'clip';
    const collected: string[] = [];
    let blockIndent: number | null = null;
    let rawIdx = startLineNum; // 0-based index of next raw line
    while (rawIdx < rawLines.length) {
      const r = rawLines[rawIdx];
      if (r.trim() === '') {
        collected.push('');
        rawIdx++;
        continue;
      }
      const ind = r.length - r.trimStart().length;
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      collected.push(r.slice(Math.min(blockIndent, ind)));
      rawIdx++;
    }
    // Advance idx past all parsed lines up to rawIdx
    while (idx < lines.length && lines[idx].lineNum <= rawIdx) {
      idx++;
    }
    let result = fold
      ? collected
          .join('\n')
          .replace(/([^\n])\n([^\n])/g, '$1 $2')
      : collected.join('\n');
    if (chomp === 'strip') result = result.replace(/\n+$/, '');
    else if (chomp === 'clip') result = result.replace(/\n+$/, '') + (collected.length > 0 ? '\n' : '');
    return result;
  }

  function parseSequence(seqIndent: number): unknown[] {
    const arr: unknown[] = [];
    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < seqIndent) break;
      if (line.indent > seqIndent) {
        throw new ParseError(`Unexpected indentation in YAML sequence`, line.lineNum, line.indent + 1);
      }
      if (!(line.text === '-' || line.text.startsWith('- '))) break;

      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      idx++;

      if (!rest) {
        if (idx < lines.length && lines[idx].indent > seqIndent) {
          arr.push(parseBlock(lines[idx].indent));
        } else {
          arr.push(null);
        }
      } else if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
        arr.push(parseBlockScalar(seqIndent, rest, line.lineNum));
      } else {
        const colonIdx = findUnquotedColon(rest);
        if (colonIdx !== -1 && !rest.startsWith('{') && !rest.startsWith('[')) {
          // Inline mapping inside sequence item
          const itemIndent = seqIndent + 2;
          const obj: Record<string, unknown> = {};
          const key = unquoteKey(rest.slice(0, colonIdx).trim());
          const valStr = rest.slice(colonIdx + 1).trim();
          if (valStr === '|' || valStr === '|-' || valStr === '|+' || valStr === '>' || valStr === '>-' || valStr === '>+') {
            obj[key] = parseBlockScalar(itemIndent, valStr, line.lineNum);
          } else if (valStr) {
            obj[key] = parseYamlScalar(valStr);
          } else if (idx < lines.length && lines[idx].indent > itemIndent) {
            obj[key] = parseBlock(lines[idx].indent);
          } else {
            obj[key] = null;
          }
          // Continue reading sibling keys at itemIndent
          while (idx < lines.length && lines[idx].indent === itemIndent) {
            const nextLine = lines[idx];
            const cIdx = findUnquotedColon(nextLine.text);
            if (cIdx === -1) break;
            const k = unquoteKey(nextLine.text.slice(0, cIdx).trim());
            const v = nextLine.text.slice(cIdx + 1).trim();
            idx++;
            if (v === '|' || v === '|-' || v === '|+' || v === '>' || v === '>-' || v === '>+') {
              obj[k] = parseBlockScalar(itemIndent, v, nextLine.lineNum);
            } else if (v) {
              obj[k] = parseYamlScalar(v);
            } else if (idx < lines.length && lines[idx].indent > itemIndent) {
              obj[k] = parseBlock(lines[idx].indent);
            } else {
              obj[k] = null;
            }
          }
          arr.push(obj);
        } else {
          arr.push(parseYamlScalar(rest));
        }
      }
    }
    return arr;
  }

  function parseMapping(mapIndent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < mapIndent) break;
      if (line.indent > mapIndent) {
        throw new ParseError(`Unexpected indentation in YAML mapping`, line.lineNum, line.indent + 1);
      }
      if (line.text === '-' || line.text.startsWith('- ')) break;

      const colonIdx = findUnquotedColon(line.text);
      if (colonIdx === -1) {
        throw new ParseError(`Expected ':' in YAML mapping`, line.lineNum, line.indent + 1);
      }
      const key = unquoteKey(line.text.slice(0, colonIdx).trim());
      const valStr = line.text.slice(colonIdx + 1).trim();
      idx++;

      if (valStr === '|' || valStr === '|-' || valStr === '|+' || valStr === '>' || valStr === '>-' || valStr === '>+') {
        obj[key] = parseBlockScalar(mapIndent, valStr, line.lineNum);
      } else if (valStr) {
        obj[key] = parseYamlScalar(valStr);
      } else if (idx < lines.length) {
        const next = lines[idx];
        if (next.indent > mapIndent) {
          obj[key] = parseBlock(next.indent);
        } else if (next.indent === mapIndent && (next.text === '-' || next.text.startsWith('- '))) {
          obj[key] = parseSequence(next.indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  return parseBlock(lines[0].indent);
}

function formatYamlString(val: string): string {
  if (val === '') return '""';
  if (val.includes('\n')) {
    return (
      '|\n' +
      val
        .replace(/\n$/, '')
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n')
    );
  }
  const needsQuote =
    /^(true|false|null|~|yes|no|on|off)$/i.test(val) ||
    /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(val) ||
    /^[\s\-?:,\[\]{}#&*!|>'"%@`]|[\s:]$|:\s|\s#/.test(val);
  return needsQuote ? JSON.stringify(val) : val;
}

export function serializeYaml(value: unknown, indentSize = 2, depth = 0): string {
  const pad = ' '.repeat(depth * indentSize);

  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return formatYamlString(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          if (Array.isArray(item) && item.length === 0) return `${pad}- []`;
          if (!Array.isArray(item) && Object.keys(item).length === 0) return `${pad}- {}`;
          const rendered = serializeYaml(item, indentSize, depth + 1);
          const childLines = rendered.split('\n');
          const firstTrimmed = childLines[0].trimStart();
          const rest = childLines.slice(1).join('\n');
          return rest ? `${pad}- ${firstTrimmed}\n${rest}` : `${pad}- ${firstTrimmed}`;
        }
        return `${pad}- ${serializeYaml(item, indentSize, depth + 1)}`;
      })
      .join('\n');
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        const keyStr = /^[a-zA-Z0-9_.-]+$/.test(k) ? k : JSON.stringify(k);
        if (v !== null && typeof v === 'object') {
          if (Array.isArray(v) && v.length === 0) return `${pad}${keyStr}: []`;
          if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${keyStr}: {}`;
          return `${pad}${keyStr}:\n${serializeYaml(v, indentSize, depth + 1)}`;
        }
        if (typeof v === 'string' && v.includes('\n')) {
          const innerPad = ' '.repeat((depth + 1) * indentSize);
          const block = v
            .replace(/\n$/, '')
            .split('\n')
            .map((l) => `${innerPad}${l}`)
            .join('\n');
          return `${pad}${keyStr}: |\n${block}`;
        }
        return `${pad}${keyStr}: ${serializeYaml(v, indentSize, depth + 1)}`;
      })
      .join('\n');
  }

  return String(value);
}

// ============================================================================
// Pure-TS TOML Parser & Serializer
// ============================================================================

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitDottedPath(pathStr: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < pathStr.length; i++) {
    const ch = pathStr[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += ch + (pathStr[++i] ?? '');
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) parts.push(cur.trim());
  return parts;
}

function parseTomlValue(raw: string, lineNum: number): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      throw new ParseError('Invalid double-quoted TOML string', lineNum, 1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  // Array
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items = splitFlowItems(inner).filter((x) => x.length > 0);
    return items.map((item) => parseTomlValue(item, lineNum));
  }
  // Inline table
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const obj: Record<string, unknown> = {};
    for (const pair of splitFlowItems(inner)) {
      const eq = findUnquotedChar(pair, '=');
      if (eq === -1) throw new ParseError('Expected "=" in TOML inline table', lineNum, 1);
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      setNestedKey(obj, splitDottedPath(k), parseTomlValue(v, lineNum));
    }
    return obj;
  }
  // Number (allow underscores in TOML numbers)
  const cleanNum = s.replace(/_/g, '');
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(cleanNum)) {
    return Number(cleanNum);
  }
  if (/^0x[0-9a-fA-F_]+$/.test(s)) return parseInt(cleanNum, 16);
  if (/^0o[0-7_]+$/.test(s)) return parseInt(cleanNum.slice(2), 8);
  if (/^0b[01_]+$/.test(s)) return parseInt(cleanNum.slice(2), 2);
  // ISO date/time stays as string
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;

  throw new ParseError(`Invalid TOML value: ${s}`, lineNum, 1);
}

function findUnquotedChar(str: string, target: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    } else if (ch === target && depth === 0) {
      return i;
    }
  }
  return -1;
}

function setNestedKey(root: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

export function parseToml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentTable: Record<string, unknown> = root;
  const rawLines = content.split(/\r\n|\r|\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    let line = stripTomlComment(rawLines[i]).trim();
    if (!line) continue;

    // Handle multi-line arrays
    while (
      countUnquotedBracketDelta(line) > 0 &&
      i + 1 < rawLines.length
    ) {
      i++;
      line += ' ' + stripTomlComment(rawLines[i]).trim();
    }

    if (line.startsWith('[[') && line.endsWith(']]')) {
      const path = splitDottedPath(line.slice(2, -2).trim());
      if (path.length === 0) throw new ParseError('Empty TOML array-of-tables header', lineNum, 1);
      let cur: Record<string, unknown> = root;
      for (let p = 0; p < path.length - 1; p++) {
        const key = path[p];
        if (!cur[key]) cur[key] = {};
        if (Array.isArray(cur[key])) {
          const arr = cur[key] as Record<string, unknown>[];
          cur = arr[arr.length - 1];
        } else {
          cur = cur[key] as Record<string, unknown>;
        }
      }
      const lastKey = path[path.length - 1];
      if (!cur[lastKey]) cur[lastKey] = [];
      if (!Array.isArray(cur[lastKey])) {
        throw new ParseError(`Cannot redefine "${lastKey}" as array of tables`, lineNum, 1);
      }
      const nextObj: Record<string, unknown> = {};
      (cur[lastKey] as Record<string, unknown>[]).push(nextObj);
      currentTable = nextObj;
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      const path = splitDottedPath(line.slice(1, -1).trim());
      if (path.length === 0) throw new ParseError('Empty TOML table header', lineNum, 1);
      let cur: Record<string, unknown> = root;
      for (const key of path) {
        if (!cur[key]) cur[key] = {};
        if (Array.isArray(cur[key])) {
          const arr = cur[key] as Record<string, unknown>[];
          cur = arr[arr.length - 1];
        } else if (typeof cur[key] === 'object' && cur[key] !== null) {
          cur = cur[key] as Record<string, unknown>;
        } else {
          throw new ParseError(`Key "${key}" is not a table`, lineNum, 1);
        }
      }
      currentTable = cur;
      continue;
    }

    const eqIdx = findUnquotedChar(line, '=');
    if (eqIdx === -1) {
      throw new ParseError(`Expected "=" in TOML key-value pair`, lineNum, 1);
    }
    const keyPath = splitDottedPath(line.slice(0, eqIdx).trim());
    const valRaw = line.slice(eqIdx + 1).trim();
    if (!valRaw) throw new ParseError(`Missing value for key "${keyPath.join('.')}"`, lineNum, eqIdx + 2);
    const val = parseTomlValue(valRaw, lineNum);
    setNestedKey(currentTable, keyPath, val);
  }

  return root;
}

function countUnquotedBracketDelta(str: string): number {
  let quote: string | null = null;
  let delta = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      delta++;
    } else if (ch === ']') {
      delta--;
    }
  }
  return delta;
}

function formatTomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function formatTomlInlineValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map((item) => formatTomlInlineValue(item)).join(', ')}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{ ${entries.map(([k, val]) => `${formatTomlKey(k)} = ${formatTomlInlineValue(val)}`).join(', ')} }`;
  }
  return JSON.stringify(String(v));
}

export function serializeToml(input: unknown): string {
  const obj: Record<string, unknown> =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : { items: input };

  const sections: string[] = [];

  function writeTable(table: Record<string, unknown>, prefix: string[]) {
    const scalarLines: string[] = [];
    const childTables: [string, Record<string, unknown>][] = [];
    const arrayTables: [string, Record<string, unknown>[]][] = [];

    for (const [k, v] of Object.entries(table)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        if (v.length > 0 && v.every((el) => el !== null && typeof el === 'object' && !Array.isArray(el))) {
          arrayTables.push([k, v as Record<string, unknown>[]]);
        } else {
          scalarLines.push(`${formatTomlKey(k)} = ${formatTomlInlineValue(v)}`);
        }
      } else if (typeof v === 'object') {
        childTables.push([k, v as Record<string, unknown>]);
      } else {
        scalarLines.push(`${formatTomlKey(k)} = ${formatTomlInlineValue(v)}`);
      }
    }

    if (prefix.length > 0 && (scalarLines.length > 0 || (childTables.length === 0 && arrayTables.length === 0))) {
      sections.push(`[${prefix.map(formatTomlKey).join('.')}]\n${scalarLines.join('\n')}`.trimEnd());
    } else if (prefix.length === 0 && scalarLines.length > 0) {
      sections.push(scalarLines.join('\n'));
    }

    for (const [k, child] of childTables) {
      writeTable(child, [...prefix, k]);
    }

    for (const [k, arr] of arrayTables) {
      const header = [...prefix, k].map(formatTomlKey).join('.');
      for (const item of arr) {
        const lines: string[] = [`[[${header}]]`];
        for (const [ik, iv] of Object.entries(item)) {
          if (iv === null || iv === undefined) continue;
          lines.push(`${formatTomlKey(ik)} = ${formatTomlInlineValue(iv)}`);
        }
        sections.push(lines.join('\n'));
      }
    }
  }

  writeTable(obj, []);
  return sections.join('\n\n') + (sections.length > 0 ? '\n' : '');
}

// ============================================================================
// Pure-TS CSV Parser & Serializer
// ============================================================================

export function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        if (content[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

function escapeCsvCell(val: unknown): string {
  const str = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function csvToObjects(content: string): Record<string, unknown>[] {
  const rows = parseCsvRows(content);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h, i) => h.trim() || `col_${i + 1}`);
  return rows.slice(1).map((r) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      const raw = (r[i] ?? '').trim();
      if (raw === '') obj[h] = '';
      else if (raw === 'true') obj[h] = true;
      else if (raw === 'false') obj[h] = false;
      else if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) obj[h] = Number(raw);
      else obj[h] = raw;
    });
    return obj;
  });
}

export function objectsToCsv(value: unknown): string {
  let records: Record<string, unknown>[] = [];
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0])) {
      records = value as Record<string, unknown>[];
    } else {
      return ['value', ...value.map((v) => escapeCsvCell(v))].join('\n');
    }
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const arrayProp = Object.values(obj).find(
      (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null
    );
    if (arrayProp) {
      records = arrayProp as Record<string, unknown>[];
    } else {
      records = [obj];
    }
  } else {
    return escapeCsvCell(value);
  }

  const headers: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(k);
      }
    }
  }

  const lines: string[] = [headers.map(escapeCsvCell).join(',')];
  for (const rec of records) {
    lines.push(headers.map((h) => escapeCsvCell(rec[h])).join(','));
  }
  return lines.join('\n');
}

function formatCsv(content: string, minify: boolean): FormatResult {
  const rows = parseCsvRows(content);
  if (rows.length === 0) {
    return { ok: true, output: '', error: null, error_line: null, error_col: null };
  }
  if (minify) {
    const out = rows.map((r) => r.map((c) => escapeCsvCell(c.trim())).join(',')).join('\n');
    return { ok: true, output: out, error: null, error_line: null, error_col: null };
  }
  const colCount = Math.max(...rows.map((r) => r.length));
  const escaped = rows.map((r) =>
    Array.from({ length: colCount }, (_, i) => escapeCsvCell((r[i] ?? '').trim()))
  );
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(...escaped.map((r) => r[c].length))
  );
  const out = escaped
    .map((r) =>
      r.map((cell, c) => (c === colCount - 1 ? cell : cell.padEnd(widths[c], ' '))).join(', ')
    )
    .join('\n');
  return { ok: true, output: out, error: null, error_line: null, error_col: null };
}

// ============================================================================
// XML / HTML Validator & Formatter
// ============================================================================

const HTML_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function validateXmlStrict(content: string): ValidationResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { valid: false, error: 'XML document is empty', line: 1, column: 1 };
  }

  const stack: { name: string; line: number; col: number }[] = [];
  const tokenRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  let sawRoot = false;

  while ((match = tokenRe.exec(content)) !== null) {
    const full = match[0];
    if (full.startsWith('<!--') || full.startsWith('<![CDATA[') || full.startsWith('<?') || full.startsWith('<!DOCTYPE')) {
      continue;
    }
    const lc = offsetToLineCol(content, match.index);
    const isClose = full.startsWith('</');
    const isSelfClose = match[3] === '/';
    const tagName = match[1];

    if (isClose) {
      if (stack.length === 0) {
        return { valid: false, error: `Unexpected closing tag </${tagName}>`, line: lc.line, column: lc.col };
      }
      const top = stack.pop()!;
      if (top.name !== tagName) {
        return {
          valid: false,
          error: `Mismatched closing tag </${tagName}>; expected </${top.name}> (opened at line ${top.line})`,
          line: lc.line,
          column: lc.col,
        };
      }
    } else {
      sawRoot = true;
      if (!isSelfClose) {
        stack.push({ name: tagName, line: lc.line, col: lc.col });
      }
    }
  }

  if (!sawRoot) {
    return { valid: false, error: 'No valid XML root element found', line: 1, column: 1 };
  }
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      valid: false,
      error: `Unclosed tag <${unclosed.name}>`,
      line: unclosed.line,
      column: unclosed.col,
    };
  }
  return { valid: true, error: null, line: null, column: null };
}

function formatMarkup(content: string, isHtml: boolean, unit: string, minify: boolean): FormatResult {
  if (!isHtml) {
    const v = validateXmlStrict(content);
    if (!v.valid) {
      return { ok: false, output: content, error: v.error, error_line: v.line, error_col: v.column };
    }
  }

  const tokens = content.match(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[^>]+>|[^<]+/gi
  );
  if (!tokens) {
    return { ok: true, output: '', error: null, error_line: null, error_col: null };
  }

  if (minify) {
    const out = tokens
      .map((t) => (t.startsWith('<') ? t.replace(/\s+/g, ' ').replace(/\s*>/g, '>') : t.trim()))
      .filter((t) => t.length > 0)
      .join('');
    return { ok: true, output: out, error: null, error_line: null, error_col: null };
  }

  const lines: string[] = [];
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('<')) {
      const text = tok.trim();
      if (text) {
        lines.push(`${unit.repeat(depth)}${text}`);
      }
      continue;
    }

    if (tok.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push(`${unit.repeat(depth)}${tok}`);
    } else if (
      tok.startsWith('<!--') ||
      tok.startsWith('<?') ||
      tok.startsWith('<!') ||
      tok.endsWith('/>')
    ) {
      lines.push(`${unit.repeat(depth)}${tok}`);
    } else {
      const nameMatch = tok.match(/^<([A-Za-z_][\w:.-]*)/);
      const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';
      const isVoid = isHtml && HTML_VOID_ELEMENTS.has(tagName);

      // Keep simple `<tag>short text</tag>` on one line
      const nextText = tokens[i + 1];
      const nextClose = tokens[i + 2];
      if (
        !isVoid &&
        nextText &&
        !nextText.startsWith('<') &&
        nextText.trim().length > 0 &&
        !nextText.includes('\n') &&
        nextText.trim().length <= 80 &&
        nextClose &&
        nextClose.toLowerCase() === `</${tagName}>`
      ) {
        lines.push(`${unit.repeat(depth)}${tok}${nextText.trim()}${nextClose}`);
        i += 2;
      } else {
        lines.push(`${unit.repeat(depth)}${tok}`);
        if (!isVoid) depth++;
      }
    }
  }

  return { ok: true, output: lines.join('\n'), error: null, error_line: null, error_col: null };
}

// ============================================================================
// CSS Formatter
// ============================================================================

function formatCss(content: string, unit: string, minify: boolean): FormatResult {
  if (minify) {
    const out = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>~+])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim();
    return { ok: true, output: out, error: null, error_line: null, error_col: null };
  }

  let out = '';
  let depth = 0;
  let inString: string | null = null;
  let inComment = false;
  let buf = '';

  const flushLine = () => {
    const t = buf.trim().replace(/\s+/g, ' ');
    if (t) out += `${unit.repeat(depth)}${t}\n`;
    buf = '';
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inComment) {
      buf += ch;
      if (ch === '*' && next === '/') {
        buf += '/';
        i++;
        inComment = false;
        flushLine();
      }
      continue;
    }

    if (inString) {
      buf += ch;
      if (ch === '\\' && next) {
        buf += next;
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      flushLine();
      inComment = true;
      buf = '/*';
      i++;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
    } else if (ch === '{') {
      const sel = buf.trim().replace(/\s+/g, ' ');
      out += `${unit.repeat(depth)}${sel} {\n`;
      buf = '';
      depth++;
    } else if (ch === '}') {
      flushLine();
      depth = Math.max(0, depth - 1);
      out += `${unit.repeat(depth)}}\n${depth === 0 ? '\n' : ''}`;
    } else if (ch === ';') {
      const prop = buf.trim().replace(/\s+/g, ' ').replace(/\s*:\s*/, ': ');
      if (prop) out += `${unit.repeat(depth)}${prop};\n`;
      buf = '';
    } else {
      buf += ch;
    }
  }
  flushLine();
  return { ok: true, output: out.trimEnd() + '\n', error: null, error_line: null, error_col: null };
}

// ============================================================================
// SQL Formatter
// ============================================================================

const SQL_NEWLINE_CLAUSES = [
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'CROSS JOIN',
  'GROUP BY',
  'ORDER BY',
  'INSERT INTO',
  'DELETE FROM',
  'UNION ALL',
  'SELECT',
  'FROM',
  'WHERE',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'VALUES',
  'UPDATE',
  'SET',
  'JOIN',
  'UNION',
  'WITH',
  'RETURNING',
];

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'ON',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'ORDER',
  'BY', 'ASC', 'DESC', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'ALL', 'UNION',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
  'ALTER', 'DROP', 'INDEX', 'VIEW', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'DEFAULT', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'BETWEEN', 'LIKE', 'ILIKE', 'EXISTS', 'WITH', 'RECURSIVE', 'RETURNING',
  'COALESCE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CAST',
]);

function formatSql(content: string, unit: string, minify: boolean): FormatResult {
  // Preserve strings and comments via placeholders
  const placeholders: string[] = [];
  const masked = content.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => {
    const id = `__SQL_PH_${placeholders.length}__`;
    placeholders.push(m);
    return id;
  });

  if (minify) {
    let compact = masked.replace(/\s+/g, ' ').trim();
    placeholders.forEach((p, i) => {
      compact = compact.replace(`__SQL_PH_${i}__`, p);
    });
    return { ok: true, output: compact, error: null, error_line: null, error_col: null };
  }

  let sql = masked.replace(/\s+/g, ' ').trim();

  // Uppercase keywords
  sql = sql.replace(/\b([A-Za-z_]+)\b/g, (word) => {
    const up = word.toUpperCase();
    return SQL_KEYWORDS.has(up) ? up : word;
  });

  // Break before major clauses
  for (const clause of SQL_NEWLINE_CLAUSES) {
    const re = new RegExp(`\\s+(${clause.replace(/ /g, '\\s+')})\\b`, 'g');
    sql = sql.replace(re, `\n${clause}`);
  }

  // Indent AND / OR inside WHERE/ON
  sql = sql.replace(/\s+(AND|OR)\b/g, `\n${unit}$1`);

  // Put commas in SELECT list on new indented lines
  const lines = sql.split('\n').map((line) => {
    if (line.startsWith('SELECT ')) {
      const rest = line.slice(7);
      const cols = rest.split(/\s*,\s*/);
      if (cols.length > 1) {
        return `SELECT\n${cols.map((c) => `${unit}${c}`).join(',\n')}`;
      }
    }
    if (line.startsWith('SET ')) {
      const rest = line.slice(4);
      const assigns = rest.split(/\s*,\s*/);
      if (assigns.length > 1) {
        return `SET\n${assigns.map((c) => `${unit}${c}`).join(',\n')}`;
      }
    }
    return line;
  });

  let formatted = lines.join('\n').replace(/\s*;\s*/g, ';\n\n').trim();
  placeholders.forEach((p, i) => {
    formatted = formatted.replace(`__SQL_PH_${i}__`, p);
  });

  return { ok: true, output: formatted, error: null, error_line: null, error_col: null };
}

// ============================================================================
// Public Format, Validate, Convert, Query APIs
// ============================================================================

export function formatDocument(
  content: string,
  format: string,
  indent = 2,
  useTabs = false,
  minify = false
): FormatResult {
  const fmt = format.toLowerCase();
  const unit = useTabs ? '\t' : ' '.repeat(Math.max(1, indent));

  try {
    switch (fmt) {
      case 'json': {
        const parsed = JSON.parse(content);
        const output = minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, unit);
        return { ok: true, output, error: null, error_line: null, error_col: null };
      }
      case 'yaml':
      case 'yml': {
        const parsed = parseYaml(content);
        const output = minify ? JSON.stringify(parsed) : serializeYaml(parsed, indent);
        return { ok: true, output, error: null, error_line: null, error_col: null };
      }
      case 'toml': {
        const parsed = parseToml(content);
        const output = serializeToml(parsed);
        return { ok: true, output: minify ? output.replace(/\n\n+/g, '\n').trim() : output, error: null, error_line: null, error_col: null };
      }
      case 'xml':
      case 'svg':
        return formatMarkup(content, false, unit, minify);
      case 'html':
        return formatMarkup(content, true, unit, minify);
      case 'css':
        return formatCss(content, unit, minify);
      case 'sql':
        return formatSql(content, unit, minify);
      case 'csv':
        return formatCsv(content, minify);
      default:
        return { ok: false, output: content, error: `Unsupported format: ${format}`, error_line: null, error_col: null };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ParseError) {
      return { ok: false, output: content, error: message, error_line: err.line, error_col: err.col };
    }
    if (fmt === 'json') {
      const pos = extractJsonErrorPosition(content, message);
      return { ok: false, output: content, error: message, error_line: pos.line, error_col: pos.col };
    }
    return { ok: false, output: content, error: message, error_line: 1, error_col: 1 };
  }
}

export function validateDocument(content: string, format: string): ValidationResult {
  const fmt = format.toLowerCase();
  if (!content.trim()) {
    return { valid: true, error: null, line: null, column: null };
  }
  try {
    switch (fmt) {
      case 'json':
        JSON.parse(content);
        return { valid: true, error: null, line: null, column: null };
      case 'yaml':
      case 'yml':
        parseYaml(content);
        return { valid: true, error: null, line: null, column: null };
      case 'toml':
        parseToml(content);
        return { valid: true, error: null, line: null, column: null };
      case 'xml':
      case 'svg':
        return validateXmlStrict(content);
      default:
        return { valid: true, error: null, line: null, column: null };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ParseError) {
      return { valid: false, error: message, line: err.line, column: err.col };
    }
    if (fmt === 'json') {
      const pos = extractJsonErrorPosition(content, message);
      return { valid: false, error: message, line: pos.line, column: pos.col };
    }
    return { valid: false, error: message, line: 1, column: 1 };
  }
}

export function parseStructuredData(content: string, format: string): unknown {
  const fmt = format.toLowerCase();
  switch (fmt) {
    case 'json':
      return JSON.parse(content);
    case 'yaml':
    case 'yml':
      return parseYaml(content);
    case 'toml':
      return parseToml(content);
    case 'csv':
      return csvToObjects(content);
    default:
      throw new Error(`Unsupported structured format: ${format}`);
  }
}

export function convertFormat(content: string, from: string, to: string): FormatResult {
  try {
    const data = parseStructuredData(content, from);
    const target = to.toLowerCase();
    let output = '';
    switch (target) {
      case 'json':
        output = JSON.stringify(data, null, 2);
        break;
      case 'yaml':
      case 'yml':
        output = serializeYaml(data, 2);
        break;
      case 'toml':
        output = serializeToml(data);
        break;
      case 'csv':
        output = objectsToCsv(data);
        break;
      default:
        return { ok: false, output: content, error: `Unsupported target format: ${to}`, error_line: null, error_col: null };
    }
    return { ok: true, output, error: null, error_line: null, error_col: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ParseError) {
      return { ok: false, output: content, error: message, error_line: err.line, error_col: err.col };
    }
    if (from.toLowerCase() === 'json') {
      const pos = extractJsonErrorPosition(content, message);
      return { ok: false, output: content, error: message, error_line: pos.line, error_col: pos.col };
    }
    return { ok: false, output: content, error: message, error_line: null, error_col: null };
  }
}

// ============================================================================
// JSONPath Query Engine ($, $.a.b[0], $.items[*].name, $['key'])
// ============================================================================

type PathToken =
  | { type: 'key'; value: string }
  | { type: 'index'; value: number }
  | { type: 'wildcard' };

function tokenizeJsonPath(path: string): PathToken[] {
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  if (p.startsWith('.')) p = p.slice(1);
  if (!p) return [];

  const tokens: PathToken[] = [];
  let i = 0;

  while (i < p.length) {
    if (p[i] === '.') {
      i++;
      continue;
    }
    if (p[i] === '[') {
      const close = p.indexOf(']', i);
      if (close === -1) throw new Error(`Unclosed "[" in JSONPath at position ${i}`);
      const inner = p.slice(i + 1, close).trim();
      if (inner === '*') {
        tokens.push({ type: 'wildcard' });
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push({ type: 'index', value: parseInt(inner, 10) });
      } else if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        tokens.push({ type: 'key', value: inner.slice(1, -1) });
      } else {
        tokens.push({ type: 'key', value: inner });
      }
      i = close + 1;
    } else {
      let end = i;
      while (end < p.length && p[end] !== '.' && p[end] !== '[') end++;
      const seg = p.slice(i, end);
      if (seg === '*') {
        tokens.push({ type: 'wildcard' });
      } else if (seg.length > 0) {
        tokens.push({ type: 'key', value: seg });
      }
      i = end;
    }
  }

  return tokens;
}

export function queryJson(content: string, path: string): FormatResult {
  try {
    const root = JSON.parse(content);
    const tokens = tokenizeJsonPath(path);
    if (tokens.length === 0) {
      return { ok: true, output: JSON.stringify(root, null, 2), error: null, error_line: null, error_col: null };
    }

    let current: unknown[] = [root];
    let usedWildcard = false;

    for (const tok of tokens) {
      const next: unknown[] = [];
      for (const node of current) {
        if (node === null || node === undefined) continue;
        if (tok.type === 'wildcard') {
          usedWildcard = true;
          if (Array.isArray(node)) {
            next.push(...node);
          } else if (typeof node === 'object') {
            next.push(...Object.values(node as Record<string, unknown>));
          }
        } else if (tok.type === 'index') {
          if (Array.isArray(node)) {
            const idx = tok.value < 0 ? node.length + tok.value : tok.value;
            if (idx >= 0 && idx < node.length) next.push(node[idx]);
          }
        } else if (tok.type === 'key') {
          if (typeof node === 'object' && !Array.isArray(node) && tok.value in (node as Record<string, unknown>)) {
            next.push((node as Record<string, unknown>)[tok.value]);
          }
        }
      }
      current = next;
    }

    const result = usedWildcard ? current : current.length === 0 ? null : current.length === 1 ? current[0] : current;
    return {
      ok: true,
      output: JSON.stringify(result, null, 2),
      error: null,
      error_line: null,
      error_col: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pos = extractJsonErrorPosition(content, message);
    return { ok: false, output: '', error: message, error_line: pos.line, error_col: pos.col };
  }
}

// ============================================================================
// Pure-JS MD5 (RFC 1321) + SubtleCrypto SHA Hashing
// ============================================================================

function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const origBitLen = bytes.length * 8;
  const padLen = ((56 - ((bytes.length + 1) % 64)) + 64) % 64;
  const padded = new Uint8Array(bytes.length + 1 + padLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, origBitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(origBitLen / 0x100000000) >>> 0, true);

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function subtleHashHex(alg: 'SHA-1' | 'SHA-256' | 'SHA-512', input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest(alg, bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Text Transform Helpers (Case, Encoding, JSON Sort, JWT)
// ============================================================================

function splitWords(str: string): string[] {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-\s./]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function mapPerLine(content: string, fn: (line: string) => string): string {
  return content.split('\n').map(fn).join('\n');
}

function encodeBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decodeBase64Utf8(b64: string): string {
  const clean = b64.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function sortObjectKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortObjectKeysDeep);
  if (val !== null && typeof val === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = sortObjectKeysDeep((val as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return val;
}

function decodeJwtToken(token: string): string {
  const parts = token.trim().split('.');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error('Invalid JWT format: expected 2 or 3 dot-separated Base64URL segments');
  }
  const header = JSON.parse(decodeBase64Utf8(parts[0]));
  const payload = JSON.parse(decodeBase64Utf8(parts[1]));
  const meta: Record<string, string> = {};
  for (const field of ['iat', 'exp', 'nbf']) {
    if (typeof payload[field] === 'number') {
      meta[`${field}_iso`] = new Date(payload[field] * 1000).toISOString();
    }
  }
  const decoded: Record<string, unknown> = {
    header,
    payload,
    signature: parts[2] ?? '',
  };
  if (Object.keys(meta).length > 0) decoded.timestamps = meta;
  return JSON.stringify(decoded, null, 2);
}

function generateUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// Main transformText (async for SubtleCrypto support)
// ============================================================================

export async function transformText(
  content: string,
  op: string,
  arg?: string | null
): Promise<TransformResult> {
  const lines = content.split('\n');
  let output = content;

  try {
    switch (op) {
      // --- Line Operations ---
      case 'sort_asc':
        output = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n');
        break;
      case 'sort_desc':
        output = [...lines].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).join('\n');
        break;
      case 'sort_ci_asc':
        output = [...lines].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join('\n');
        break;
      case 'sort_numeric_asc':
      case 'sort_numeric_desc': {
        const extractNum = (s: string) => {
          const m = s.match(/-?\d+(?:\.\d+)?/);
          return m ? parseFloat(m[0]) : Number.POSITIVE_INFINITY;
        };
        const dir = op === 'sort_numeric_asc' ? 1 : -1;
        output = [...lines]
          .sort((a, b) => {
            const na = extractNum(a);
            const nb = extractNum(b);
            if (na !== nb) return (na - nb) * dir;
            return a.localeCompare(b) * dir;
          })
          .join('\n');
        break;
      }
      case 'sort_length_asc':
        output = [...lines].sort((a, b) => a.length - b.length || a.localeCompare(b)).join('\n');
        break;
      case 'dedupe_lines': {
        const seen = new Set<string>();
        output = lines.filter((l) => {
          if (seen.has(l)) return false;
          seen.add(l);
          return true;
        }).join('\n');
        break;
      }
      case 'remove_empty_lines':
        output = lines.filter((l) => l.length > 0).join('\n');
        break;
      case 'remove_blank_lines':
        output = lines.filter((l) => l.trim().length > 0).join('\n');
        break;
      case 'trim_trailing':
        output = lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n');
        break;
      case 'trim_leading':
        output = lines.map((l) => l.replace(/^[ \t]+/, '')).join('\n');
        break;
      case 'trim_both':
        output = lines.map((l) => l.trim()).join('\n');
        break;
      case 'reverse_lines':
        output = [...lines].reverse().join('\n');
        break;
      case 'join_lines': {
        const sep = arg ?? ' ';
        output = lines.map((l) => l.trim()).filter((l) => l.length > 0).join(sep);
        break;
      }
      case 'number_lines': {
        const width = String(lines.length).length;
        output = lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}: ${l}`).join('\n');
        break;
      }
      case 'filter_keep_regex': {
        const re = new RegExp(arg ?? '');
        output = lines.filter((l) => re.test(l)).join('\n');
        break;
      }
      case 'filter_remove_regex': {
        const re = new RegExp(arg ?? '');
        output = lines.filter((l) => !re.test(l)).join('\n');
        break;
      }
      case 'add_prefix': {
        const prefix = arg ?? '';
        output = lines.map((l) => `${prefix}${l}`).join('\n');
        break;
      }
      case 'add_suffix': {
        const suffix = arg ?? '';
        output = lines.map((l) => `${l}${suffix}`).join('\n');
        break;
      }

      // --- Case Operations ---
      case 'upper':
        output = content.toUpperCase();
        break;
      case 'lower':
        output = content.toLowerCase();
        break;
      case 'title':
        output = content.replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
        break;
      case 'camel':
        output = mapPerLine(content, (line) => {
          const words = splitWords(line);
          return words
            .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
            .join('');
        });
        break;
      case 'pascal':
        output = mapPerLine(content, (line) =>
          splitWords(line)
            .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
            .join('')
        );
        break;
      case 'snake':
        output = mapPerLine(content, (line) =>
          splitWords(line)
            .map((w) => w.toLowerCase())
            .join('_')
        );
        break;
      case 'kebab':
        output = mapPerLine(content, (line) =>
          splitWords(line)
            .map((w) => w.toLowerCase())
            .join('-')
        );
        break;
      case 'screaming_snake':
        output = mapPerLine(content, (line) =>
          splitWords(line)
            .map((w) => w.toUpperCase())
            .join('_')
        );
        break;
      case 'invert_case':
        output = Array.from(content)
          .map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()))
          .join('');
        break;

      // --- Encoding / Web / Escape ---
      case 'base64_encode':
        output = encodeBase64Utf8(content);
        break;
      case 'base64_decode':
        output = decodeBase64Utf8(content);
        break;
      case 'url_encode':
        output = encodeURIComponent(content);
        break;
      case 'url_decode':
        output = decodeURIComponent(content);
        break;
      case 'html_encode':
        output = content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
        break;
      case 'html_decode':
        output = content
          .replace(/&quot;/g, '"')
          .replace(/&#39;|&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
        break;
      case 'hex_encode': {
        const bytes = new TextEncoder().encode(content);
        output = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        break;
      }
      case 'hex_decode': {
        const clean = content.replace(/\s+/g, '');
        if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
          throw new Error('Invalid hex string');
        }
        const bytes = new Uint8Array(clean.length / 2);
        for (let i = 0; i < clean.length; i += 2) {
          bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
        }
        output = new TextDecoder().decode(bytes);
        break;
      }
      case 'unicode_escape':
        output = Array.from(content)
          .map((ch) => {
            const code = ch.charCodeAt(0);
            if (code > 127) {
              return '\\u' + code.toString(16).padStart(4, '0');
            }
            return ch;
          })
          .join('');
        break;
      case 'unicode_unescape':
        output = content.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16))
        );
        break;
      case 'json_escape':
        output = JSON.stringify(content).slice(1, -1);
        break;
      case 'json_unescape':
        output = JSON.parse(`"${content.replace(/^"|"$/g, '')}"`);
        break;
      case 'jwt_decode':
        output = decodeJwtToken(content);
        break;

      // --- Crypto / UUID / Timestamps / JSON ---
      case 'hash_md5':
        output = md5Hex(content);
        break;
      case 'hash_sha1':
        output = await subtleHashHex('SHA-1', content);
        break;
      case 'hash_sha256':
        output = await subtleHashHex('SHA-256', content);
        break;
      case 'hash_sha512':
        output = await subtleHashHex('SHA-512', content);
        break;
      case 'gen_uuid':
        output = generateUuidV4();
        break;
      case 'timestamp_to_iso': {
        const raw = content.trim();
        if (!raw) {
          output = new Date().toISOString();
        } else {
          const num = Number(raw);
          if (Number.isNaN(num)) throw new Error('Invalid Unix timestamp');
          const ms = Math.abs(num) > 1e12 ? num : num * 1000;
          output = new Date(ms).toISOString();
        }
        break;
      }
      case 'iso_to_timestamp': {
        const raw = content.trim();
        const dt = raw ? new Date(raw) : new Date();
        if (Number.isNaN(dt.getTime())) throw new Error('Invalid ISO date string');
        output = String(Math.floor(dt.getTime() / 1000));
        break;
      }
      case 'json_sort_keys': {
        const parsed = JSON.parse(content);
        output = JSON.stringify(sortObjectKeysDeep(parsed), null, 2);
        break;
      }
      default:
        return {
          ok: false,
          output: content,
          error: `Unknown transform operation: ${op}`,
          stats: null,
        };
    }

    const st = computeStats(output);
    return {
      ok: true,
      output,
      error: null,
      stats: `${st.lines} lines · ${st.words} words · ${st.chars} chars`,
    };
  } catch (err) {
    return {
      ok: false,
      output: content,
      error: err instanceof Error ? err.message : String(err),
      stats: null,
    };
  }
}

// ============================================================================
// LCS Line Diff Engine
// ============================================================================

export function computeDiff(left: string, right: string): DiffResult {
  const leftLines = left.length === 0 ? [] : left.split(/\r\n|\r|\n/);
  const rightLines = right.length === 0 ? [] : right.split(/\r\n|\r|\n/);

  // Trim common prefix & suffix for speed
  let prefix = 0;
  const minLen = Math.min(leftLines.length, rightLines.length);
  while (prefix < minLen && leftLines[prefix] === rightLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    leftLines[leftLines.length - 1 - suffix] === rightLines[rightLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midLeft = leftLines.slice(prefix, leftLines.length - suffix);
  const midRight = rightLines.slice(prefix, rightLines.length - suffix);

  const hunks: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  // Prefix equal lines
  for (let i = 0; i < prefix; i++) {
    hunks.push({
      kind: 'equal',
      left_line: i + 1,
      right_line: i + 1,
      text: leftLines[i],
    });
  }

  const m = midLeft.length;
  const n = midRight.length;

  if (m * n <= 2_500_000) {
    // Classic LCS DP table
    const stride = n + 1;
    const dp = new Uint32Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midLeft[i] === midRight[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * stride + j];
          const rightVal = dp[i * stride + (j + 1)];
          dp[i * stride + j] = down >= rightVal ? down : rightVal;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midLeft[i] === midRight[j]) {
        hunks.push({
          kind: 'equal',
          left_line: prefix + i + 1,
          right_line: prefix + j + 1,
          text: midLeft[i],
        });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        hunks.push({
          kind: 'delete',
          left_line: prefix + i + 1,
          right_line: null,
          text: midLeft[i],
        });
        deletions++;
        i++;
      } else {
        hunks.push({
          kind: 'insert',
          left_line: null,
          right_line: prefix + j + 1,
          text: midRight[j],
        });
        additions++;
        j++;
      }
    }
    while (i < m) {
      hunks.push({ kind: 'delete', left_line: prefix + i + 1, right_line: null, text: midLeft[i] });
      deletions++;
      i++;
    }
    while (j < n) {
      hunks.push({ kind: 'insert', left_line: null, right_line: prefix + j + 1, text: midRight[j] });
      additions++;
      j++;
    }
  } else {
    // Large-file linear fallback
    for (let i = 0; i < m; i++) {
      hunks.push({ kind: 'delete', left_line: prefix + i + 1, right_line: null, text: midLeft[i] });
      deletions++;
    }
    for (let j = 0; j < n; j++) {
      hunks.push({ kind: 'insert', left_line: null, right_line: prefix + j + 1, text: midRight[j] });
      additions++;
    }
  }

  // Suffix equal lines
  for (let s = 0; s < suffix; s++) {
    const li = leftLines.length - suffix + s;
    const ri = rightLines.length - suffix + s;
    hunks.push({
      kind: 'equal',
      left_line: li + 1,
      right_line: ri + 1,
      text: leftLines[li],
    });
  }

  return { hunks, additions, deletions };
}

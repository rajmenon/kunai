use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use md5::{Digest as Md5Digest, Md5};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

const MAX_REGEX_SIZE_BYTES: usize = 1 << 20;

fn build_safe_regex(pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .size_limit(MAX_REGEX_SIZE_BYTES)
        .dfa_size_limit(MAX_REGEX_SIZE_BYTES)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))
}
use serde_json::{Map, Value};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use similar::{ChangeTag, TextDiff};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransformResult {
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
    pub stats: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: String,
    pub left_line: Option<usize>,
    pub right_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffResult {
    pub hunks: Vec<DiffLine>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocStats {
    pub bytes: usize,
    pub chars: usize,
    pub words: usize,
    pub lines: usize,
    pub non_empty_lines: usize,
    pub reading_time_sec: usize,
}

impl TransformResult {
    fn success(output: String, stats: Option<String>) -> Self {
        Self {
            ok: true,
            output,
            error: None,
            stats,
        }
    }

    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: String::new(),
            error: Some(msg.into()),
            stats: None,
        }
    }
}

fn split_lines_owned(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    content.split('\n').map(|s| s.to_string()).collect()
}

fn extract_leading_number(line: &str) -> Option<f64> {
    let trimmed = line.trim();
    let mut end = 0;
    let bytes = trimmed.as_bytes();
    if end < bytes.len() && (bytes[end] == b'-' || bytes[end] == b'+') {
        end += 1;
    }
    let mut saw_digit = false;
    let mut saw_dot = false;
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_digit() {
            saw_digit = true;
            end += 1;
        } else if b == b'.' && !saw_dot {
            saw_dot = true;
            end += 1;
        } else {
            break;
        }
    }
    if saw_digit {
        trimmed[..end].parse::<f64>().ok()
    } else {
        None
    }
}

fn split_identifier_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = input.chars().collect();

    for i in 0..chars.len() {
        let c = chars[i];
        if !c.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }

        if !current.is_empty() {
            let prev = chars[i - 1];
            let next = chars.get(i + 1).copied();
            let boundary_lower_to_upper = prev.is_lowercase() && c.is_uppercase();
            let boundary_acronym_end =
                prev.is_uppercase() && c.is_uppercase() && next.map(|n| n.is_lowercase()).unwrap_or(false);
            let boundary_digit_alpha =
                (prev.is_ascii_digit() && c.is_alphabetic()) || (prev.is_alphabetic() && c.is_ascii_digit());

            if boundary_lower_to_upper || boundary_acronym_end || boundary_digit_alpha {
                words.push(std::mem::take(&mut current));
            }
        }
        current.push(c);
    }

    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn capitalize_word(w: &str) -> String {
    let mut chars = w.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut out = first.to_uppercase().to_string();
            out.push_str(&chars.as_str().to_lowercase());
            out
        }
    }
}

fn transform_each_line_case<F: Fn(&str) -> String>(content: &str, f: F) -> String {
    content
        .split('\n')
        .map(f)
        .collect::<Vec<_>>()
        .join("\n")
}

fn to_title_case(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut new_word = true;
    for c in line.chars() {
        if c.is_alphanumeric() {
            if new_word {
                out.push_str(&c.to_uppercase().to_string());
                new_word = false;
            } else {
                out.push_str(&c.to_lowercase().to_string());
            }
        } else {
            out.push(c);
            new_word = true;
        }
    }
    out
}

fn decode_base64_flexible(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD
        .decode(&cleaned)
        .or_else(|_| STANDARD_NO_PAD.decode(&cleaned))
        .or_else(|_| URL_SAFE.decode(&cleaned))
        .or_else(|_| URL_SAFE_NO_PAD.decode(&cleaned))
        .map_err(|e| format!("Invalid Base64 input: {}", e))
}

fn html_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn html_decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '&' {
            if let Some(rel_semi) = chars[i + 1..].iter().position(|&c| c == ';') {
                if rel_semi <= 12 {
                    let entity: String = chars[i + 1..i + 1 + rel_semi].iter().collect();
                    let decoded: Option<char> = match entity.as_str() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        "nbsp" => Some('\u{00A0}'),
                        s if s.starts_with("#x") || s.starts_with("#X") => {
                            u32::from_str_radix(&s[2..], 16).ok().and_then(char::from_u32)
                        }
                        s if s.starts_with('#') => {
                            s[1..].parse::<u32>().ok().and_then(char::from_u32)
                        }
                        _ => None,
                    };
                    if let Some(ch) = decoded {
                        out.push(ch);
                        i += rel_semi + 2;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn unicode_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{:04x}", unit));
            }
        }
    }
    out
}

fn unicode_unescape(input: &str) -> Result<String, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() && chars[i + 1] == 'u' {
            if i + 2 < chars.len() && chars[i + 2] == '{' {
                if let Some(end_brace) = chars[i + 3..].iter().position(|&c| c == '}') {
                    let hex_str: String = chars[i + 3..i + 3 + end_brace].iter().collect();
                    let code = u32::from_str_radix(&hex_str, 16)
                        .map_err(|_| format!("Invalid unicode escape: \\u{{{}}}", hex_str))?;
                    let ch = char::from_u32(code)
                        .ok_or_else(|| format!("Invalid unicode codepoint: U+{:X}", code))?;
                    out.push(ch);
                    i = i + 4 + end_brace;
                    continue;
                }
            } else if i + 5 < chars.len() {
                let hex_str: String = chars[i + 2..i + 6].iter().collect();
                let u1 = u16::from_str_radix(&hex_str, 16)
                    .map_err(|_| format!("Invalid unicode escape: \\u{}", hex_str))?;
                // Check UTF-16 surrogate pair
                if (0xD800..=0xDBFF).contains(&u1)
                    && i + 11 < chars.len()
                    && chars[i + 6] == '\\'
                    && chars[i + 7] == 'u'
                {
                    let hex2: String = chars[i + 8..i + 12].iter().collect();
                    if let Ok(u2) = u16::from_str_radix(&hex2, 16) {
                        if (0xDC00..=0xDFFF).contains(&u2) {
                            let combined =
                                0x10000 + (((u1 as u32 - 0xD800) << 10) | (u2 as u32 - 0xDC00));
                            if let Some(ch) = char::from_u32(combined) {
                                out.push(ch);
                                i += 12;
                                continue;
                            }
                        }
                    }
                }
                let ch = char::from_u32(u1 as u32)
                    .ok_or_else(|| format!("Invalid unicode scalar: \\u{}", hex_str))?;
                out.push(ch);
                i += 6;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    Ok(out)
}

fn decode_jwt(input: &str) -> Result<String, String> {
    let token = input.trim().strip_prefix("Bearer ").unwrap_or(input.trim());
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return Err("JWT must have 2 or 3 dot-separated segments (header.payload.signature)".to_string());
    }

    let header_bytes = decode_base64_flexible(parts[0])
        .map_err(|e| format!("Failed to decode JWT header: {}", e))?;
    let payload_bytes = decode_base64_flexible(parts[1])
        .map_err(|e| format!("Failed to decode JWT payload: {}", e))?;

    let header_val: Value = serde_json::from_slice(&header_bytes)
        .map_err(|e| format!("JWT header is not valid JSON: {}", e))?;
    let payload_val: Value = serde_json::from_slice(&payload_bytes)
        .map_err(|e| format!("JWT payload is not valid JSON: {}", e))?;

    let mut result = Map::new();
    result.insert("header".to_string(), header_val);
    result.insert("payload".to_string(), payload_val.clone());
    if parts.len() == 3 {
        result.insert("signature".to_string(), Value::String(parts[2].to_string()));
    }

    // Add human-readable timestamps if present
    let mut meta = Map::new();
    if let Value::Object(obj) = &payload_val {
        for key in ["iat", "nbf", "exp"] {
            if let Some(ts) = obj.get(key).and_then(|v| v.as_i64()) {
                if let Some(dt) = Utc.timestamp_opt(ts, 0).single() {
                    meta.insert(format!("{}_iso", key), Value::String(dt.to_rfc3339()));
                    if key == "exp" {
                        meta.insert("is_expired".to_string(), Value::Bool(dt < Utc::now()));
                    }
                }
            }
        }
    }
    if !meta.is_empty() {
        result.insert("timestamps".to_string(), Value::Object(meta));
    }

    serde_json::to_string_pretty(&Value::Object(result)).map_err(|e| e.to_string())
}

fn sort_json_keys_recursive(val: Value) -> Value {
    match val {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k, sort_json_keys_recursive(v));
            }
            let mut out = Map::new();
            for (k, v) in sorted {
                out.insert(k, v);
            }
            Value::Object(out)
        }
        Value::Array(arr) => {
            Value::Array(arr.into_iter().map(sort_json_keys_recursive).collect())
        }
        other => other,
    }
}

#[tauri::command]
pub fn transform_text(content: String, op: String, arg: Option<String>) -> TransformResult {
    let op_norm = op.trim().to_ascii_lowercase();
    match op_norm.as_str() {
        // ---- Line Operations ----
        "sort_asc" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.sort();
            TransformResult::success(lines.join("\n"), Some(format!("Sorted {} lines A-Z", n)))
        }
        "sort_desc" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.sort_by(|a, b| b.cmp(a));
            TransformResult::success(lines.join("\n"), Some(format!("Sorted {} lines Z-A", n)))
        }
        "sort_ci_asc" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
            TransformResult::success(
                lines.join("\n"),
                Some(format!("Sorted {} lines (case-insensitive)", n)),
            )
        }
        "sort_numeric_asc" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.sort_by(|a, b| match (extract_leading_number(a), extract_leading_number(b)) {
                (Some(x), Some(y)) => x.total_cmp(&y).then_with(|| a.cmp(b)),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.cmp(b),
            });
            TransformResult::success(
                lines.join("\n"),
                Some(format!("Sorted {} lines numerically ascending", n)),
            )
        }
        "sort_numeric_desc" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.sort_by(|a, b| match (extract_leading_number(a), extract_leading_number(b)) {
                (Some(x), Some(y)) => y.total_cmp(&x).then_with(|| b.cmp(a)),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => b.cmp(a),
            });
            TransformResult::success(
                lines.join("\n"),
                Some(format!("Sorted {} lines numerically descending", n)),
            )
        }
        "sort_length_asc" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.sort_by(|a, b| a.chars().count().cmp(&b.chars().count()).then_with(|| a.cmp(b)));
            TransformResult::success(
                lines.join("\n"),
                Some(format!("Sorted {} lines by length", n)),
            )
        }
        "dedupe_lines" => {
            let lines = split_lines_owned(&content);
            let total = lines.len();
            let mut seen = HashSet::new();
            let mut out = Vec::with_capacity(total);
            for line in lines {
                if seen.insert(line.clone()) {
                    out.push(line);
                }
            }
            let removed = total - out.len();
            TransformResult::success(
                out.join("\n"),
                Some(format!("Removed {} duplicate line(s)", removed)),
            )
        }
        "remove_empty_lines" => {
            let lines = split_lines_owned(&content);
            let total = lines.len();
            let out: Vec<String> = lines.into_iter().filter(|l| !l.is_empty()).collect();
            let removed = total - out.len();
            TransformResult::success(
                out.join("\n"),
                Some(format!("Removed {} empty line(s)", removed)),
            )
        }
        "remove_blank_lines" => {
            let lines = split_lines_owned(&content);
            let total = lines.len();
            let out: Vec<String> = lines.into_iter().filter(|l| !l.trim().is_empty()).collect();
            let removed = total - out.len();
            TransformResult::success(
                out.join("\n"),
                Some(format!("Removed {} blank line(s)", removed)),
            )
        }
        "trim_trailing" => {
            let out = content
                .split('\n')
                .map(|l| l.trim_end())
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some("Trimmed trailing whitespace".to_string()))
        }
        "trim_leading" => {
            let out = content
                .split('\n')
                .map(|l| l.trim_start())
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some("Trimmed leading whitespace".to_string()))
        }
        "trim_both" => {
            let out = content
                .split('\n')
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some("Trimmed leading & trailing whitespace".to_string()))
        }
        "reverse_lines" => {
            let mut lines = split_lines_owned(&content);
            let n = lines.len();
            lines.reverse();
            TransformResult::success(lines.join("\n"), Some(format!("Reversed {} lines", n)))
        }
        "join_lines" => {
            let sep = arg.unwrap_or_else(|| " ".to_string());
            let lines = split_lines_owned(&content);
            let n = lines.len();
            TransformResult::success(lines.join(&sep), Some(format!("Joined {} lines", n)))
        }
        "number_lines" => {
            let lines = split_lines_owned(&content);
            let total = lines.len();
            let width = total.max(1).to_string().len();
            let out = lines
                .into_iter()
                .enumerate()
                .map(|(i, l)| format!("{:>width$}: {}", i + 1, l, width = width))
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some(format!("Numbered {} lines", total)))
        }
        "filter_keep_regex" => {
            let pattern = arg.unwrap_or_default();
            let re = match build_safe_regex(&pattern) {
                Ok(r) => r,
                Err(e) => return TransformResult::err(e),
            };
            let lines = split_lines_owned(&content);
            let total = lines.len();
            let out: Vec<String> = lines.into_iter().filter(|l| re.is_match(l)).collect();
            let kept = out.len();
            TransformResult::success(out.join("\n"), Some(format!("Kept {} of {} lines", kept, total)))
        }
        "filter_remove_regex" => {
            let pattern = arg.unwrap_or_default();
            let re = match build_safe_regex(&pattern) {
                Ok(r) => r,
                Err(e) => return TransformResult::err(e),
            };
            let lines = split_lines_owned(&content);
            let total = lines.len();
            let out: Vec<String> = lines.into_iter().filter(|l| !re.is_match(l)).collect();
            let removed = total - out.len();
            TransformResult::success(
                out.join("\n"),
                Some(format!("Removed {} of {} lines", removed, total)),
            )
        }
        "add_prefix" => {
            let prefix = arg.unwrap_or_default();
            let lines = split_lines_owned(&content);
            let n = lines.len();
            let out = lines
                .into_iter()
                .map(|l| format!("{}{}", prefix, l))
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some(format!("Prefixed {} lines", n)))
        }
        "add_suffix" => {
            let suffix = arg.unwrap_or_default();
            let lines = split_lines_owned(&content);
            let n = lines.len();
            let out = lines
                .into_iter()
                .map(|l| format!("{}{}", l, suffix))
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some(format!("Suffixed {} lines", n)))
        }

        // ---- Case Operations ----
        "upper" => TransformResult::success(content.to_uppercase(), None),
        "lower" => TransformResult::success(content.to_lowercase(), None),
        "title" => TransformResult::success(transform_each_line_case(&content, to_title_case), None),
        "camel" => {
            let out = transform_each_line_case(&content, |line| {
                let words = split_identifier_words(line);
                if words.is_empty() {
                    return String::new();
                }
                let mut res = words[0].to_lowercase();
                for w in &words[1..] {
                    res.push_str(&capitalize_word(w));
                }
                res
            });
            TransformResult::success(out, None)
        }
        "pascal" => {
            let out = transform_each_line_case(&content, |line| {
                split_identifier_words(line)
                    .iter()
                    .map(|w| capitalize_word(w))
                    .collect::<Vec<_>>()
                    .join("")
            });
            TransformResult::success(out, None)
        }
        "snake" => {
            let out = transform_each_line_case(&content, |line| {
                split_identifier_words(line)
                    .iter()
                    .map(|w| w.to_lowercase())
                    .collect::<Vec<_>>()
                    .join("_")
            });
            TransformResult::success(out, None)
        }
        "kebab" => {
            let out = transform_each_line_case(&content, |line| {
                split_identifier_words(line)
                    .iter()
                    .map(|w| w.to_lowercase())
                    .collect::<Vec<_>>()
                    .join("-")
            });
            TransformResult::success(out, None)
        }
        "screaming_snake" => {
            let out = transform_each_line_case(&content, |line| {
                split_identifier_words(line)
                    .iter()
                    .map(|w| w.to_uppercase())
                    .collect::<Vec<_>>()
                    .join("_")
            });
            TransformResult::success(out, None)
        }
        "invert_case" => {
            let out: String = content
                .chars()
                .map(|c| {
                    if c.is_uppercase() {
                        c.to_lowercase().to_string()
                    } else if c.is_lowercase() {
                        c.to_uppercase().to_string()
                    } else {
                        c.to_string()
                    }
                })
                .collect();
            TransformResult::success(out, None)
        }

        // ---- Web / Crypto / Encoding Operations ----
        "base64_encode" => {
            let encoded = STANDARD.encode(content.as_bytes());
            TransformResult::success(
                encoded.clone(),
                Some(format!("Encoded {} bytes -> {} chars", content.len(), encoded.len())),
            )
        }
        "base64_decode" => match decode_base64_flexible(&content) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => TransformResult::success(s, Some("Decoded Base64 UTF-8".to_string())),
                Err(e) => TransformResult::err(format!("Decoded bytes are not valid UTF-8: {}", e)),
            },
            Err(e) => TransformResult::err(e),
        },
        "url_encode" => {
            let encoded = urlencoding::encode(&content).into_owned();
            TransformResult::success(encoded, None)
        }
        "url_decode" => match urlencoding::decode(&content) {
            Ok(cow) => TransformResult::success(cow.into_owned(), None),
            Err(e) => TransformResult::err(format!("Invalid URL encoding: {}", e)),
        },
        "html_encode" => TransformResult::success(html_encode(&content), None),
        "html_decode" => TransformResult::success(html_decode(&content), None),
        "hex_encode" => {
            let encoded = hex::encode(content.as_bytes());
            TransformResult::success(
                encoded.clone(),
                Some(format!("{} bytes -> {} hex chars", content.len(), encoded.len())),
            )
        }
        "hex_decode" => {
            let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
            let stripped = cleaned.strip_prefix("0x").or_else(|| cleaned.strip_prefix("0X")).unwrap_or(&cleaned);
            match hex::decode(stripped) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(s) => TransformResult::success(s, Some("Decoded Hex UTF-8".to_string())),
                    Err(e) => TransformResult::err(format!("Decoded hex is not valid UTF-8: {}", e)),
                },
                Err(e) => TransformResult::err(format!("Invalid hex input: {}", e)),
            }
        }
        "unicode_escape" => TransformResult::success(unicode_escape(&content), None),
        "unicode_unescape" => match unicode_unescape(&content) {
            Ok(s) => TransformResult::success(s, None),
            Err(e) => TransformResult::err(e),
        },
        "json_escape" => match serde_json::to_string(&content) {
            Ok(quoted) => {
                // Return inner escaped string (without outer quotes)
                let inner = &quoted[1..quoted.len() - 1];
                TransformResult::success(inner.to_string(), None)
            }
            Err(e) => TransformResult::err(e.to_string()),
        },
        "json_unescape" => {
            let trimmed = content.trim();
            let parsed = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
                serde_json::from_str::<String>(trimmed)
            } else {
                serde_json::from_str::<String>(&format!("\"{}\"", content))
            };
            match parsed {
                Ok(s) => TransformResult::success(s, None),
                Err(e) => TransformResult::err(format!("Invalid JSON escape sequence: {}", e)),
            }
        }
        "jwt_decode" => match decode_jwt(&content) {
            Ok(s) => TransformResult::success(s, Some("Decoded JWT".to_string())),
            Err(e) => TransformResult::err(e),
        },
        "hash_md5" => {
            let digest = Md5::digest(content.as_bytes());
            TransformResult::success(hex::encode(digest), Some("MD5 (128-bit)".to_string()))
        }
        "hash_sha1" => {
            let digest = Sha1::digest(content.as_bytes());
            TransformResult::success(hex::encode(digest), Some("SHA-1 (160-bit)".to_string()))
        }
        "hash_sha256" => {
            let digest = Sha256::digest(content.as_bytes());
            TransformResult::success(hex::encode(digest), Some("SHA-256 (256-bit)".to_string()))
        }
        "hash_sha512" => {
            let digest = Sha512::digest(content.as_bytes());
            TransformResult::success(hex::encode(digest), Some("SHA-512 (512-bit)".to_string()))
        }
        "gen_uuid" => {
            let count = arg
                .as_deref()
                .and_then(|s| s.trim().parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, 100);
            let out = (0..count)
                .map(|_| Uuid::new_v4().to_string())
                .collect::<Vec<_>>()
                .join("\n");
            TransformResult::success(out, Some(format!("Generated {} UUID v4", count)))
        }
        "timestamp_to_iso" => {
            let trimmed = content.trim();
            let dt = if trimmed.is_empty() {
                Utc::now()
            } else {
                let raw: i64 = match trimmed.parse() {
                    Ok(n) => n,
                    Err(_) => {
                        return TransformResult::err(format!(
                            "Invalid Unix timestamp: '{}'",
                            trimmed
                        ));
                    }
                };
                if raw.abs() >= 1_000_000_000_000 {
                    match Utc.timestamp_millis_opt(raw).single() {
                        Some(d) => d,
                        None => return TransformResult::err("Timestamp out of range"),
                    }
                } else {
                    match Utc.timestamp_opt(raw, 0).single() {
                        Some(d) => d,
                        None => return TransformResult::err("Timestamp out of range"),
                    }
                }
            };
            TransformResult::success(dt.to_rfc3339(), Some("UTC ISO-8601".to_string()))
        }
        "iso_to_timestamp" => {
            let trimmed = content.trim();
            let dt: DateTime<Utc> = if trimmed.is_empty() {
                Utc::now()
            } else if let Ok(fixed) = DateTime::parse_from_rfc3339(trimmed) {
                fixed.with_timezone(&Utc)
            } else if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
                Utc.from_utc_datetime(&naive)
            } else if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S") {
                Utc.from_utc_datetime(&naive)
            } else if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
                match date.and_hms_opt(0, 0, 0) {
                    Some(ndt) => Utc.from_utc_datetime(&ndt),
                    None => return TransformResult::err("Invalid date"),
                }
            } else {
                return TransformResult::err(format!("Could not parse ISO date/time: '{}'", trimmed));
            };
            TransformResult::success(
                dt.timestamp().to_string(),
                Some(format!("{} ms", dt.timestamp_millis())),
            )
        }
        "json_sort_keys" => match serde_json::from_str::<Value>(&content) {
            Ok(val) => {
                let sorted = sort_json_keys_recursive(val);
                match serde_json::to_string_pretty(&sorted) {
                    Ok(s) => TransformResult::success(s, Some("Sorted JSON keys alphabetically".to_string())),
                    Err(e) => TransformResult::err(e.to_string()),
                }
            }
            Err(e) => TransformResult::err(format!("Invalid JSON at line {} col {}: {}", e.line(), e.column(), e)),
        },
        other => TransformResult::err(format!("Unknown transform operation: {}", other)),
    }
}

#[tauri::command]
pub fn compute_diff(left: String, right: String) -> DiffResult {
    let diff = TextDiff::from_lines(&left, &right);
    let mut hunks = Vec::new();
    let mut additions = 0usize;
    let mut deletions = 0usize;

    for change in diff.iter_all_changes() {
        let kind = match change.tag() {
            ChangeTag::Equal => "equal",
            ChangeTag::Insert => {
                additions += 1;
                "insert"
            }
            ChangeTag::Delete => {
                deletions += 1;
                "delete"
            }
        };
        let raw_text = change.value();
        let text = raw_text
            .strip_suffix("\r\n")
            .or_else(|| raw_text.strip_suffix('\n'))
            .unwrap_or(raw_text)
            .to_string();

        hunks.push(DiffLine {
            kind: kind.to_string(),
            left_line: change.old_index().map(|i| i + 1),
            right_line: change.new_index().map(|i| i + 1),
            text,
        });
    }

    DiffResult {
        hunks,
        additions,
        deletions,
    }
}

#[tauri::command]
pub fn compute_stats(content: String) -> DocStats {
    let bytes = content.len();
    let chars = content.chars().count();
    let words = content.split_whitespace().count();
    let lines = if content.is_empty() {
        0
    } else {
        content.split('\n').count()
    };
    let non_empty_lines = content
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .count();
    let reading_time_sec = if words == 0 {
        0
    } else {
        ((words as f64 / 200.0) * 60.0).ceil() as usize
    };

    DocStats {
        bytes,
        chars,
        words,
        lines,
        non_empty_lines,
        reading_time_sec,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_line_ops_and_regex_filter() {
        let text = "10 apples\n2 bananas\n2 bananas\n\n   \n100 cherries";

        let dedup = transform_text(text.to_string(), "dedupe_lines".to_string(), None);
        assert!(dedup.ok);
        assert_eq!(dedup.output.matches("2 bananas").count(), 1);

        let no_blank = transform_text(text.to_string(), "remove_blank_lines".to_string(), None);
        assert!(no_blank.ok);
        assert_eq!(no_blank.output.split('\n').count(), 4);

        let num_sort = transform_text(no_blank.output.clone(), "sort_numeric_asc".to_string(), None);
        assert!(num_sort.ok);
        assert!(num_sort.output.starts_with("2 bananas"));
        assert!(num_sort.output.ends_with("100 cherries"));

        let keep = transform_text(
            no_blank.output.clone(),
            "filter_keep_regex".to_string(),
            Some("apples|cherries".to_string()),
        );
        assert!(keep.ok);
        assert_eq!(keep.output, "10 apples\n100 cherries");

        let remove = transform_text(
            no_blank.output,
            "filter_remove_regex".to_string(),
            Some("bananas".to_string()),
        );
        assert!(remove.ok);
        assert_eq!(remove.output, "10 apples\n100 cherries");

        let prefixed = transform_text("a\nb".to_string(), "add_prefix".to_string(), Some("- ".to_string()));
        assert_eq!(prefixed.output, "- a\n- b");
        let suffixed = transform_text(prefixed.output, "add_suffix".to_string(), Some(";".to_string()));
        assert_eq!(suffixed.output, "- a;\n- b;");
    }

    #[test]
    fn test_case_conversions() {
        assert_eq!(
            transform_text("myHTTPServer_name".to_string(), "snake".to_string(), None).output,
            "my_http_server_name"
        );
        assert_eq!(
            transform_text("my_http_server".to_string(), "camel".to_string(), None).output,
            "myHttpServer"
        );
        assert_eq!(
            transform_text("my-http-server".to_string(), "pascal".to_string(), None).output,
            "MyHttpServer"
        );
        assert_eq!(
            transform_text("MyHttpServer".to_string(), "kebab".to_string(), None).output,
            "my-http-server"
        );
        assert_eq!(
            transform_text("MyHttpServer".to_string(), "screaming_snake".to_string(), None).output,
            "MY_HTTP_SERVER"
        );
        assert_eq!(
            transform_text("AbC!".to_string(), "invert_case".to_string(), None).output,
            "aBc!"
        );
    }

    #[test]
    fn test_web_crypto_jwt_and_timestamps() {
        // Base64
        let b64 = transform_text("Kunai Editor".to_string(), "base64_encode".to_string(), None);
        assert!(b64.ok);
        let b64_dec = transform_text(b64.output, "base64_decode".to_string(), None);
        assert_eq!(b64_dec.output, "Kunai Editor");

        // URL & HTML & Hex & Unicode & JSON escape
        let url = transform_text("a b&c=1".to_string(), "url_encode".to_string(), None);
        assert_eq!(transform_text(url.output, "url_decode".to_string(), None).output, "a b&c=1");

        let html = transform_text("<div a=\"1\">'x' & y</div>".to_string(), "html_encode".to_string(), None);
        assert_eq!(
            transform_text(html.output, "html_decode".to_string(), None).output,
            "<div a=\"1\">'x' & y</div>"
        );

        let hex_e = transform_text("hi".to_string(), "hex_encode".to_string(), None);
        assert_eq!(hex_e.output, "6869");
        assert_eq!(transform_text(hex_e.output, "hex_decode".to_string(), None).output, "hi");

        let uni = transform_text("café 🚀".to_string(), "unicode_escape".to_string(), None);
        assert!(uni.output.contains("\\u00e9"));
        assert_eq!(transform_text(uni.output, "unicode_unescape".to_string(), None).output, "café 🚀");

        let jesc = transform_text("line1\n\"quoted\"".to_string(), "json_escape".to_string(), None);
        assert_eq!(jesc.output, "line1\\n\\\"quoted\\\"");
        assert_eq!(
            transform_text(jesc.output, "json_unescape".to_string(), None).output,
            "line1\n\"quoted\""
        );

        // Hashes (known RFC/NIST vectors for "abc")
        assert_eq!(
            transform_text("abc".to_string(), "hash_md5".to_string(), None).output,
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            transform_text("abc".to_string(), "hash_sha1".to_string(), None).output,
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            transform_text("abc".to_string(), "hash_sha256".to_string(), None).output,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            transform_text("abc".to_string(), "hash_sha512".to_string(), None).output.len(),
            128
        );

        // JWT decode
        let hdr = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let pay = URL_SAFE_NO_PAD.encode(r#"{"sub":"42","name":"Kunai","iat":1700000000}"#);
        let jwt = format!("{}.{}.sig123", hdr, pay);
        let dec_jwt = transform_text(jwt, "jwt_decode".to_string(), None);
        assert!(dec_jwt.ok);
        assert!(dec_jwt.output.contains("\"name\": \"Kunai\""));
        assert!(dec_jwt.output.contains("\"iat_iso\""));

        // Timestamps
        let iso = transform_text("1700000000".to_string(), "timestamp_to_iso".to_string(), None);
        assert!(iso.ok);
        assert_eq!(iso.output, "2023-11-14T22:13:20+00:00");
        let ts = transform_text(iso.output, "iso_to_timestamp".to_string(), None);
        assert!(ts.ok);
        assert_eq!(ts.output, "1700000000");

        // JSON sort keys
        let sorted = transform_text(
            r#"{"z":1,"a":{"d":4,"b":2}}"#.to_string(),
            "json_sort_keys".to_string(),
            None,
        );
        assert!(sorted.ok);
        let a_idx = sorted.output.find("\"a\"").unwrap();
        let z_idx = sorted.output.find("\"z\"").unwrap();
        assert!(a_idx < z_idx);

        // UUID
        let uuid = transform_text(String::new(), "gen_uuid".to_string(), None);
        assert!(uuid.ok);
        assert_eq!(uuid.output.len(), 36);
    }

    #[test]
    fn test_diff_and_stats() {
        let diff = compute_diff("a\nb\nc\n".to_string(), "a\nb2\nc\nd\n".to_string());
        assert_eq!(diff.additions, 2);
        assert_eq!(diff.deletions, 1);
        assert!(diff.hunks.iter().any(|h| h.kind == "delete" && h.text == "b"));
        assert!(diff.hunks.iter().any(|h| h.kind == "insert" && h.text == "b2"));
        assert!(diff.hunks.iter().any(|h| h.kind == "insert" && h.text == "d"));

        let stats = compute_stats("Hello world\n\nSecond line".to_string());
        assert_eq!(stats.words, 4);
        assert_eq!(stats.lines, 3);
        assert_eq!(stats.non_empty_lines, 2);
        assert!(stats.reading_time_sec >= 1);
    }

    #[test]
    fn test_oversized_regex_rejected() {
        let keep = transform_text(
            "hello\nworld".to_string(),
            "filter_keep_regex".to_string(),
            Some("a{1000}{1000}".to_string()),
        );
        assert!(!keep.ok);
        assert!(keep.error.unwrap_or_default().contains("Invalid regex"));

        let remove = transform_text(
            "hello\nworld".to_string(),
            "filter_remove_regex".to_string(),
            Some("a{1000}{1000}".to_string()),
        );
        assert!(!remove.ok);
        assert!(remove.error.unwrap_or_default().contains("Invalid regex"));
    }
}

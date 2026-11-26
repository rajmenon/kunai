use quick_xml::events::Event;
use quick_xml::{Reader, Writer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Cursor;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FormatResult {
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
    pub error_line: Option<usize>,
    pub error_col: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub error: Option<String>,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

impl FormatResult {
    fn success(output: String) -> Self {
        Self {
            ok: true,
            output,
            error: None,
            error_line: None,
            error_col: None,
        }
    }

    fn err(msg: impl Into<String>, line: Option<usize>, col: Option<usize>) -> Self {
        Self {
            ok: false,
            output: String::new(),
            error: Some(msg.into()),
            error_line: line,
            error_col: col,
        }
    }
}

fn byte_offset_to_line_col(text: &str, byte_offset: usize) -> (usize, usize) {
    let clamped = byte_offset.min(text.len());
    // Walk char boundaries safely
    let mut safe_idx = clamped;
    while safe_idx > 0 && !text.is_char_boundary(safe_idx) {
        safe_idx -= 1;
    }
    let prefix = &text[..safe_idx];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let last_nl = prefix.rfind('\n').map(|p| p + 1).unwrap_or(0);
    let col = prefix[last_nl..].chars().count() + 1;
    (line, col)
}

fn make_indent_unit(indent: usize, use_tabs: bool) -> String {
    if use_tabs {
        "\t".to_string()
    } else {
        " ".repeat(indent.clamp(1, 16))
    }
}

fn format_json(content: &str, indent: usize, use_tabs: bool, minify: bool) -> FormatResult {
    let val: Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            return FormatResult::err(e.to_string(), Some(e.line()), Some(e.column()));
        }
    };

    if minify {
        match serde_json::to_string(&val) {
            Ok(s) => FormatResult::success(s),
            Err(e) => FormatResult::err(e.to_string(), None, None),
        }
    } else {
        let unit = make_indent_unit(indent, use_tabs);
        let mut buf = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(unit.as_bytes());
        let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
        match val.serialize(&mut ser) {
            Ok(()) => match String::from_utf8(buf) {
                Ok(s) => FormatResult::success(s),
                Err(e) => FormatResult::err(e.to_string(), None, None),
            },
            Err(e) => FormatResult::err(e.to_string(), None, None),
        }
    }
}

fn reindent_yaml_spaces(yaml: &str, indent: usize, use_tabs: bool) -> String {
    if !use_tabs && indent == 2 {
        return yaml.to_string();
    }
    let unit = make_indent_unit(indent, use_tabs);
    yaml.lines()
        .map(|line| {
            let leading = line.bytes().take_while(|&b| b == b' ').count();
            if leading > 0 {
                let levels = leading / 2;
                let rem = leading % 2;
                format!("{}{}{}", unit.repeat(levels), " ".repeat(rem), &line[leading..])
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_yaml(content: &str, indent: usize, use_tabs: bool, minify: bool) -> FormatResult {
    let val: serde_yaml::Value = match serde_yaml::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            let (line, col) = e
                .location()
                .map(|loc| (Some(loc.line()), Some(loc.column())))
                .unwrap_or((None, None));
            return FormatResult::err(e.to_string(), line, col);
        }
    };

    if minify {
        match serde_json::to_string(&val) {
            Ok(s) => FormatResult::success(s),
            Err(e) => FormatResult::err(e.to_string(), None, None),
        }
    } else {
        match serde_yaml::to_string(&val) {
            Ok(s) => FormatResult::success(reindent_yaml_spaces(s.trim_end(), indent, use_tabs)),
            Err(e) => FormatResult::err(e.to_string(), None, None),
        }
    }
}

fn format_toml(content: &str, minify: bool) -> FormatResult {
    let val: toml::Value = match toml::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            let (line, col) = e
                .span()
                .map(|span| {
                    let (l, c) = byte_offset_to_line_col(content, span.start);
                    (Some(l), Some(c))
                })
                .unwrap_or((None, None));
            return FormatResult::err(e.message().to_string(), line, col);
        }
    };

    let res = if minify {
        toml::to_string(&val).map(|s| {
            s.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
    } else {
        toml::to_string_pretty(&val)
    };

    match res {
        Ok(s) => FormatResult::success(s.trim_end().to_string()),
        Err(e) => FormatResult::err(e.to_string(), None, None),
    }
}

fn format_xml(content: &str, indent: usize, use_tabs: bool, minify: bool) -> FormatResult {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);
    reader.config_mut().check_end_names = true;

    let mut out_buf: Vec<u8> = Vec::new();
    let indent_char = if use_tabs { b'\t' } else { b' ' };
    let indent_size = if use_tabs { 1 } else { indent.clamp(1, 16) };

    let mut writer_pretty = if !minify {
        Some(Writer::new_with_indent(
            Cursor::new(&mut out_buf),
            indent_char,
            indent_size,
        ))
    } else {
        None
    };

    let mut min_buf: Vec<u8> = Vec::new();
    let mut writer_min = if minify {
        Some(Writer::new(Cursor::new(&mut min_buf)))
    } else {
        None
    };

    let mut depth: usize = 0;

    loop {
        match reader.read_event() {
            Ok(Event::Eof) => {
                if depth != 0 {
                    let (line, col) = byte_offset_to_line_col(content, content.len());
                    return FormatResult::err(
                        "Unexpected end of XML document: unclosed tag",
                        Some(line),
                        Some(col),
                    );
                }
                break;
            }
            Ok(ev) => {
                match &ev {
                    Event::Start(_) => depth += 1,
                    Event::End(_) => {
                        if depth == 0 {
                            let pos = reader.error_position() as usize;
                            let (line, col) = byte_offset_to_line_col(content, pos);
                            return FormatResult::err(
                                "Unexpected closing XML tag",
                                Some(line),
                                Some(col),
                            );
                        }
                        depth -= 1;
                    }
                    _ => {}
                }
                let write_res = if let Some(w) = writer_pretty.as_mut() {
                    w.write_event(ev)
                } else if let Some(w) = writer_min.as_mut() {
                    w.write_event(ev)
                } else {
                    Ok(())
                };
                if let Err(e) = write_res {
                    return FormatResult::err(e.to_string(), None, None);
                }
            }
            Err(e) => {
                let pos = reader.error_position() as usize;
                let (line, col) = byte_offset_to_line_col(content, pos);
                return FormatResult::err(e.to_string(), Some(line), Some(col));
            }
        }
    }

    drop(writer_pretty);
    drop(writer_min);
    let final_bytes = if minify { min_buf } else { out_buf };
    match String::from_utf8(final_bytes) {
        Ok(s) => FormatResult::success(s),
        Err(e) => FormatResult::err(e.to_string(), None, None),
    }
}

fn is_html_void_tag(tag_name: &str) -> bool {
    matches!(
        tag_name.to_ascii_lowercase().as_str(),
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn extract_tag_name(tag: &str) -> String {
    let trimmed = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start();
    trimmed
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ':')
        .collect()
}

fn format_html(content: &str, indent: usize, use_tabs: bool, minify: bool) -> FormatResult {
    let unit = make_indent_unit(indent, use_tabs);
    let mut tokens: Vec<String> = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '<' {
            let start = i;
            let mut in_quote: Option<char> = None;
            // Handle comments <!-- ... -->
            if content[chars[..i].iter().map(|c| c.len_utf8()).sum::<usize>()..].starts_with("<!--")
            {
                i += 4;
                while i + 2 < chars.len()
                    && !(chars[i] == '-' && chars[i + 1] == '-' && chars[i + 2] == '>')
                {
                    i += 1;
                }
                i = (i + 3).min(chars.len());
                tokens.push(chars[start..i].iter().collect());
                continue;
            }
            while i < chars.len() {
                let c = chars[i];
                if let Some(q) = in_quote {
                    if c == q {
                        in_quote = None;
                    }
                } else if c == '"' || c == '\'' {
                    in_quote = Some(c);
                } else if c == '>' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
        } else {
            let start = i;
            while i < chars.len() && chars[i] != '<' {
                i += 1;
            }
            let text: String = chars[start..i].iter().collect();
            let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !collapsed.is_empty() {
                tokens.push(collapsed);
            }
        }
    }

    if minify {
        let mut out = String::new();
        for tok in tokens {
            if tok.starts_with("<!--") {
                continue;
            }
            out.push_str(&tok);
        }
        return FormatResult::success(out);
    }

    let mut lines: Vec<String> = Vec::new();
    let mut depth: usize = 0;
    for tok in tokens {
        if tok.starts_with("</") {
            depth = depth.saturating_sub(1);
            lines.push(format!("{}{}", unit.repeat(depth), tok));
        } else if tok.starts_with("<!") || tok.starts_with("<?") {
            lines.push(format!("{}{}", unit.repeat(depth), tok));
        } else if tok.starts_with('<') {
            let tag_name = extract_tag_name(&tok);
            let self_closing = tok.ends_with("/>") || is_html_void_tag(&tag_name);
            lines.push(format!("{}{}", unit.repeat(depth), tok));
            if !self_closing {
                depth += 1;
            }
        } else {
            lines.push(format!("{}{}", unit.repeat(depth), tok));
        }
    }

    FormatResult::success(lines.join("\n"))
}

fn format_css(content: &str, indent: usize, use_tabs: bool, minify: bool) -> FormatResult {
    let unit = make_indent_unit(indent, use_tabs);
    let chars: Vec<char> = content.chars().collect();
    let mut out = String::new();
    let mut depth: usize = 0;
    let mut i = 0;
    let mut in_string: Option<char> = None;
    let mut line_start = true;

    while i < chars.len() {
        let c = chars[i];

        if let Some(q) = in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                i += 1;
                out.push(chars[i]);
            } else if c == q {
                in_string = None;
            }
            i += 1;
            continue;
        }

        // CSS comments /* ... */
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            let start = i;
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            if !minify {
                if line_start {
                    out.push_str(&unit.repeat(depth));
                }
                let comment: String = chars[start..i].iter().collect();
                out.push_str(&comment);
                out.push('\n');
                line_start = true;
            }
            continue;
        }

        if c == '"' || c == '\'' {
            if !minify && line_start {
                out.push_str(&unit.repeat(depth));
                line_start = false;
            }
            in_string = Some(c);
            out.push(c);
            i += 1;
            continue;
        }

        if c.is_whitespace() {
            if !line_start && !out.ends_with(' ') && !out.ends_with('{') && !out.ends_with(':') {
                out.push(' ');
            }
            i += 1;
            continue;
        }

        match c {
            '{' => {
                while out.ends_with(' ') {
                    out.pop();
                }
                if minify {
                    out.push('{');
                } else {
                    out.push_str(" {\n");
                    depth += 1;
                    line_start = true;
                }
            }
            '}' => {
                while out.ends_with(' ') {
                    out.pop();
                }
                if minify {
                    if out.ends_with(';') {
                        out.pop();
                    }
                    out.push('}');
                } else {
                    if !line_start {
                        out.push('\n');
                    }
                    depth = depth.saturating_sub(1);
                    out.push_str(&unit.repeat(depth));
                    out.push_str("}\n");
                    if depth == 0 {
                        out.push('\n');
                    }
                    line_start = true;
                }
            }
            ';' => {
                while out.ends_with(' ') {
                    out.pop();
                }
                if minify {
                    out.push(';');
                } else {
                    out.push_str(";\n");
                    line_start = true;
                }
            }
            ':' => {
                while out.ends_with(' ') {
                    out.pop();
                }
                if minify {
                    out.push(':');
                } else if depth > 0 {
                    out.push_str(": ");
                } else {
                    out.push(':');
                }
                line_start = false;
            }
            ',' => {
                while out.ends_with(' ') {
                    out.pop();
                }
                if minify {
                    out.push(',');
                } else if depth == 0 {
                    out.push_str(",\n");
                    line_start = true;
                } else {
                    out.push_str(", ");
                }
            }
            _ => {
                if !minify && line_start {
                    out.push_str(&unit.repeat(depth));
                    line_start = false;
                }
                out.push(c);
            }
        }
        i += 1;
    }

    FormatResult::success(out.trim().to_string())
}

fn format_sql(content: &str, indent: usize, use_tabs: bool, minify: bool) -> FormatResult {
    let unit = make_indent_unit(indent, use_tabs);
    let keywords = [
        "SELECT", "FROM", "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS",
        "ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "GROUP", "BY", "ORDER", "HAVING",
        "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
        "TABLE", "ALTER", "DROP", "DISTINCT", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE",
        "END", "LIKE", "BETWEEN", "EXISTS", "ASC", "DESC", "PRIMARY", "KEY", "DEFAULT", "INDEX",
    ];

    // Tokenize SQL preserving string literals and comments
    let chars: Vec<char> = content.chars().collect();
    let mut tokens: Vec<String> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // Single-quoted or double-quoted strings
        if c == '\'' || c == '"' {
            let q = c;
            let start = i;
            i += 1;
            while i < chars.len() {
                if chars[i] == q {
                    if i + 1 < chars.len() && chars[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
            continue;
        }
        // Line comment --
        if c == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
            let start = i;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            if !minify {
                tokens.push(chars[start..i].iter().collect());
            }
            continue;
        }
        // Punctuation
        if matches!(c, ',' | '(' | ')' | ';') {
            tokens.push(c.to_string());
            i += 1;
            continue;
        }
        // Word or operator
        let start = i;
        while i < chars.len()
            && !chars[i].is_whitespace()
            && !matches!(chars[i], ',' | '(' | ')' | ';' | '\'' | '"')
        {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        let upper = word.to_ascii_uppercase();
        if keywords.contains(&upper.as_str()) {
            tokens.push(upper);
        } else {
            tokens.push(word);
        }
    }

    if minify {
        let mut out = String::new();
        for (idx, tok) in tokens.iter().enumerate() {
            if idx > 0 && tok != "," && tok != ")" && tok != ";" && tokens[idx - 1] != "(" {
                out.push(' ');
            }
            out.push_str(tok);
        }
        return FormatResult::success(out);
    }

    let major_clauses = [
        "SELECT", "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "VALUES", "SET", "UNION",
        "INSERT", "UPDATE", "DELETE", "CREATE",
    ];
    let join_starters = ["JOIN", "LEFT", "RIGHT", "INNER", "FULL", "CROSS"];

    let mut out = String::new();
    let mut in_select = false;
    let mut i = 0;

    while i < tokens.len() {
        let tok = &tokens[i];
        let next = tokens.get(i + 1).map(String::as_str);

        if tok == ";" {
            out.push_str(";\n\n");
            in_select = false;
            i += 1;
            continue;
        }
        if tok == "," {
            out.push(',');
            if in_select {
                out.push('\n');
                out.push_str(&unit);
            } else {
                out.push(' ');
            }
            i += 1;
            continue;
        }
        if (tok == "GROUP" || tok == "ORDER") && next == Some("BY") {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(tok);
            out.push_str(" BY");
            in_select = false;
            i += 2;
            continue;
        }
        if major_clauses.contains(&tok.as_str()) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(tok);
            if tok == "SELECT" {
                in_select = true;
                out.push('\n');
                out.push_str(&unit);
            } else {
                in_select = false;
            }
            i += 1;
            continue;
        }
        if join_starters.contains(&tok.as_str())
            && (tok == "JOIN" || matches!(next, Some("JOIN") | Some("OUTER")))
        {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(tok);
            in_select = false;
            i += 1;
            continue;
        }
        if tok == "AND" || tok == "OR" {
            out.push('\n');
            out.push_str(&unit);
            out.push_str(tok);
            i += 1;
            continue;
        }
        if !out.is_empty()
            && !out.ends_with('\n')
            && !out.ends_with(&unit)
            && !out.ends_with('(')
            && tok != ")"
        {
            out.push(' ');
        }
        out.push_str(tok);
        i += 1;
    }

    FormatResult::success(out.trim().to_string())
}

pub fn parse_csv_rows(content: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_field = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if in_quotes {
            if c == '"' {
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    current_field.push('"');
                    i += 2;
                    continue;
                } else {
                    in_quotes = false;
                }
            } else {
                current_field.push(c);
            }
        } else {
            match c {
                '"' => {
                    if current_field.trim().is_empty() {
                        current_field.clear();
                        in_quotes = true;
                    } else {
                        current_field.push('"');
                    }
                }
                ',' => {
                    current_row.push(current_field.trim().to_string());
                    current_field.clear();
                }
                '\r' => {
                    if i + 1 < chars.len() && chars[i + 1] == '\n' {
                        i += 1;
                    }
                    current_row.push(current_field.trim().to_string());
                    current_field.clear();
                    rows.push(current_row);
                    current_row = Vec::new();
                }
                '\n' => {
                    current_row.push(current_field.trim().to_string());
                    current_field.clear();
                    rows.push(current_row);
                    current_row = Vec::new();
                }
                _ => current_field.push(c),
            }
        }
        i += 1;
    }

    if in_quotes {
        return Err("Unterminated quoted field in CSV".to_string());
    }

    if !current_field.is_empty() || !current_row.is_empty() {
        current_row.push(current_field.trim().to_string());
        rows.push(current_row);
    }

    // Drop completely empty trailing row
    while rows
        .last()
        .map(|r| r.len() == 1 && r[0].is_empty())
        .unwrap_or(false)
    {
        rows.pop();
    }

    Ok(rows)
}

fn escape_csv_field(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

fn format_csv(content: &str, minify: bool) -> FormatResult {
    let rows = match parse_csv_rows(content) {
        Ok(r) => r,
        Err(e) => return FormatResult::err(e, None, None),
    };
    if rows.is_empty() {
        return FormatResult::success(String::new());
    }

    if minify {
        let out = rows
            .iter()
            .map(|r| {
                r.iter()
                    .map(|f| escape_csv_field(f))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect::<Vec<_>>()
            .join("\n");
        return FormatResult::success(out);
    }

    // Align columns neatly for human readability
    let col_count = rows.iter().map(Vec::len).max().unwrap_or(0);
    let escaped: Vec<Vec<String>> = rows
        .iter()
        .map(|r| r.iter().map(|f| escape_csv_field(f)).collect())
        .collect();
    let mut widths = vec![0usize; col_count];
    for row in &escaped {
        for (idx, cell) in row.iter().enumerate() {
            widths[idx] = widths[idx].max(cell.chars().count());
        }
    }

    let out = escaped
        .iter()
        .map(|row| {
            let mut line = String::new();
            for (idx, cell) in row.iter().enumerate() {
                if idx > 0 {
                    line.push_str(", ");
                }
                line.push_str(cell);
                if idx + 1 < row.len() {
                    let pad = widths[idx].saturating_sub(cell.chars().count());
                    for _ in 0..pad {
                        line.push(' ');
                    }
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");

    FormatResult::success(out)
}

#[tauri::command]
pub fn format_document(
    content: String,
    format: String,
    indent: usize,
    use_tabs: bool,
    minify: bool,
) -> FormatResult {
    match format.trim().to_ascii_lowercase().as_str() {
        "json" => format_json(&content, indent, use_tabs, minify),
        "yaml" | "yml" => format_yaml(&content, indent, use_tabs, minify),
        "toml" => format_toml(&content, minify),
        "xml" | "svg" => format_xml(&content, indent, use_tabs, minify),
        "html" | "htm" => format_html(&content, indent, use_tabs, minify),
        "css" => format_css(&content, indent, use_tabs, minify),
        "sql" => format_sql(&content, indent, use_tabs, minify),
        "csv" => format_csv(&content, minify),
        other => FormatResult::err(format!("Unsupported format: {}", other), None, None),
    }
}

#[tauri::command]
pub fn validate_document(content: String, format: String) -> ValidationResult {
    match format.trim().to_ascii_lowercase().as_str() {
        "json" => match serde_json::from_str::<Value>(&content) {
            Ok(_) => ValidationResult {
                valid: true,
                error: None,
                line: None,
                column: None,
            },
            Err(e) => ValidationResult {
                valid: false,
                error: Some(e.to_string()),
                line: Some(e.line()),
                column: Some(e.column()),
            },
        },
        "yaml" | "yml" => match serde_yaml::from_str::<serde_yaml::Value>(&content) {
            Ok(_) => ValidationResult {
                valid: true,
                error: None,
                line: None,
                column: None,
            },
            Err(e) => {
                let (line, column) = e
                    .location()
                    .map(|l| (Some(l.line()), Some(l.column())))
                    .unwrap_or((None, None));
                ValidationResult {
                    valid: false,
                    error: Some(e.to_string()),
                    line,
                    column,
                }
            }
        },
        "toml" => match toml::from_str::<toml::Value>(&content) {
            Ok(_) => ValidationResult {
                valid: true,
                error: None,
                line: None,
                column: None,
            },
            Err(e) => {
                let (line, column) = e
                    .span()
                    .map(|span| {
                        let (l, c) = byte_offset_to_line_col(&content, span.start);
                        (Some(l), Some(c))
                    })
                    .unwrap_or((None, None));
                ValidationResult {
                    valid: false,
                    error: Some(e.message().to_string()),
                    line,
                    column,
                }
            }
        },
        "xml" | "svg" => {
            let mut reader = Reader::from_str(&content);
            reader.config_mut().check_end_names = true;
            let mut depth = 0usize;
            loop {
                match reader.read_event() {
                    Ok(Event::Eof) => {
                        if depth != 0 {
                            let (l, c) = byte_offset_to_line_col(&content, content.len());
                            return ValidationResult {
                                valid: false,
                                error: Some("Unclosed XML tag at end of document".to_string()),
                                line: Some(l),
                                column: Some(c),
                            };
                        }
                        return ValidationResult {
                            valid: true,
                            error: None,
                            line: None,
                            column: None,
                        };
                    }
                    Ok(Event::Start(_)) => depth += 1,
                    Ok(Event::End(_)) => {
                        if depth == 0 {
                            let pos = reader.error_position() as usize;
                            let (l, c) = byte_offset_to_line_col(&content, pos);
                            return ValidationResult {
                                valid: false,
                                error: Some("Unexpected closing XML tag".to_string()),
                                line: Some(l),
                                column: Some(c),
                            };
                        }
                        depth -= 1;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        let pos = reader.error_position() as usize;
                        let (l, c) = byte_offset_to_line_col(&content, pos);
                        return ValidationResult {
                            valid: false,
                            error: Some(e.to_string()),
                            line: Some(l),
                            column: Some(c),
                        };
                    }
                }
            }
        }
        other => ValidationResult {
            valid: false,
            error: Some(format!("Validation not supported for format: {}", other)),
            line: None,
            column: None,
        },
    }
}

fn parse_csv_cell_value(cell: &str) -> Value {
    if cell == "true" {
        return Value::Bool(true);
    }
    if cell == "false" {
        return Value::Bool(false);
    }
    if !cell.is_empty() && !(cell.starts_with('0') && cell.len() > 1 && !cell.starts_with("0.")) {
        if let Ok(i) = cell.parse::<i64>() {
            return Value::Number(i.into());
        }
        if let Ok(f) = cell.parse::<f64>() {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return Value::Number(n);
            }
        }
    }
    Value::String(cell.to_string())
}

fn json_to_toml_safe(val: &Value) -> Option<toml::Value> {
    match val {
        Value::Null => None,
        Value::Bool(b) => Some(toml::Value::Boolean(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(toml::Value::Integer(i))
            } else if let Some(u) = n.as_u64() {
                Some(toml::Value::Integer(u.min(i64::MAX as u64) as i64))
            } else {
                n.as_f64().map(toml::Value::Float)
            }
        }
        Value::String(s) => Some(toml::Value::String(s.clone())),
        Value::Array(arr) => {
            let items: Vec<toml::Value> = arr.iter().filter_map(json_to_toml_safe).collect();
            Some(toml::Value::Array(items))
        }
        Value::Object(map) => {
            let mut tbl = toml::map::Map::new();
            for (k, v) in map {
                if let Some(tv) = json_to_toml_safe(v) {
                    tbl.insert(k.clone(), tv);
                }
            }
            Some(toml::Value::Table(tbl))
        }
    }
}

fn json_scalar_to_csv(val: &Value) -> String {
    match val {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn json_value_to_csv(val: &Value) -> Result<String, String> {
    let rows_val: Vec<&Map<String, Value>> = match val {
        Value::Array(arr) => {
            let mut objs = Vec::with_capacity(arr.len());
            for item in arr {
                if let Value::Object(map) = item {
                    objs.push(map);
                } else {
                    return Err("CSV conversion requires an array of objects or a single object".to_string());
                }
            }
            objs
        }
        Value::Object(map) => {
            // If object has a single key wrapping an array of objects (e.g. from TOML [[items]]), unwrap it
            if map.len() == 1 {
                if let Some(Value::Array(arr)) = map.values().next() {
                    if !arr.is_empty() && arr.iter().all(|v| v.is_object()) {
                        let objs: Vec<&Map<String, Value>> =
                            arr.iter().filter_map(|v| v.as_object()).collect();
                        return serialize_object_rows_to_csv(&objs);
                    }
                }
            }
            vec![map]
        }
        _ => {
            return Err("CSV conversion requires an array of objects or a JSON object".to_string());
        }
    };

    serialize_object_rows_to_csv(&rows_val)
}

fn serialize_object_rows_to_csv(rows: &[&Map<String, Value>]) -> Result<String, String> {
    if rows.is_empty() {
        return Ok(String::new());
    }
    let mut headers: Vec<String> = Vec::new();
    for row in rows {
        for key in row.keys() {
            if !headers.contains(key) {
                headers.push(key.clone());
            }
        }
    }

    let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 1);
    lines.push(
        headers
            .iter()
            .map(|h| escape_csv_field(h))
            .collect::<Vec<_>>()
            .join(","),
    );

    for row in rows {
        let cells: Vec<String> = headers
            .iter()
            .map(|h| {
                row.get(h)
                    .map(json_scalar_to_csv)
                    .map(|s| escape_csv_field(&s))
                    .unwrap_or_default()
            })
            .collect();
        lines.push(cells.join(","));
    }

    Ok(lines.join("\n"))
}

#[tauri::command]
pub fn convert_format(content: String, from: String, to: String) -> FormatResult {
    let from_norm = from.trim().to_ascii_lowercase();
    let to_norm = to.trim().to_ascii_lowercase();

    // Parse source to serde_json::Value
    let value: Value = match from_norm.as_str() {
        "json" => match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => return FormatResult::err(e.to_string(), Some(e.line()), Some(e.column())),
        },
        "yaml" | "yml" => match serde_yaml::from_str::<Value>(&content) {
            Ok(v) => v,
            Err(e) => {
                let (l, c) = e
                    .location()
                    .map(|loc| (Some(loc.line()), Some(loc.column())))
                    .unwrap_or((None, None));
                return FormatResult::err(e.to_string(), l, c);
            }
        },
        "toml" => match toml::from_str::<toml::Value>(&content) {
            Ok(tv) => match serde_json::to_value(tv) {
                Ok(v) => v,
                Err(e) => return FormatResult::err(e.to_string(), None, None),
            },
            Err(e) => {
                let (l, c) = e
                    .span()
                    .map(|span| {
                        let (line, col) = byte_offset_to_line_col(&content, span.start);
                        (Some(line), Some(col))
                    })
                    .unwrap_or((None, None));
                return FormatResult::err(e.message().to_string(), l, c);
            }
        },
        "csv" => match parse_csv_rows(&content) {
            Ok(rows) => {
                if rows.is_empty() {
                    Value::Array(Vec::new())
                } else {
                    let headers = &rows[0];
                    let mut out = Vec::new();
                    for row in rows.iter().skip(1) {
                        let mut obj = Map::new();
                        for (idx, header) in headers.iter().enumerate() {
                            let cell = row.get(idx).map(String::as_str).unwrap_or("");
                            obj.insert(header.clone(), parse_csv_cell_value(cell));
                        }
                        out.push(Value::Object(obj));
                    }
                    Value::Array(out)
                }
            }
            Err(e) => return FormatResult::err(e, None, None),
        },
        other => return FormatResult::err(format!("Unsupported source format: {}", other), None, None),
    };

    // Serialize serde_json::Value to target format
    match to_norm.as_str() {
        "json" => match serde_json::to_string_pretty(&value) {
            Ok(s) => FormatResult::success(s),
            Err(e) => FormatResult::err(e.to_string(), None, None),
        },
        "yaml" | "yml" => match serde_yaml::to_string(&value) {
            Ok(s) => FormatResult::success(s.trim_end().to_string()),
            Err(e) => FormatResult::err(e.to_string(), None, None),
        },
        "toml" => {
            let root_val = match &value {
                Value::Object(_) => value.clone(),
                other => {
                    let mut wrapper = Map::new();
                    wrapper.insert("items".to_string(), other.clone());
                    Value::Object(wrapper)
                }
            };
            match json_to_toml_safe(&root_val) {
                Some(tv) => match toml::to_string_pretty(&tv) {
                    Ok(s) => FormatResult::success(s.trim_end().to_string()),
                    Err(e) => FormatResult::err(e.to_string(), None, None),
                },
                None => FormatResult::err("Cannot represent value as TOML", None, None),
            }
        }
        "csv" => match json_value_to_csv(&value) {
            Ok(s) => FormatResult::success(s),
            Err(e) => FormatResult::err(e, None, None),
        },
        other => FormatResult::err(format!("Unsupported target format: {}", other), None, None),
    }
}

#[derive(Debug, Clone)]
enum PathToken {
    Key(String),
    Index(isize),
    Wildcard,
    RecursiveKey(String),
}

fn parse_json_path(raw: &str) -> Result<(Vec<PathToken>, bool), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "$" {
        return Ok((Vec::new(), false));
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0;
    if chars[0] == '$' {
        i = 1;
    }

    let mut tokens = Vec::new();
    let mut has_wildcard = false;

    while i < chars.len() {
        match chars[i] {
            '.' => {
                // Check recursive descent ..
                if i + 1 < chars.len() && chars[i + 1] == '.' {
                    i += 2;
                    has_wildcard = true;
                    let start = i;
                    while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                        i += 1;
                    }
                    let key: String = chars[start..i].iter().collect();
                    if key.is_empty() {
                        return Err("Expected key after '..'".to_string());
                    }
                    tokens.push(PathToken::RecursiveKey(key));
                    continue;
                }
                i += 1;
                if i < chars.len() && chars[i] == '*' {
                    has_wildcard = true;
                    tokens.push(PathToken::Wildcard);
                    i += 1;
                } else {
                    let start = i;
                    while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                        i += 1;
                    }
                    let key: String = chars[start..i].iter().collect();
                    if key.is_empty() {
                        return Err("Empty path segment after '.'".to_string());
                    }
                    tokens.push(PathToken::Key(key));
                }
            }
            '[' => {
                i += 1;
                let start = i;
                let mut quote: Option<char> = None;
                while i < chars.len() {
                    let c = chars[i];
                    if let Some(q) = quote {
                        if c == q {
                            quote = None;
                        }
                    } else if c == '\'' || c == '"' {
                        quote = Some(c);
                    } else if c == ']' {
                        break;
                    }
                    i += 1;
                }
                if i >= chars.len() || chars[i] != ']' {
                    return Err("Unclosed '[' in JSON path".to_string());
                }
                let inner: String = chars[start..i].iter().collect();
                let inner_trim = inner.trim();
                i += 1;

                if inner_trim == "*" {
                    has_wildcard = true;
                    tokens.push(PathToken::Wildcard);
                } else if (inner_trim.starts_with('\'') && inner_trim.ends_with('\''))
                    || (inner_trim.starts_with('"') && inner_trim.ends_with('"'))
                {
                    if inner_trim.len() < 2 {
                        return Err("Empty quoted key in brackets".to_string());
                    }
                    tokens.push(PathToken::Key(inner_trim[1..inner_trim.len() - 1].to_string()));
                } else if let Ok(idx) = inner_trim.parse::<isize>() {
                    tokens.push(PathToken::Index(idx));
                } else {
                    return Err(format!("Invalid bracket selector: [{}]", inner_trim));
                }
            }
            _ => {
                let start = i;
                while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                    i += 1;
                }
                let key: String = chars[start..i].iter().collect();
                if key == "*" {
                    has_wildcard = true;
                    tokens.push(PathToken::Wildcard);
                } else {
                    tokens.push(PathToken::Key(key));
                }
            }
        }
    }

    Ok((tokens, has_wildcard))
}

fn collect_recursive<'a>(val: &'a Value, key: &str, acc: &mut Vec<&'a Value>) {
    match val {
        Value::Object(map) => {
            if let Some(found) = map.get(key) {
                acc.push(found);
            }
            for v in map.values() {
                collect_recursive(v, key, acc);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                collect_recursive(item, key, acc);
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub fn query_json(content: String, path: String) -> FormatResult {
    let root: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => return FormatResult::err(e.to_string(), Some(e.line()), Some(e.column())),
    };

    let (tokens, has_wildcard) = match parse_json_path(&path) {
        Ok(res) => res,
        Err(e) => return FormatResult::err(e, None, None),
    };

    let mut current: Vec<&Value> = vec![&root];

    for tok in &tokens {
        let mut next: Vec<&Value> = Vec::new();
        for val in current {
            match tok {
                PathToken::Key(k) => {
                    if let Value::Object(map) = val {
                        if let Some(child) = map.get(k) {
                            next.push(child);
                        }
                    }
                }
                PathToken::Index(idx) => {
                    if let Value::Array(arr) = val {
                        let resolved = if *idx < 0 {
                            arr.len().checked_sub(idx.unsigned_abs())
                        } else {
                            Some(*idx as usize)
                        };
                        if let Some(pos) = resolved {
                            if let Some(child) = arr.get(pos) {
                                next.push(child);
                            }
                        }
                    }
                }
                PathToken::Wildcard => match val {
                    Value::Array(arr) => next.extend(arr.iter()),
                    Value::Object(map) => next.extend(map.values()),
                    _ => {}
                },
                PathToken::RecursiveKey(k) => {
                    collect_recursive(val, k, &mut next);
                }
            }
        }
        current = next;
    }

    let result_value = if has_wildcard {
        Value::Array(current.into_iter().cloned().collect())
    } else {
        current.first().copied().cloned().unwrap_or(Value::Null)
    };

    match serde_json::to_string_pretty(&result_value) {
        Ok(s) => FormatResult::success(s),
        Err(e) => FormatResult::err(e.to_string(), None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_format_and_error_line_col() {
        let res = format_document(
            r#"{"a":1,"b":[2,3]}"#.to_string(),
            "json".to_string(),
            2,
            false,
            false,
        );
        assert!(res.ok);
        assert!(res.output.contains("  \"a\": 1"));

        let min = format_document(res.output, "json".to_string(), 2, false, true);
        assert!(min.ok);
        assert_eq!(min.output, r#"{"a":1,"b":[2,3]}"#);

        let bad = format_document("{\n  \"a\": 1,\n  \"b\": \n}".to_string(), "json".to_string(), 2, false, false);
        assert!(!bad.ok);
        assert_eq!(bad.error_line, Some(4));
        assert!(bad.error_col.is_some());
    }

    #[test]
    fn test_validate_json_yaml_toml_xml() {
        assert!(validate_document(r#"{"ok":true}"#.to_string(), "json".to_string()).valid);
        let bad_json = validate_document("{\n  \"x\": bad\n}".to_string(), "json".to_string());
        assert!(!bad_json.valid);
        assert_eq!(bad_json.line, Some(2));

        assert!(validate_document("name: kunai\nport: 8080".to_string(), "yaml".to_string()).valid);
        let bad_yaml = validate_document("a: [1, 2\nb: 3".to_string(), "yaml".to_string());
        assert!(!bad_yaml.valid);
        assert!(bad_yaml.line.is_some());

        assert!(validate_document("[server]\nport = 8080".to_string(), "toml".to_string()).valid);
        let bad_toml = validate_document("[server]\nport = ".to_string(), "toml".to_string());
        assert!(!bad_toml.valid);
        assert_eq!(bad_toml.line, Some(2));

        assert!(validate_document("<root><item id=\"1\">hi</item></root>".to_string(), "xml".to_string()).valid);
        let bad_xml = validate_document("<root>\n  <item>hi</wrong>\n</root>".to_string(), "xml".to_string());
        assert!(!bad_xml.valid);
        assert!(bad_xml.line.is_some());
    }

    #[test]
    fn test_conversions_json_yaml_toml_csv() {
        let csv_in = "name,port,enabled\napi,8080,true\nweb,3000,false";
        let to_json = convert_format(csv_in.to_string(), "csv".to_string(), "json".to_string());
        assert!(to_json.ok);
        assert!(to_json.output.contains("\"port\": 8080"));
        assert!(to_json.output.contains("\"enabled\": true"));

        let to_yaml = convert_format(to_json.output.clone(), "json".to_string(), "yaml".to_string());
        assert!(to_yaml.ok);
        assert!(to_yaml.output.contains("name: api"));

        let to_toml = convert_format(to_yaml.output.clone(), "yaml".to_string(), "toml".to_string());
        assert!(to_toml.ok);
        assert!(to_toml.output.contains("[[items]]"));

        let back_csv = convert_format(to_toml.output, "toml".to_string(), "csv".to_string());
        assert!(back_csv.ok);
        assert!(back_csv.output.contains("api"));
        assert!(back_csv.output.contains("3000"));
    }

    #[test]
    fn test_query_json_wildcards_and_paths() {
        let doc = r#"{
            "config": { "port": 1420 },
            "items": [
                { "name": "alpha", "score": 10 },
                { "name": "beta", "score": 20 }
            ]
        }"#;

        let q1 = query_json(doc.to_string(), "config.port".to_string());
        assert!(q1.ok);
        assert_eq!(q1.output, "1420");

        let q2 = query_json(doc.to_string(), "$.items[*].name".to_string());
        assert!(q2.ok);
        assert_eq!(
            serde_json::from_str::<Value>(&q2.output).unwrap(),
            serde_json::json!(["alpha", "beta"])
        );

        let q3 = query_json(doc.to_string(), "$.items[1].score".to_string());
        assert!(q3.ok);
        assert_eq!(q3.output, "20");

        let q4 = query_json(doc.to_string(), "$.items[-1].name".to_string());
        assert!(q4.ok);
        assert_eq!(q4.output, "\"beta\"");
    }

    #[test]
    fn test_xml_html_css_sql_csv_formatters() {
        let xml = format_document("<a ><b/></a>".to_string(), "xml".to_string(), 2, false, false);
        assert!(xml.ok);
        assert!(xml.output.contains('\n'));

        let html = format_document("<div><p>Hello</p><br></div>".to_string(), "html".to_string(), 2, false, false);
        assert!(html.ok);
        assert!(html.output.contains("  <p>"));

        let css = format_document("body{color:red;margin:0;}".to_string(), "css".to_string(), 2, false, false);
        assert!(css.ok);
        assert!(css.output.contains("  color: red;"));

        let sql = format_document("select id, name from users where active = 1 order by name".to_string(), "sql".to_string(), 2, false, false);
        assert!(sql.ok);
        assert!(sql.output.contains("SELECT"));
        assert!(sql.output.contains("FROM users"));

        let csv = format_document("a,b\n100,2".to_string(), "csv".to_string(), 2, false, false);
        assert!(csv.ok);
        assert!(csv.output.contains("a  , b"));
    }

    #[test]
    fn test_xml_xxe_and_billion_laughs_safe() {
        let xxe_xml = r#"<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<root><a attr="1">&lol2;</a><b>&xxe;</b></root>"#;

        let val = validate_document(xxe_xml.to_string(), "xml".to_string());
        assert!(val.valid, "Expected valid XML without entity expansion: {:?}", val.error);

        let fmt = format_document(xxe_xml.to_string(), "xml".to_string(), 2, false, false);
        assert!(fmt.ok, "Expected safe XML formatting: {:?}", fmt.error);
        // Must NOT expand entities or leak local files
        assert!(fmt.output.contains("&lol2;"));
        assert!(fmt.output.contains("&xxe;"));
        assert!(!fmt.output.contains("lollollollol"));
        assert!(fmt.output.len() < xxe_xml.len() * 2);
    }
}

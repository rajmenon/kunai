use base64::Engine as _;
use encoding_rs::{UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".cache",
    "__pycache__",
];

const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const MAX_BINARY_READ_BYTES: u64 = 100 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_REGEX_SIZE_BYTES: usize = 1 << 20;
const DEFAULT_MAX_DEPTH: usize = 8;
const DEFAULT_MAX_RESULTS: usize = 500;

fn validate_safe_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    if path.contains('\0') {
        return Err("Path contains invalid NUL byte".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FilePayload {
    pub path: String,
    pub name: String,
    pub content: String,
    pub encoding: String,
    pub line_ending: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinaryFilePayload {
    pub path: String,
    pub name: String,
    pub base64: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: Option<String>,
    pub children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub path: String,
    pub line_number: usize,
    pub column: usize,
    pub line_text: String,
    pub match_text: String,
}

fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.iter().any(|ignored| ignored.eq_ignore_ascii_case(name))
}

fn modified_ms_from_meta(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn decode_bytes(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, _) = UTF_8.decode(&bytes[3..]);
        return (cow.into_owned(), "UTF-8-BOM".to_string());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = UTF_16LE.decode(&bytes[2..]);
        return (cow.into_owned(), "UTF-16LE".to_string());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = UTF_16BE.decode(&bytes[2..]);
        return (cow.into_owned(), "UTF-16BE".to_string());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "UTF-8".to_string());
    }
    let (cow, _, _) = WINDOWS_1252.decode(bytes);
    (cow.into_owned(), "Windows-1252".to_string())
}

pub fn detect_and_normalize_eol(text: &str) -> (String, String) {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                    continue;
                } else {
                    cr += 1;
                }
            }
            b'\n' => {
                lf += 1;
            }
            _ => {}
        }
        i += 1;
    }

    let eol = if crlf >= lf && crlf >= cr && crlf > 0 {
        "CRLF"
    } else if lf >= cr && lf > 0 {
        "LF"
    } else if cr > 0 {
        "CR"
    } else {
        "LF"
    };

    let normalized = if crlf > 0 || cr > 0 {
        let step1 = text.replace("\r\n", "\n");
        if cr > 0 {
            step1.replace('\r', "\n")
        } else {
            step1
        }
    } else {
        text.to_string()
    };

    (normalized, eol.to_string())
}

pub fn canonicalize_encoding(encoding: &str) -> Result<&'static str, String> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" | "" => Ok("UTF-8"),
        "utf-8-bom" | "utf8-bom" | "utf-8 bom" => Ok("UTF-8-BOM"),
        "utf-16le" | "utf16le" | "utf-16 le" => Ok("UTF-16LE"),
        "utf-16be" | "utf16be" | "utf-16 be" => Ok("UTF-16BE"),
        "windows-1252" | "win1252" | "cp1252" | "latin1" | "iso-8859-1" => Ok("Windows-1252"),
        other => Err(format!("Unsupported encoding: {}", other)),
    }
}

pub fn canonicalize_eol(line_ending: &str) -> Result<&'static str, String> {
    match line_ending.trim().to_ascii_uppercase().as_str() {
        "LF" | "" => Ok("LF"),
        "CRLF" => Ok("CRLF"),
        "CR" => Ok("CR"),
        other => Err(format!("Unsupported line ending: {}", other)),
    }
}

pub fn encode_string(content: &str, encoding: &str, line_ending: &str) -> Result<Vec<u8>, String> {
    let enc = canonicalize_encoding(encoding)?;
    let eol = canonicalize_eol(line_ending)?;

    // First normalize any mixed line endings in input to \n
    let lf_content = content.replace("\r\n", "\n").replace('\r', "\n");
    let final_text = match eol {
        "CRLF" => lf_content.replace('\n', "\r\n"),
        "CR" => lf_content.replace('\n', "\r"),
        _ => lf_content,
    };

    let bytes = match enc {
        "UTF-8" => final_text.into_bytes(),
        "UTF-8-BOM" => {
            let mut out = Vec::with_capacity(3 + final_text.len());
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(final_text.as_bytes());
            out
        }
        "UTF-16LE" => {
            let mut out = Vec::with_capacity(2 + final_text.len() * 2);
            out.extend_from_slice(&[0xFF, 0xFE]);
            for unit in final_text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        "UTF-16BE" => {
            let mut out = Vec::with_capacity(2 + final_text.len() * 2);
            out.extend_from_slice(&[0xFE, 0xFF]);
            for unit in final_text.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            out
        }
        "Windows-1252" => {
            let (cow, _, _) = WINDOWS_1252.encode(&final_text);
            cow.into_owned()
        }
        _ => unreachable!(),
    };

    Ok(bytes)
}

fn is_probably_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    let check_len = bytes.len().min(8192);
    bytes[..check_len].contains(&0u8)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn file_name_from_path(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_to_string(path))
}

#[tauri::command]
pub fn read_file_smart(path: String) -> Result<FilePayload, String> {
    validate_safe_path(&path)?;
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File '{}' exceeds maximum readable size ({} bytes > {} bytes)",
            path,
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
    let (decoded, encoding) = decode_bytes(&bytes);
    let (content, line_ending) = detect_and_normalize_eol(&decoded);

    Ok(FilePayload {
        path: path_to_string(p),
        name: file_name_from_path(p),
        content,
        encoding,
        line_ending,
        size_bytes: meta.len(),
        modified_ms: modified_ms_from_meta(&meta),
    })
}

#[tauri::command]
pub fn read_binary_file(path: String) -> Result<BinaryFilePayload, String> {
    validate_safe_path(&path)?;
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;
    if meta.len() > MAX_BINARY_READ_BYTES {
        return Err(format!(
            "Binary file '{}' exceeds maximum readable size ({} bytes > {} bytes)",
            path,
            meta.len(),
            MAX_BINARY_READ_BYTES
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(BinaryFilePayload {
        path: path_to_string(p),
        name: file_name_from_path(p),
        base64: encoded,
        size_bytes: meta.len(),
        modified_ms: modified_ms_from_meta(&meta),
    })
}

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let base_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path: PathBuf = parent.join(format!(
        ".{}.kunai-tmp-{}-{}",
        base_name,
        std::process::id(),
        nonce
    ));

    let write_res = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed writing temp file for '{}': {}", target.display(), e));
    }

    if let Err(rename_err) = fs::rename(&tmp_path, target) {
        // Fallback if target file is open by another handle on Windows
        let fallback = fs::write(target, bytes);
        let _ = fs::remove_file(&tmp_path);
        if let Err(write_err) = fallback {
            return Err(format!(
                "Failed to save '{}': rename ({}), fallback write ({})",
                target.display(),
                rename_err,
                write_err
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn write_file_smart(
    path: String,
    content: String,
    encoding: String,
    line_ending: String,
) -> Result<FilePayload, String> {
    validate_safe_path(&path)?;
    let enc = canonicalize_encoding(&encoding)?;
    let eol = canonicalize_eol(&line_ending)?;
    let bytes = encode_string(&content, enc, eol)?;
    let p = Path::new(&path);

    write_atomic(p, &bytes)?;

    let meta = fs::metadata(p).map_err(|e| format!("Failed to stat saved '{}': {}", path, e))?;
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");

    Ok(FilePayload {
        path: path_to_string(p),
        name: file_name_from_path(p),
        content: normalized,
        encoding: enc.to_string(),
        line_ending: eol.to_string(),
        size_bytes: meta.len(),
        modified_ms: modified_ms_from_meta(&meta),
    })
}

fn build_tree_level(dir: &Path, current_depth: usize, max_depth: usize) -> Result<Vec<TreeNode>, String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?;

    let mut nodes = Vec::new();
    for entry_res in entries {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();

        if is_dir && is_ignored_dir(&name) {
            continue;
        }

        let children = if is_dir {
            if current_depth < max_depth {
                Some(build_tree_level(&path, current_depth + 1, max_depth).unwrap_or_default())
            } else {
                Some(Vec::new())
            }
        } else {
            None
        };

        let extension = if is_dir {
            None
        } else {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
        };

        nodes.push(TreeNode {
            name,
            path: path_to_string(&path),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            extension,
            children,
        });
    }

    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(nodes)
}

#[tauri::command]
pub fn list_workspace_tree(root: String, max_depth: Option<usize>) -> Result<Vec<TreeNode>, String> {
    validate_safe_path(&root)?;
    let p = Path::new(&root);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", root));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: {}", root));
    }
    let depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    build_tree_level(p, 0, depth)
}

#[tauri::command]
pub fn create_fs_entry(path: String, is_dir: bool) -> Result<(), String> {
    validate_safe_path(&path)?;
    let p = Path::new(&path);
    if is_dir {
        fs::create_dir_all(p).map_err(|e| format!("Failed to create directory '{}': {}", path, e))
    } else {
        if let Some(parent) = p.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory: {}", e))?;
            }
        }
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p)
            .map_err(|e| format!("Failed to create file '{}': {}", path, e))?;
        Ok(())
    }
}

#[tauri::command]
pub fn rename_fs_entry(old_path: String, new_path: String) -> Result<(), String> {
    validate_safe_path(&old_path)?;
    validate_safe_path(&new_path)?;
    let dst = Path::new(&new_path);
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create target parent directory: {}", e))?;
        }
    }
    fs::rename(&old_path, dst)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}

#[tauri::command]
pub fn delete_fs_entry(path: String) -> Result<(), String> {
    validate_safe_path(&path)?;
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("Failed to access '{}': {}", path, e))?;
    if meta.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("Failed to delete directory '{}': {}", path, e))
    } else {
        fs::remove_file(p).map_err(|e| format!("Failed to delete file '{}': {}", path, e))
    }
}

#[tauri::command]
pub fn search_workspace(
    root: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    validate_safe_path(&root)?;
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("Search root is not a directory: {}", root));
    }

    let base_pattern = if is_regex {
        query
    } else {
        regex::escape(&query)
    };
    let final_pattern = if whole_word {
        format!(r"\b(?:{})\b", base_pattern)
    } else {
        base_pattern
    };

    let re = RegexBuilder::new(&final_pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(MAX_REGEX_SIZE_BYTES)
        .dfa_size_limit(MAX_REGEX_SIZE_BYTES)
        .build()
        .map_err(|e| format!("Invalid search pattern: {}", e))?;

    let limit = max_results.unwrap_or(DEFAULT_MAX_RESULTS);
    let mut matches = Vec::new();

    let walker = WalkDir::new(root_path).into_iter().filter_entry(|entry| {
        if entry.depth() > 0 && entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy();
            return !is_ignored_dir(&name);
        }
        true
    });

    for entry_res in walker {
        if matches.len() >= limit {
            break;
        }
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }
        }
        let bytes = match fs::read(entry.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if is_probably_binary(&bytes) {
            continue;
        }
        let (decoded, _) = decode_bytes(&bytes);
        let (text, _) = detect_and_normalize_eol(&decoded);
        let file_path_str = path_to_string(entry.path());

        for (idx, line) in text.split('\n').enumerate() {
            for m in re.find_iter(line) {
                if matches.len() >= limit {
                    break;
                }
                let col = line[..m.start()].chars().count() + 1;
                let line_preview = if line.chars().count() > 400 {
                    line.chars().take(400).collect::<String>()
                } else {
                    line.to_string()
                };
                matches.push(SearchMatch {
                    path: file_path_str.clone(),
                    line_number: idx + 1,
                    column: col,
                    line_text: line_preview,
                    match_text: m.as_str().to_string(),
                });
            }
            if matches.len() >= limit {
                break;
            }
        }
    }

    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn make_temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kunai_fs_test_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_utf8_bom_and_crlf_roundtrip() {
        let dir = make_temp_dir();
        let file_path = dir.join("bom_crlf.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let written = write_file_smart(
            path_str.clone(),
            "alpha\nbeta\ngamma".to_string(),
            "UTF-8-BOM".to_string(),
            "CRLF".to_string(),
        )
        .unwrap();
        assert_eq!(written.encoding, "UTF-8-BOM");
        assert_eq!(written.line_ending, "CRLF");
        assert_eq!(written.content, "alpha\nbeta\ngamma");

        let raw = fs::read(&file_path).unwrap();
        assert!(raw.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(&raw[3..], b"alpha\r\nbeta\r\ngamma");

        let read_back = read_file_smart(path_str).unwrap();
        assert_eq!(read_back.encoding, "UTF-8-BOM");
        assert_eq!(read_back.line_ending, "CRLF");
        assert_eq!(read_back.content, "alpha\nbeta\ngamma");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_utf16_and_windows1252() {
        let dir = make_temp_dir();

        // UTF-16LE
        let f16 = dir.join("u16.txt");
        let p16 = f16.to_string_lossy().to_string();
        write_file_smart(
            p16.clone(),
            "Hello Kunai 🚀\nLine 2".to_string(),
            "UTF-16LE".to_string(),
            "LF".to_string(),
        )
        .unwrap();
        let r16 = read_file_smart(p16).unwrap();
        assert_eq!(r16.encoding, "UTF-16LE");
        assert_eq!(r16.line_ending, "LF");
        assert_eq!(r16.content, "Hello Kunai 🚀\nLine 2");

        // Windows-1252 (café with 0xE9)
        let f1252 = dir.join("win1252.txt");
        fs::write(&f1252, b"caf\xe9\rline2").unwrap();
        let r1252 = read_file_smart(f1252.to_string_lossy().to_string()).unwrap();
        assert_eq!(r1252.encoding, "Windows-1252");
        assert_eq!(r1252.line_ending, "CR");
        assert_eq!(r1252.content, "café\nline2");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_tree_crud_and_search() {
        let dir = make_temp_dir();
        let root = dir.to_string_lossy().to_string();

        // Ignored dirs should be skipped
        create_fs_entry(dir.join("node_modules").to_string_lossy().to_string(), true).unwrap();
        create_fs_entry(
            dir.join("node_modules/ignored.js").to_string_lossy().to_string(),
            false,
        )
        .unwrap();
        fs::write(dir.join("node_modules/ignored.js"), "KunaiNeedle").unwrap();

        // Regular dirs and files
        create_fs_entry(dir.join("src").to_string_lossy().to_string(), true).unwrap();
        let main_rs = dir.join("src/main.rs").to_string_lossy().to_string();
        write_file_smart(
            main_rs.clone(),
            "fn main() {\n    println!(\"KunaiNeedle\");\n    // kunaineedle lower\n}".to_string(),
            "UTF-8".to_string(),
            "LF".to_string(),
        )
        .unwrap();
        let notes = dir.join("README.md").to_string_lossy().to_string();
        create_fs_entry(notes.clone(), false).unwrap();

        // Binary file should be skipped in search
        fs::write(dir.join("blob.bin"), b"\x00\x01KunaiNeedle\x00").unwrap();

        let tree = list_workspace_tree(root.clone(), Some(4)).unwrap();
        // Only "src", "blob.bin", "README.md" (dirs first, node_modules skipped)
        assert_eq!(tree.len(), 3);
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].name, "src");
        assert_eq!(tree[1].name, "blob.bin");
        assert_eq!(tree[2].name, "README.md");
        assert_eq!(tree[2].extension.as_deref(), Some("md"));

        // Case-insensitive search
        let found_ci =
            search_workspace(root.clone(), "kunaineedle".to_string(), false, false, true, Some(50))
                .unwrap();
        assert_eq!(found_ci.len(), 2);
        assert_eq!(found_ci[0].line_number, 2);
        assert_eq!(found_ci[1].line_number, 3);

        // Case-sensitive regex search
        let found_cs = search_workspace(
            root.clone(),
            "Kunai[A-Z][a-z]+".to_string(),
            true,
            true,
            false,
            Some(50),
        )
        .unwrap();
        assert_eq!(found_cs.len(), 1);
        assert_eq!(found_cs[0].match_text, "KunaiNeedle");

        // Rename & delete
        let renamed = dir.join("DOCS.md").to_string_lossy().to_string();
        rename_fs_entry(notes, renamed.clone()).unwrap();
        assert!(Path::new(&renamed).exists());
        delete_fs_entry(renamed.clone()).unwrap();
        assert!(!Path::new(&renamed).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_security_nul_path_and_regex_size_limit() {
        let err = read_file_smart("safe\0evil.txt".to_string()).unwrap_err();
        assert!(err.contains("NUL"));

        let werr = write_file_smart(
            "safe\0evil.txt".to_string(),
            "x".to_string(),
            "UTF-8".to_string(),
            "LF".to_string(),
        )
        .unwrap_err();
        assert!(werr.contains("NUL"));

        let dir = make_temp_dir();
        let root = dir.to_string_lossy().to_string();
        let re_err = search_workspace(
            root,
            "a{1000}{1000}".to_string(),
            true,
            true,
            false,
            Some(10),
        )
        .unwrap_err();
        assert!(re_err.contains("Invalid search pattern"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_binary_file_pdf() {
        let dir = make_temp_dir();
        let pdf_path = dir.join("sample.pdf");
        let raw = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n";
        fs::write(&pdf_path, raw).unwrap();

        let payload = read_binary_file(pdf_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(payload.name, "sample.pdf");
        assert_eq!(payload.size_bytes, raw.len() as u64);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&payload.base64)
            .unwrap();
        assert_eq!(decoded, raw);

        let err = read_binary_file("bad\0file.pdf".to_string()).unwrap_err();
        assert!(err.contains("NUL"));

        let _ = fs::remove_dir_all(&dir);
    }
}

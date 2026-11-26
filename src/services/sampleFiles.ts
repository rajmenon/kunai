import type { TreeNode } from "../types/editor";
import { getSampleGuidePdfBase64 } from "../utils/samplePdf";

export interface SampleFileEntry {
  path: string;
  name: string;
  content: string;
  isBinary?: boolean;
  binaryBase64?: string;
}

export const DEMO_WORKSPACE_NAME = "kunai-demo";
export const DEMO_WORKSPACE_ROOT = "demo://kunai-demo";

export const SAMPLE_FILES: SampleFileEntry[] = [
  {
    path: "demo://kunai-demo/welcome.md",
    name: "welcome.md",
    content: `# Kunai — Smart Code & Text Editor

> **Speed of Zed & Sublime. Power of Notepad++. Native support for modern formats.**

Kunai is a keyboard-first desktop code and text editor built with **Rust + Tauri v2** and **CodeMirror 6**.

## Multi-Cursor & Sublime Editing

| Shortcut | Action |
| --- | --- |
| \`Ctrl+D\` | Select next occurrence of word / selection |
| \`Ctrl+Shift+L\` | Split multi-line selection into per-line cursors |
| \`Alt+Click\` | Place an additional cursor anywhere |
| \`Alt+Drag\` | Column / rectangular box selection |
| \`Ctrl+Alt+Up / Down\` | Add cursor on line above / below |
| \`Alt+Up / Down\` | Move selected lines up or down |
| \`Alt+Shift+Up / Down\` | Duplicate selected lines |
| \`Ctrl+Shift+K\` | Delete current line |
| \`Ctrl+/\` | Toggle line comment |

## Command Palette & Navigation

- **Command Palette** (\`Ctrl+Shift+P\`): Fuzzy search every transform, formatter, converter, and theme.
- **Quick Open** (\`Ctrl+P\`): Jump to any file in your workspace instantly.
- **Go To Line** (\`Ctrl+G\`): Jump to \`line\` or \`line:column\`.
- **Global Search** (\`Ctrl+Shift+F\`): Fast workspace-wide regex and whole-word search.
- **Find & Replace** (\`Ctrl+F\` / \`Ctrl+H\`): Supports Regex, Case, Whole Word, In-Selection, and **Select All Matches** into multi-cursors!

## Native Format Intelligence & Secure Preview

- [x] **Always Open in Preview** (\`Ctrl+Alt+P\`): Automatically open safe formats in full Pretty-Printed Formatted Preview
- [x] **Side-by-Side Toggle** (\`Ctrl+Shift+V\`): Instantly switch between Preview-Only and **Markup + Preview Side-by-Side**
- [x] **Markdown** live sanitized GFM preview (strict DOM allowlist — scripts, iframes, and inline event handlers are stripped)
- [x] **JSON / YAML / TOML / XML / CSS / SQL / CSV** pretty-printed formatted preview, live linting, Tree Inspector, JSONPath query (\`$.services[*].name\`), and 1-click cross-conversion
- [x] **Secure-by-Default**: Executable and scriptable files (\`.html\`, \`.svg\`, \`.js\`, \`.ts\`, \`.rs\`, \`.sh\`, \`.py\`, etc.) are strictly blocked from preview
- [x] **Side-by-Side Diff** viewer against any open tab or clipboard
- [x] **Notepad++ Utility Toolbox** in the sidebar: Sort, Dedupe, Regex Filter, Case Convert, Base64/URL/HTML/Hex, JWT Decode, MD5/SHA-256, UUID v4, Epoch ↔ ISO

\`\`\`rust
// Try Ctrl+D on "kunai" or open src/engine.rs to test multi-cursor editing!
fn launch_kunai() {
    let kunai_version = "0.1.0";
    println!("Kunai {kunai_version} ready in < 40ms");
}
\`\`\`
`,
  },
  {
    path: "demo://kunai-demo/config.json",
    name: "config.json",
    content: `{
  "app": "kunai-cloud",
  "version": "2.4.0",
  "environment": "production",
  "telemetry": {
    "enabled": true,
    "sampleRate": 0.25,
    "endpoint": "https://otel.kunai.dev/v1/traces"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8080,
    "tls": true,
    "timeouts": {
      "readMs": 5000,
      "writeMs": 10000,
      "idleMs": 60000
    }
  },
  "services": [
    {
      "name": "auth-gateway",
      "replicas": 3,
      "port": 8081,
      "healthy": true,
      "tags": ["edge", "jwt", "critical"]
    },
    {
      "name": "index-worker",
      "replicas": 6,
      "port": 8082,
      "healthy": true,
      "tags": ["search", "rust", "async"]
    },
    {
      "name": "format-engine",
      "replicas": 2,
      "port": 8083,
      "healthy": true,
      "tags": ["json", "yaml", "toml"]
    }
  ],
  "features": {
    "multiCursor": true,
    "treeInspector": true,
    "experimentalLsp": false
  }
}
`,
  },
  {
    path: "demo://kunai-demo/docker-compose.yaml",
    name: "docker-compose.yaml",
    content: `version: "3.9"

services:
  api:
    image: ghcr.io/kunai/api:2.4.0
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      RUST_LOG: info,kunai=debug
      DATABASE_URL: postgres://kunai:secret@postgres:5432/kunai
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  worker:
    image: ghcr.io/kunai/worker:2.4.0
    deploy:
      replicas: 2
    environment:
      QUEUE_CONCURRENCY: 16
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - redis

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: kunai
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: kunai
    volumes:
      - pg_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]

volumes:
  pg_data:
`,
  },
  {
    path: "demo://kunai-demo/Cargo.toml",
    name: "Cargo.toml",
    content: `[package]
name = "kunai-engine"
version = "0.1.0"
edition = "2021"
description = "High-speed text, formatting, and diff engine for Kunai"
license = "MIT"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
toml = "0.8"
similar = "2.6"
regex = "1.11"
encoding_rs = "0.8"
sha2 = "0.10"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = true
`,
  },
  {
    path: "demo://kunai-demo/src/engine.rs",
    name: "engine.rs",
    content: `use std::collections::HashMap;

/// Core text buffer metrics computed in a single linear pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferStats {
    pub bytes: usize,
    pub chars: usize,
    pub lines: usize,
    pub words: usize,
}

pub struct TextEngine {
    buffers: HashMap<String, String>,
    tab_width: usize,
}

impl TextEngine {
    pub fn new(tab_width: usize) -> Self {
        Self {
            buffers: HashMap::new(),
            tab_width,
        }
    }

    pub fn open_buffer(&mut self, id: impl Into<String>, content: impl Into<String>) {
        self.buffers.insert(id.into(), content.into());
    }

    pub fn analyze(text: &str) -> BufferStats {
        let bytes = text.len();
        let chars = text.chars().count();
        let lines = if text.is_empty() { 1 } else { text.lines().count() };
        let words = text.split_whitespace().count();

        BufferStats {
            bytes,
            chars,
            lines,
            words,
        }
    }

    pub fn normalize_tabs(&self, input: &str) -> String {
        let spaces = " ".repeat(self.tab_width);
        input.replace('\\t', &spaces)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_basic_buffer() {
        let stats = TextEngine::analyze("hello kunai\\nfast editor");
        assert_eq!(stats.lines, 2);
        assert_eq!(stats.words, 4);
    }
}
`,
  },
  {
    path: "demo://kunai-demo/src/app.tsx",
    name: "app.tsx",
    content: `import React, { useMemo, useState } from "react";

interface MetricCardProps {
  label: string;
  value: number;
  unit?: string;
}

export function MetricCard({ label, value, unit = "ms" }: MetricCardProps) {
  const formatted = useMemo(() => {
    return value >= 1000 ? \`\${(value / 1000).toFixed(2)}s\` : \`\${value}\${unit}\`;
  }, [value, unit]);

  return (
    <article className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{formatted}</strong>
    </article>
  );
}

export function TelemetryDashboard() {
  const [filter, setFilter] = useState("");
  const metrics = [
    { label: "Startup Latency", value: 38, unit: "ms" },
    { label: "Regex Search (10k lines)", value: 12, unit: "ms" },
    { label: "JSON Format (1 MB)", value: 24, unit: "ms" },
  ];

  const visible = metrics.filter((m) =>
    m.label.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <section className="dashboard">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter metrics..."
      />
      <div className="metric-grid">
        {visible.map((item) => (
          <MetricCard key={item.label} {...item} />
        ))}
      </div>
    </section>
  );
}
`,
  },
  {
    path: "demo://kunai-demo/queries/analytics.sql",
    name: "analytics.sql",
    content: `-- Daily active sessions and p95 latency by service tier
WITH daily_events AS (
    SELECT
        date_trunc('day', created_at) AS event_day,
        service_name,
        user_id,
        latency_ms
    FROM telemetry_events
    WHERE created_at >= NOW() - INTERVAL '14 days'
      AND status_code < 500
)
SELECT
    event_day,
    service_name,
    COUNT(DISTINCT user_id) AS active_users,
    COUNT(*) AS total_requests,
    ROUND(AVG(latency_ms)::numeric, 2) AS avg_latency_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
FROM daily_events
GROUP BY event_day, service_name
ORDER BY event_day DESC, total_requests DESC
LIMIT 50;
`,
  },
  {
    path: "demo://kunai-demo/styles/theme.css",
    name: "theme.css",
    content: `:root {
  --surface-0: #14171d;
  --surface-1: #1a1d24;
  --accent-primary: #60a5fa;
  --radius-md: 8px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  padding: 16px;
}

.metric-card {
  background: var(--surface-1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  transition: border-color 140ms ease, transform 140ms ease;
}

.metric-card:hover {
  border-color: var(--accent-primary);
  transform: translateY(-1px);
}
`,
  },
  {
    path: "demo://kunai-demo/data/metrics.csv",
    name: "metrics.csv",
    content: `service,region,latency_ms,uptime_pct,requests_per_sec
auth-gateway,us-east-1,14.2,99.99,4820
index-worker,us-east-1,28.7,99.97,1940
format-engine,eu-west-1,9.4,99.99,3110
search-proxy,ap-south-1,41.5,99.94,1250
diff-service,us-west-2,18.1,99.98,2290
`,
  },
  {
    path: "demo://kunai-demo/assets/icon.svg",
    name: "icon.svg",
    content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="blade" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="55%" stop-color="#60a5fa"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect x="12" y="12" width="216" height="216" rx="44" fill="url(#bg)" stroke="#334155" stroke-width="4"/>
  <path d="M184 56 L102 106 L86 144 L66 164 L76 174 L96 154 L134 138 Z" fill="url(#blade)"/>
  <circle cx="58" cy="182" r="14" fill="none" stroke="#60a5fa" stroke-width="7"/>
  <circle cx="152" cy="88" r="5" fill="#f8fafc" opacity="0.9"/>
</svg>
`,
  },
  {
    path: "demo://kunai-demo/notes/scratchpad.txt",
    name: "scratchpad.txt",
    content: `zebra
apple
mango
apple
banana
cherry
mango
100
25
4
42
9

-- Sample JWT (select line below & click "JWT Decode" in Utilities!) --
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrdW5haV91c2VyIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzAwMDAwMDAwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c

-- Sample Identifiers (try camelCase / snake_case / kebab-case!) --
user_session_token
parseConfigDocument
HTTP_RESPONSE_HEADER

-- Sample Epoch Timestamp (try Epoch -> ISO!) --
1700000000
`,
  },
  {
    path: "demo://kunai-demo/docs/kunai-guide.pdf",
    name: "kunai-guide.pdf",
    content: "",
    isBinary: true,
    binaryBase64: getSampleGuidePdfBase64(),
  },
];

export function buildDemoTree(filesMap: Map<string, string>): TreeNode[] {
  const rootChildren: TreeNode[] = [];

  const getOrCreateDir = (parentList: TreeNode[], dirName: string, fullPath: string): TreeNode => {
    let existing = parentList.find((n) => n.is_dir && n.name === dirName);
    if (!existing) {
      existing = {
        name: dirName,
        path: fullPath,
        is_dir: true,
        size: 0,
        extension: null,
        children: [],
      };
      parentList.push(existing);
    }
    return existing;
  };

  for (const [fullPath, content] of filesMap.entries()) {
    const prefix = DEMO_WORKSPACE_ROOT + "/";
    const rel = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let currentList = rootChildren;
    let currentPath = DEMO_WORKSPACE_ROOT;

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      currentPath = `${currentPath}/${segment}`;
      const isLast = i === parts.length - 1;

      if (isLast) {
        const dotIdx = segment.lastIndexOf(".");
        const ext = dotIdx > 0 ? segment.slice(dotIdx + 1).toLowerCase() : null;
        currentList.push({
          name: segment,
          path: fullPath,
          is_dir: false,
          size: new TextEncoder().encode(content).length,
          extension: ext,
        });
      } else {
        const dirNode = getOrCreateDir(currentList, segment, currentPath);
        if (!dirNode.children) dirNode.children = [];
        currentList = dirNode.children;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  };

  sortNodes(rootChildren);
  return rootChildren;
}

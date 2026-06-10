/**
 * transcript.ts — read transcript .jsonl files under ~/.claude/projects/<slug>/
 * with per-file byte-offset watermarks. Returns a redacted digest of new lines.
 */

import { readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { isIgnored, findProjectForCwd } from "./registry.ts";

const PROJECTS_DIR = join(
  process.env.HOME ?? homedir(),
  ".claude",
  "projects"
);

// Marker env var set when synth.ts spawns claude -p (to skip self-feeding)
const SYNTH_MARKER = "CLAUDE_PROJECTLOG_SYNTH";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileState {
  offset: number;
}

export interface ProjectState {
  files: Record<string, FileState>;
  lastSynthAt?: string; // ISO-8601
  nextStepsCache?: { value: string; fetchedAt: string };
  statusCache?: { value: string; fetchedAt: string }; // Notion Status (Active/Paused/Idea/Done)
  logPages?: Record<string, string>; // "YYYY-MM" -> pageId
  recentEntries?: RecentEntry[];
}

export interface RecentEntry {
  isoDate: string;
  bullets: string[];
}

export interface DeltaResult {
  digestLines: string[];
  newOffsets: Record<string, number>;
  count: number; // number of new lines processed
}

// ---------------------------------------------------------------------------
// Slug dir enumeration
// ---------------------------------------------------------------------------

export function slugDirs(): string[] {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PROJECTS_DIR, d.name));
  } catch {
    return [];
  }
}

/** Recursively find all *.jsonl files under a directory. */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACT_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-[A-Za-z0-9_-]{10,}/g,
  // GitHub tokens
  /ghp_\w+/g,
  /gho_\w+/g,
  // AWS access key IDs
  /AKIA[A-Z0-9]{12,}/g,
  // Slack tokens
  /xox[baprs]-[\w-]+/g,
  // JWTs
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  // PEM blocks
  /-----BEGIN[\s\S]*?KEY-----[\s\S]*?-----END[^-]*-----/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._~+/\-]{16,}/g,
  // KEY=value, TOKEN=value, SECRET=value, PASSWORD=value, PASSWD=value, API_KEY=value
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\s*[=:]\s*\S{8,}/gi,
];

// High entropy base64/hex run detector (>= 40 chars)
const HIGH_ENTROPY_RE =
  /(?:[A-Za-z0-9+/]{40,}={0,2}|[0-9a-fA-F]{40,})/g;

function hasHighEntropy(s: string): boolean {
  // Rough charset diversity check: if more than 10 distinct chars, likely high-entropy
  const chars = new Set(s.split(""));
  return chars.size >= 10;
}

export function redact(text: string): string {
  let out = text;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (m) => {
      // For KEY=value style, keep the key name, redact value
      const eqIdx = m.search(/[=:]/);
      if (eqIdx !== -1 && /KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY/i.test(m.slice(0, eqIdx))) {
        return m.slice(0, eqIdx + 1) + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  // High-entropy runs
  out = out.replace(HIGH_ENTROPY_RE, (m) => {
    if (hasHighEntropy(m)) return "[REDACTED]";
    return m;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Content extraction from a parsed line
// ---------------------------------------------------------------------------

function extractTextFromContent(
  content: string | any[],
  type: "user" | "assistant"
): string {
  if (typeof content === "string") {
    return content.slice(0, 400);
  }
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text?.slice(0, 400) ?? "");
    } else if (type === "assistant" && block.type === "tool_use") {
      // For assistant lines: include tool name only, no inputs/outputs
      parts.push(`[tool: ${block.name}]`);
    }
    // Skip tool_result blocks entirely
  }
  return parts.join(" ").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Core collectDelta
// ---------------------------------------------------------------------------

export interface CollectOptions {
  projectPath: string; // absolute path of the registered project root
  state: ProjectState;
  ignoreList: string[];
  /** All registered project cwds except this project (to avoid cross-contamination) */
  otherProjectCwds: string[];
}

/**
 * Collect new transcript lines for a project.
 * Routes each line by its own cwd field.
 */
export async function collectDelta(opts: CollectOptions): Promise<DeltaResult> {
  const { projectPath, state, ignoreList, otherProjectCwds } = opts;

  // Resolve the project path to handle symlinks
  let resolvedProjectPath: string;
  try {
    resolvedProjectPath = realpathSync(projectPath);
  } catch {
    resolvedProjectPath = projectPath;
  }

  const lastSynthAt = state.lastSynthAt
    ? new Date(state.lastSynthAt).getTime()
    : 0;
  // 1h slack: re-read files modified slightly before lastSynthAt
  const mtimeThreshold = lastSynthAt - 3_600_000;

  const allJsonl: string[] = [];
  for (const slugDir of slugDirs()) {
    allJsonl.push(...findJsonlFiles(slugDir));
  }

  const digestLines: string[] = [];
  const newOffsets: Record<string, number> = {};

  for (const filePath of allJsonl) {
    // mtime optimization: skip files not touched since threshold
    if (mtimeThreshold > 0) {
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < mtimeThreshold) continue;
      } catch {
        continue;
      }
    }

    const fileState = state.files[filePath] ?? { offset: 0 };
    let offset = fileState.offset;

    // Read from offset
    let fileSize = 0;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      continue;
    }

    if (fileSize <= offset) {
      newOffsets[filePath] = offset;
      continue;
    }

    const toRead = fileSize - offset;
    const buf = Buffer.allocUnsafe(toRead);
    let bytesRead = 0;
    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch {
      continue;
    }
    try {
      bytesRead = readSync(fd, buf, 0, toRead, offset);
    } finally {
      closeSync(fd);
    }

    if (bytesRead === 0) {
      newOffsets[filePath] = offset;
      continue;
    }

    const raw = buf.subarray(0, bytesRead).toString("utf8");
    const lines = raw.split("\n");

    // The last element may be a partial line — don't advance offset past it
    let advanceBytes = 0;
    const completeLines = lines.slice(0, -1); // all but last
    // track byte offset for complete lines
    let runningBytes = 0;
    for (let i = 0; i < completeLines.length; i++) {
      const lineStr = completeLines[i];
      runningBytes += Buffer.byteLength(lineStr + "\n", "utf8");
    }
    advanceBytes = runningBytes;

    let newOffset = offset + advanceBytes;

    // Parse complete lines
    for (const lineStr of completeLines) {
      const trimmed = lineStr.trim();
      if (!trimmed) continue;

      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const type = obj.type as string;
      if (type !== "user" && type !== "assistant") continue;

      // Skip lines from synth's own spawned claude (self-feed guard)
      // We can't directly read env from other processes, but per-line cwd routing handles it

      const lineCwd: string = obj.cwd ?? "";
      if (!lineCwd) continue;

      // Resolve the cwd for accurate matching
      let resolvedLineCwd: string;
      try {
        resolvedLineCwd = realpathSync(lineCwd);
      } catch {
        resolvedLineCwd = lineCwd;
      }

      // Check ignore list against this line's cwd
      if (isIgnored(resolvedLineCwd, ignoreList)) continue;

      // Check if this cwd belongs to a different registered project
      let belongsToOther = false;
      for (const otherCwd of otherProjectCwds) {
        let resolvedOther: string;
        try {
          resolvedOther = realpathSync(otherCwd);
        } catch {
          resolvedOther = otherCwd;
        }
        if (
          resolvedLineCwd === resolvedOther ||
          resolvedLineCwd.startsWith(resolvedOther + "/")
        ) {
          belongsToOther = true;
          break;
        }
      }
      if (belongsToOther) continue;

      // Check if this cwd is within the project path
      const withinProject =
        resolvedLineCwd === resolvedProjectPath ||
        resolvedLineCwd.startsWith(resolvedProjectPath + "/");
      if (!withinProject) continue;

      // Extract content
      const message = obj.message;
      if (!message) continue;
      const content = message.content;
      if (!content) continue;

      const text = extractTextFromContent(content, type);
      if (!text.trim()) continue;

      const redacted = redact(text);
      digestLines.push(
        `[${type.toUpperCase()} ${obj.timestamp ?? ""}] ${redacted}`
      );
    }

    newOffsets[filePath] = newOffset;
  }

  // Cap total digest at ~30KB, dropping oldest lines with a note
  const MAX_DIGEST_BYTES = 30_000;
  let totalBytes = digestLines.reduce((s, l) => s + l.length, 0);
  let truncated = false;
  while (totalBytes > MAX_DIGEST_BYTES && digestLines.length > 0) {
    const removed = digestLines.shift()!;
    totalBytes -= removed.length;
    truncated = true;
  }
  if (truncated) {
    digestLines.unshift("[... older lines truncated to stay within 30KB cap ...]");
  }

  return {
    digestLines,
    newOffsets,
    count: digestLines.length,
  };
}

/**
 * Seed a project's file offsets to current file sizes (start from NOW).
 * Called on project registration to avoid backfilling history.
 */
export function seedOffsetsToNow(projectPath: string): Record<string, FileState> {
  const files: Record<string, FileState> = {};

  // Find all slug dirs that might contain transcripts for this project
  // We don't know which slug dir belongs to this project yet at registration time,
  // so we seed ALL current jsonl files to their current size.
  for (const slugDir of slugDirs()) {
    const jsonlFiles = findJsonlFiles(slugDir);
    for (const filePath of jsonlFiles) {
      try {
        const size = statSync(filePath).size;
        files[filePath] = { offset: size };
      } catch {
        // skip
      }
    }
  }

  return files;
}

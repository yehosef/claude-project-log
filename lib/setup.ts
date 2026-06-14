#!/usr/bin/env bun
/**
 * setup.ts — interactive bootstrap for claude-project-log.
 * Run: bun lib/setup.ts
 *
 * Idempotent: safe to re-run. Never overwrites .env, registry.json,
 * notion.json, ignore.json, or state/ without explicit confirmation.
 *
 * Works on macOS and Linux — no launchd or cron needed. Scheduling is
 * handled by Stop + PostToolUse + SessionEnd hooks (all run tick.sh) that fire
 * as you work and cheaply check whether 20 minutes have elapsed before spawning a
 * sweep. A shared global gate ensures at most one sweep per interval.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const INSTALL_DIR = join(homedir(), ".claude", "projects-log");
const LIB_DIR = import.meta.dir; // setup.ts lives in lib/

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

async function prompt(question: string, secret = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: secret ? undefined : process.stdout,
    terminal: !secret,
  });

  if (secret) {
    process.stdout.write(question);
  }

  return new Promise((resolve) => {
    rl.question(secret ? "" : question, (answer) => {
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N] `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

// ---------------------------------------------------------------------------
// Step 1: Create directory layout
// ---------------------------------------------------------------------------

function createDirs(): void {
  const dirs = [
    INSTALL_DIR,
    join(INSTALL_DIR, "state"),
    join(INSTALL_DIR, ".scratch"),
    join(homedir(), ".claude", "logs"),
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }
  console.log(`Directories created/verified under ${INSTALL_DIR}`);
}

// ---------------------------------------------------------------------------
// Step 2: Copy lib/*.ts + tick.sh (never overwrite user state files)
// ---------------------------------------------------------------------------

const PROTECTED_FILES = new Set([
  ".env",
  "registry.json",
  "notion.json",
  "ignore.json",
  "pending.json",
  "global-state.json",
  "config.json",
]);

function copyLibFiles(): void {
  // Copy *.ts source files (excluding setup.ts itself)
  const tsFiles = readdirSync(LIB_DIR).filter(
    (f) => f.endsWith(".ts") && f !== "setup.ts"
  );

  let copied = 0;
  let skipped = 0;
  for (const file of tsFiles) {
    const dest = join(INSTALL_DIR, file);
    if (existsSync(dest) && PROTECTED_FILES.has(file)) {
      skipped++;
      continue;
    }
    copyFileSync(join(LIB_DIR, file), dest);
    copied++;
  }

  // Copy tick.sh and make it executable
  const tickSrc = join(LIB_DIR, "tick.sh");
  const tickDest = join(INSTALL_DIR, "tick.sh");
  if (existsSync(tickSrc)) {
    copyFileSync(tickSrc, tickDest);
    chmodSync(tickDest, 0o755);
    copied++;
  }

  console.log(`Copied ${copied} source file(s) to ${INSTALL_DIR} (${skipped} protected file(s) skipped)`);
}

// ---------------------------------------------------------------------------
// Step 3: Gather config via stdin
// ---------------------------------------------------------------------------

async function gatherConfig(): Promise<{
  notionToken: string;
  notionParentPageId: string;
  anthropicKey: string;
}> {
  console.log("\n--- Configuration ---");

  // NOTION_TOKEN
  let notionToken = process.env.NOTION_TOKEN ?? "";
  if (notionToken) {
    console.log("NOTION_TOKEN: (from environment, using it)");
  } else {
    notionToken = await prompt(
      "Notion internal integration token (starts with ntn_ or secret_): ",
      true
    );
    if (!notionToken) {
      console.error("NOTION_TOKEN is required. Aborting.");
      process.exit(1);
    }
  }

  // NOTION_PARENT_PAGE_ID
  let notionParentPageId = process.env.NOTION_PARENT_PAGE_ID ?? "";
  if (notionParentPageId) {
    console.log("NOTION_PARENT_PAGE_ID: (from environment, using it)");
  } else {
    console.log(
      "\nParent page ID: open a Notion page, click ••• > Connections > add your integration,\n" +
        "then copy the page ID from the URL (the 32-char hex after the last slash, before any ?)"
    );
    notionParentPageId = await prompt("Notion parent page ID: ");
    if (!notionParentPageId) {
      console.error("NOTION_PARENT_PAGE_ID is required. Aborting.");
      process.exit(1);
    }
    // Strip any dashes — Notion accepts both formats
    notionParentPageId = notionParentPageId.replace(/-/g, "");
  }

  // ANTHROPIC_API_KEY (optional)
  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (anthropicKey) {
    console.log("ANTHROPIC_API_KEY: (from environment, using it)");
  } else {
    console.log(
      "\nANTHROPIC_API_KEY is optional but recommended for reliable headless runs.\n" +
        "Without it, the sweeper uses your claude CLI subscription credentials."
    );
    anthropicKey = await prompt(
      "Anthropic API key (sk-ant-..., or press Enter to skip): ",
      true
    );
  }

  return { notionToken, notionParentPageId, anthropicKey };
}

// ---------------------------------------------------------------------------
// Step 4: Write .env
// ---------------------------------------------------------------------------

async function writeEnvFile(
  notionToken: string,
  anthropicKey: string
): Promise<void> {
  const envPath = join(INSTALL_DIR, ".env");

  if (existsSync(envPath)) {
    const overwrite = await confirm(
      `\n${envPath} already exists. Overwrite?`
    );
    if (!overwrite) {
      console.log("Keeping existing .env");
      return;
    }
  }

  let content = `# claude-project-log — secrets (chmod 600, never commit)\n`;
  content += `NOTION_TOKEN=${notionToken}\n`;
  if (anthropicKey) {
    content += `ANTHROPIC_API_KEY=${anthropicKey}\n`;
  }

  writeFileSync(envPath, content, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log(`Wrote ${envPath} (mode 0600)`);
}

// ---------------------------------------------------------------------------
// Step 5: Create Notion Projects database
// ---------------------------------------------------------------------------

async function createNotionDatabase(
  notionToken: string,
  parentPageId: string
): Promise<{ projects_db_id: string; projects_db_url: string }> {
  const NOTION_VERSION = "2022-06-28";

  const body = {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Projects" } }],
    properties: {
      Name: { title: {} },
      Status: {
        select: {
          options: [
            { name: "Active", color: "green" },
            { name: "Paused", color: "yellow" },
            { name: "Idea", color: "blue" },
            { name: "Done", color: "gray" },
          ],
        },
      },
      Area: {
        select: {
          options: [
            { name: "Personal", color: "purple" },
            { name: "Work", color: "blue" },
            { name: "Infrastructure", color: "orange" },
            { name: "Ideas", color: "pink" },
          ],
        },
      },
      "Next Steps": { rich_text: {} },
      "Suggested Next": { rich_text: {} },
      Progress: { rich_text: {} },
      "Open Questions": { rich_text: {} },
      Blockers: { rich_text: {} },
      "Repo Path": { rich_text: {} },
      "Last Worked": { date: {} },
      "Last Active": {
        formula: {
          expression: 'if(empty(prop("Last Worked")), "—", if(dateBetween(now(), prop("Last Worked"), "minutes") < 1, "just now", if(dateBetween(now(), prop("Last Worked"), "minutes") < 60, format(dateBetween(now(), prop("Last Worked"), "minutes")) + "m ago", if(dateBetween(now(), prop("Last Worked"), "hours") < 24, format(dateBetween(now(), prop("Last Worked"), "hours")) + "h ago", if(dateBetween(now(), prop("Last Worked"), "days") < 7, format(dateBetween(now(), prop("Last Worked"), "days")) + "d ago", if(dateBetween(now(), prop("Last Worked"), "days") < 30, format(floor(dateBetween(now(), prop("Last Worked"), "days") / 7)) + "w ago", format(floor(dateBetween(now(), prop("Last Worked"), "days") / 30)) + "mo ago"))))))',
        },
      },
    },
  };

  const res = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    if (res.status === 401) {
      throw new Error(
        `Notion API returned 401 Unauthorized.\n` +
          `Check that your NOTION_TOKEN is valid (starts with ntn_ or secret_).\n` +
          `Body: ${errBody.slice(0, 300)}`
      );
    }
    if (res.status === 404 || res.status === 403) {
      throw new Error(
        `Notion API returned ${res.status} for parent page ${parentPageId}.\n` +
          `Make sure the page is shared with your integration (••• > Connections > add integration).\n` +
          `Body: ${errBody.slice(0, 300)}`
      );
    }
    throw new Error(
      `Notion API error ${res.status}: ${errBody.slice(0, 400)}`
    );
  }

  const data = (await res.json()) as any;
  return {
    projects_db_id: data.id as string,
    projects_db_url: (data.url as string) ?? "",
  };
}

async function ensureNotionDatabase(
  notionToken: string,
  notionParentPageId: string
): Promise<void> {
  const notionJsonPath = join(INSTALL_DIR, "notion.json");

  if (existsSync(notionJsonPath)) {
    console.log(`notion.json already exists — skipping database creation (idempotent)`);
    return;
  }

  console.log("\nCreating Notion Projects database...");

  let dbInfo: { projects_db_id: string; projects_db_url: string };
  try {
    dbInfo = await createNotionDatabase(notionToken, notionParentPageId);
  } catch (e) {
    console.error(`\nFailed to create Notion database:\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  writeFileSync(
    notionJsonPath,
    JSON.stringify(dbInfo, null, 2) + "\n",
    "utf8"
  );
  console.log(`Created Projects database: ${dbInfo.projects_db_url}`);
  console.log(`notion.json written to ${notionJsonPath}`);
}

// ---------------------------------------------------------------------------
// Step 6: Merge SessionStart + Stop + PostToolUse hooks into settings.json
// ---------------------------------------------------------------------------

/**
 * Scan an existing hook array for any entry whose command string contains
 * the given substring. Returns true if found (idempotency check).
 */
function hookPresent(hookArray: any[], substring: string): boolean {
  for (const group of hookArray) {
    const hooks: any[] = group?.hooks ?? [];
    for (const h of hooks) {
      if (typeof h?.command === "string" && h.command.includes(substring)) {
        return true;
      }
    }
  }
  return false;
}

function mergeHooks(installDir: string, bunBin: string): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const sessionStartCmd = `${bunBin} ${installDir}/hook.ts session-start`;
  const stopCmd = `bash ${installDir}/tick.sh`;
  const sessionEndCmd = `bash ${installDir}/tick.sh force`;

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.warn(`Warning: Could not parse ${settingsPath} — will create fresh`);
    }
  }

  // Ensure hooks structure exists
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

  let changed = false;

  // SessionStart hook — idempotency: match on "hook.ts session-start"
  if (!hookPresent(settings.hooks.SessionStart, "hook.ts session-start")) {
    settings.hooks.SessionStart.push({
      hooks: [{ type: "command", command: sessionStartCmd }],
    });
    changed = true;
    console.log(`SessionStart hook added to ${settingsPath}`);
  } else {
    console.log(`SessionStart hook already present in ${settingsPath}`);
  }

  // Stop hook — idempotency: match on "tick.sh". Fires at the end of every
  // turn: the workhorse tick (the just-completed work is already on disk).
  if (!hookPresent(settings.hooks.Stop, "tick.sh")) {
    settings.hooks.Stop.push({
      hooks: [{ type: "command", command: stopCmd }],
    });
    changed = true;
    console.log(`Stop hook (heartbeat) added to ${settingsPath}`);
  } else {
    console.log(`Stop hook already present in ${settingsPath}`);
  }

  // PostToolUse hook — same tick.sh, gives coverage *during* long single-turn
  // autonomous runs (Stop only fires when a turn ends). Safe to add alongside
  // Stop: the gate is global + idempotent, so it still sweeps at most once per
  // interval no matter how many hooks call it.
  if (!hookPresent(settings.hooks.PostToolUse, "tick.sh")) {
    settings.hooks.PostToolUse.push({
      matcher: "*",
      hooks: [{ type: "command", command: stopCmd }],
    });
    changed = true;
    console.log(`PostToolUse hook (heartbeat) added to ${settingsPath}`);
  } else {
    console.log(`PostToolUse hook already present in ${settingsPath}`);
  }

  // SessionEnd hook — forced sweep (bypasses the 20-min gate) so the LAST work
  // of a session is captured. After a session ends there are no more ticks, so
  // without this the final edits wait until the next session's first tick.
  // Idempotency: match on "tick.sh force".
  if (!hookPresent(settings.hooks.SessionEnd, "tick.sh force")) {
    settings.hooks.SessionEnd.push({
      hooks: [{ type: "command", command: sessionEndCmd }],
    });
    changed = true;
    console.log(`SessionEnd hook (final sweep) added to ${settingsPath}`);
  } else {
    console.log(`SessionEnd hook already present in ${settingsPath}`);
  }

  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log("=== claude-project-log setup ===\n");
  console.log(`Install directory: ${INSTALL_DIR}`);

  // Step 1: directories
  createDirs();

  // Step 2: copy source files (*.ts + tick.sh)
  copyLibFiles();

  // Step 3: gather config
  const { notionToken, notionParentPageId, anthropicKey } = await gatherConfig();

  // Step 4: write .env
  await writeEnvFile(notionToken, anthropicKey);

  // Step 5: create Notion database
  await ensureNotionDatabase(notionToken, notionParentPageId);

  // Step 6: wire hooks (SessionStart + Stop + PostToolUse)
  const bunBin = process.execPath;
  mergeHooks(INSTALL_DIR, bunBin);

  // Done
  console.log(`
=== Setup complete ===

Sweeps run automatically via the Stop hook (end of every turn) plus a
PostToolUse hook (covers long single-turn runs) — every ~20 min by default.
Each fires tick.sh, which checks elapsed time and spawns the sweep detached,
so your session is never blocked. The shared gate means it still sweeps at
most once per interval no matter how many hooks fire.
Override the interval: PROJECTLOG_INTERVAL=600 (seconds) in your shell env.

In Notion, open the Projects database → Sort → Last Worked → Descending
so the most recently active project appears on top. The board also shows
a "Last Active" column with glanceable relative times (e.g. "2h ago", "3w ago").

The background sweeper will:
  - Discover active Claude Code projects from transcripts
  - Synthesize progress using claude-haiku
  - Log entries to your Notion Projects board
  - Inject STATE.md at session start

Check logs:
  tail -f ~/.claude/logs/projectlog.out.log
  tail -f ~/.claude/logs/projectlog.err.log

Run a test sweep now:
  bun ${INSTALL_DIR}/cli.ts sweep

Opt out a directory from tracking:
  bun ${INSTALL_DIR}/cli.ts ignore /path/to/dir

Uninstall:
  # Remove the SessionStart, Stop, and PostToolUse hooks from ~/.claude/settings.json
  rm -rf ~/.claude/projects-log
`);
}

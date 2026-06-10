# claude-project-log — Project Instructions

## What This Is

A Claude Code **plugin** that automatically tracks project activity across all your Claude Code sessions. A background job reads transcripts, synthesizes progress with claude-haiku, logs to a Notion Projects board, and injects per-project `STATE.md` at session start.

## Project Structure

- `lib/` — runtime TypeScript source (Bun, no npm deps)
  - `setup.ts` — interactive bootstrap; the entry point for new users
  - `synth.ts` — main sweeper; runs every 20 min via launchd
  - `cli.ts` — user-facing CLI (`status`, `sweep`, `sync`, `register`, `ignore`, etc.)
  - `hook.ts` — session-start hook; reads STATE.md and injects it as context
  - `registry.ts` — load/save `registry.json`, `pending.json`, `ignore.json`, `config.json`
  - `transcript.ts` — JSONL reader with byte-offset watermarks + redaction
  - `notion-api.ts` — Notion REST helpers (retry/backoff, property builders)
  - `env.ts` — `.env` loader with mode-0600 assertion
- `templates/` — `com.user.projectlog.plist.template` — LaunchAgent plist with `__PLACEHOLDER__` tokens
- `commands/` — `/project-log-setup` slash command
- `skills/project-log/` — `SKILL.md` teaching Claude how to use CLI commands
- `.claude-plugin/` — marketplace and plugin manifests

## Key Conventions

- **Bun only** — no npm packages; only `bun:*` and `node:*` built-ins
- **No hardcoded paths** — all user paths resolved via `homedir()`, `process.execPath`, or `Bun.which()`
- **`import.meta.dir`-relative state** — when installed to `~/.claude/projects-log/`, state files live alongside the code; `import.meta.dir` always resolves correctly
- **Never commit secrets** — `.env`, `notion.json`, `registry.json` are gitignored
- **Version** in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — keep in sync

## Testing

```bash
# Syntax-check all lib files (no .env needed — build does not execute)
for f in lib/*.ts; do bun build --no-bundle "$f" --target bun > /dev/null && echo "OK: $f"; done
```

Run a dry-run sweep from the install dir (requires a working .env):

```bash
bun ~/.claude/projects-log/cli.ts sweep --dry-run
```

## Common Tasks

- **Bump version**: update `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
- **Add a CLI command**: add the case to `lib/cli.ts`, document in `skills/project-log/SKILL.md` and `README.md`
- **Update Notion schema**: update `createNotionDatabase()` in `lib/setup.ts` and the schema docs in `README.md`

---
name: project-log
description: Manually trigger project-log operations — sync now, check status, opt out a directory. Use when the user asks about their project log, wants to force a sync, or wants to ignore a directory.
---

# project-log skill

The project-log system automatically tracks Claude Code sessions and logs project progress to Notion. Here is how to interact with it manually.

## Log this project now

```bash
bun ~/.claude/projects-log/cli.ts sync .
```

This forces a synthesis run for the current directory's project, regardless of the 20-minute schedule.

## Check status

```bash
bun ~/.claude/projects-log/cli.ts status
```

Shows all registered projects (name, area, last sync time, path) and any pending (discovered but not yet auto-registered) directories.

## List pending projects

```bash
bun ~/.claude/projects-log/cli.ts pending
```

Projects with fewer than 3 assistant turns land in pending rather than being auto-registered (junk filter, not an approval gate).

## Opt out a directory

```bash
bun ~/.claude/projects-log/cli.ts ignore .
# or
bun ~/.claude/projects-log/cli.ts ignore /path/to/dir
```

Adds the path to `~/.claude/projects-log/ignore.json`. The directory and all subdirectories are permanently excluded from tracking. This is the only opt-out mechanism — tracking is on by default.

## Register manually

```bash
bun ~/.claude/projects-log/cli.ts register .
bun ~/.claude/projects-log/cli.ts register . --area "Work"
```

Force-registers the current directory (or git root) and creates a Notion page immediately, without waiting for the ≥3 turn threshold.

## Unregister

```bash
bun ~/.claude/projects-log/cli.ts unregister .
```

Removes from the registry and stops logging. The Notion page is kept.

## Refresh STATE.md from Notion

```bash
bun ~/.claude/projects-log/cli.ts pull .
```

Re-fetches Next Steps and Status from Notion and rewrites the STATE.md injected at session start.

## Check logs

```bash
tail -f ~/.claude/logs/projectlog.out.log
tail -f ~/.claude/logs/projectlog.err.log
```

Enable verbose debug output for a manual sweep:

```bash
PROJECTLOG_VERBOSE=1 bun ~/.claude/projects-log/cli.ts sweep
```

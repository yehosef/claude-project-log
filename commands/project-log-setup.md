---
name: project-log-setup
description: Set up claude-project-log — creates the Notion Projects database, installs the background sweeper, and wires the session-start hook
---

Run the interactive setup script to configure claude-project-log for this machine.

You will need:
- A Notion internal integration token (get one at https://www.notion.so/my-integrations)
- A Notion parent page ID shared with that integration
- Optionally, an Anthropic API key for reliable headless synthesis

To start setup, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/lib/setup.ts
```

The script will:
1. Create `~/.claude/projects-log/` and required subdirectories
2. Copy the runtime source files into place
3. Prompt for your Notion token, parent page ID, and optional API key
4. Write `~/.claude/projects-log/.env` (mode 0600)
5. Create a "Projects" Notion database under your parent page
6. Install the macOS LaunchAgent (runs a sweep every 20 minutes)
7. Add a SessionStart hook to `~/.claude/settings.json`

After setup, verify with:

```bash
bun ~/.claude/projects-log/cli.ts status
```

And run an immediate test sweep:

```bash
bun ~/.claude/projects-log/cli.ts sweep --dry-run
```

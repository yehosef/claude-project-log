# Contributing to claude-project-log

Thanks for your interest in contributing.

## Reporting Issues

- Check existing issues first
- Include your macOS version, bun version (`bun --version`), and claude CLI version (`claude --version`)
- For auth issues: note whether you are using `ANTHROPIC_API_KEY` or claude subscription credentials
- Include relevant log lines from `~/.claude/logs/projectlog.err.log`

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make your changes (run the syntax check below before opening a PR)
4. Submit a PR with a clear description of what changed and why

## Syntax Check

```bash
for f in lib/*.ts; do bun build --no-bundle "$f" --target bun > /dev/null && echo "OK: $f"; done
```

All files should report `OK`.

## Code Style

- TypeScript with Bun — no npm packages, only `bun:*` and `node:*` built-ins
- No hardcoded paths, usernames, or credentials anywhere in committed files
- Keep `import.meta.dir`-relative paths intact — the code runs from `~/.claude/projects-log/`
- Preserve the opt-OUT tracking model: track by default, `ignore.json` is the only gate
- Add defensive error handling for Notion API calls (wrap in try/catch, don't abort sweep on one failure)

## Adding a New CLI Command

1. Add the implementation function and `case` to `lib/cli.ts`
2. Document it in `skills/project-log/SKILL.md`
3. Add it to the Commands table in `README.md`

## Notion Schema Changes

If you change the Projects database schema in `setup.ts`:
1. Update `createNotionDatabase()` in `lib/setup.ts`
2. Update the Schema section of `README.md`
3. Note in the PR whether existing installs need a migration step

## Questions?

Open an issue on GitHub.

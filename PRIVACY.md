# Privacy policy

*Applies to plesk-deploy-mcp, every version. Last updated 6 November 2026.*

plesk-deploy-mcp is a program that runs on your own computer, started by your
MCP client (Claude Code, Claude Desktop, Cursor, VS Code or another).

## What it collects

**Nothing.** It has no telemetry, no analytics, no crash reporting and no
accounts. Its author receives no data from it.

## What it reads, and where data goes

- **Your project files**, when you call a local tool. It reads them on your
  computer. It reports environment variable **names**, never values, and it
  never opens real `.env` files.
- **Your servers**, only if you turn on the SSH tools by listing host aliases
  in `PLESK_DEPLOY_SSH_HOSTS`. It then connects with your own `ssh`, keys and
  `known_hosts`, and runs fixed read-only commands, or the release manager's
  rollback when you confirm it.
- **GitHub's API** (`api.github.com`), only when you call
  `github_deploy_runs`. It reads workflow run status for the repository you
  name. If you set `PLESK_DEPLOY_GITHUB_TOKEN`, that token is sent to GitHub
  and nowhere else.

What the tools return goes to your MCP client and, from there, to the AI model
you use. That model provider's own privacy terms apply to it.
plesk-deploy-mcp redacts values that look like secrets before returning
anything.

## What it stores

**Nothing.** It keeps no files, caches or logs of its own. It writes files
only when you ask `generate_deploy_kit` to (with `write: true`), and only into
your project.

## Contact

Questions about privacy: open an issue at
https://github.com/usama-saeed831/plesk-deploy-mcp/issues

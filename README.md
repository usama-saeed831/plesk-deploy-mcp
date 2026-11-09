# plesk-deploy-mcp

[![CI](https://github.com/usama-saeed831/plesk-deploy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/usama-saeed831/plesk-deploy-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/plesk-deploy-mcp)](https://www.npmjs.com/package/plesk-deploy-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-2f6feb)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.usama-saeed831%2Fplesk-deploy-mcp/versions/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server that helps any AI agent (Claude Code, Claude Desktop, Cursor, VS Code and others) set up and run **safe deployments to Plesk servers**. Deploys work like this:

1. GitHub Actions tests your project and builds a release bundle.
2. A person approves it.
3. A small release manager on the server unpacks it into a new release folder, backs up the database, migrates, switches over atomically and checks health.
4. If the new release isn't healthy, it **rolls back by itself**.

The server packages a workflow that has been proven in production. It inspects your project, generates the whole deploy kit as a diff you review, and validates it. Once you turn the SSH tools on, it can also read deploy status and logs and roll back over **your own** SSH.

> Not affiliated with or endorsed by Plesk or WebPros.

## Contents

- [How it keeps production safe](#how-it-keeps-production-safe)
- [Install](#install)
- [Turning on the SSH tools](#turning-on-the-ssh-tools)
- [Using it](#using-it)
- [Tools](#tools)
- [Resources and prompt](#resources-and-prompt)
- [Configuration](#configuration)
- [FAQ](#faq)

## How it keeps production safe

- **No secrets pass through it.**
  - No tool accepts or returns a key, password or token.
  - SSH uses your system `ssh`, your `~/.ssh/config` alias, your ssh-agent and your `known_hosts`.
  - Env files are read for variable *names* only, and real `.env` files are never opened.
  - Every result is scanned, and anything that looks like a secret is redacted.
- **No deploys from your laptop.** Deploys always run in GitHub Actions, behind an approval in the `production` environment. No tool builds, uploads or deploys.
- **The SSH tools are off until you name the hosts** they may reach, in `PLESK_DEPLOY_SSH_HOSTS`.
- **The SSH tools run fixed commands only.** They run read-only discovery commands from a fixed list, or the release manager's own `--status`, `--log` and `--rollback`. There is no "run this command" tool.
- **Every input is checked against a strict pattern** before it reaches a file or a command line, and is then shell-quoted.
- **Host keys are always checked strictly** (`StrictHostKeyChecking=yes`), and agent forwarding is always off. Your own config can't loosen this.
- **Generating the kit is a dry run by default.**
  - It writes only with `write: true`, inside your git repository, and never through a symlink.
  - It never deletes anything.
  - It never replaces an existing file unless you list that file in `overwrite`.
- **Rollback needs an exact confirmation:** `confirm: "<app>@<host>"`. It is never interrupted halfway.
- **No telemetry.** The only network traffic is SSH to the hosts you named, and `api.github.com` when you ask for run status.

Details: the [threat model](docs/SECURITY.md) and the [privacy policy](PRIVACY.md).

## Install

You need Node.js 22 or later, except in Claude Desktop, which brings its own.

### Claude Code

```bash
claude mcp add --transport stdio --scope user plesk-deploy -- npx -y plesk-deploy-mcp
```

With the SSH tools on for the alias `myserver` (see [below](#turning-on-the-ssh-tools)):

```bash
claude mcp add --env PLESK_DEPLOY_SSH_HOSTS=myserver --transport stdio --scope user plesk-deploy -- npx -y plesk-deploy-mcp
```

Check it with `claude mcp list` (it should say `✔ Connected`), or `/mcp` in a session.

**Or as a plugin.** It brings the server *and* the plesk-deploy skill, which loads by itself when you talk about deploying to Plesk:

```
/plugin marketplace add usama-saeed831/plesk-deploy-mcp
/plugin install plesk-deploy@plesk-deploy-mcp
```

Claude Code then asks for the allowed SSH host aliases (leave it empty to keep the SSH tools off) and an optional read-only GitHub token, which it stores as a secret.

### Claude Desktop

**As an extension:** download `plesk-deploy-mcp-<version>.mcpb` from the [releases](https://github.com/usama-saeed831/plesk-deploy-mcp/releases), then go to **Settings → Extensions → Advanced settings → Install Extension…** and choose the file. The extension's settings let you enter the allowed SSH host aliases and an optional read-only GitHub token.

**Or in `claude_desktop_config.json`** (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "plesk-deploy": {
      "command": "npx",
      "args": ["-y", "plesk-deploy-mcp"],
      "env": { "PLESK_DEPLOY_SSH_HOSTS": "myserver" }
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "plesk-deploy": {
      "command": "npx",
      "args": ["-y", "plesk-deploy-mcp"],
      "env": { "PLESK_DEPLOY_SSH_HOSTS": "myserver" }
    }
  }
}
```

### VS Code

Run this:

```bash
code --add-mcp '{"name":"plesk-deploy","type":"stdio","command":"npx","args":["-y","plesk-deploy-mcp"]}'
```

Or add it to `.vscode/mcp.json`:

```json
{
  "servers": {
    "plesk-deploy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "plesk-deploy-mcp"],
      "env": { "PLESK_DEPLOY_SSH_HOSTS": "myserver" }
    }
  }
}
```

In any client, leave out `env` to keep the SSH tools off. The local tools work without them.

## Turning on the SSH tools

1. **Add a host alias** to `~/.ssh/config`. The safest account is the deploy account that `server-setup.sh` creates: its only sudo right is the release manager, so it can read status and logs and roll back, and nothing else.

   ```
   Host myserver
     HostName 203.0.113.10
     User myapp-deploy
     IdentityFile ~/.ssh/myapp_deploy
     IdentitiesOnly yes
   ```

2. **Connect once yourself** (`ssh myserver`). Before accepting the host key, compare its fingerprint with the output of `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. This server never adds host keys for you.
3. **List the alias** in `PLESK_DEPLOY_SSH_HOSTS` (comma-separated), then restart the MCP server.

If the key has a passphrase, load it into your ssh-agent (`ssh-add`). The server never prompts for passwords or passphrases.

## Using it

Ask your agent:

> Set up a Plesk deployment for this project.

Or start the prompt directly. In Claude Code, `/mcp__plesk-deploy__setup-plesk-deployment` walks through the 8 phases:

1. inspect the project
2. inspect the server, read-only
3. choose the deployment model
4. agree a plan with you
5. generate and validate the kit
6. hand over the manual steps (server, Plesk, GitHub)
7. verify the first deploy and do a rollback drill
8. document it

The agent stops for your agreement before anything touches production. It tells you where each secret goes, and never asks you for one.

Other things you can ask:

- "Inspect this project and show me its deployment facts."
- "What's live on `myserver` for app `acme`, and what did the last deploy log say?"
- "Roll back `acme` on `myserver`." The agent shows you what would become live and asks you to confirm first.
- "Did the last Deploy to Plesk run in `me/acme` pass? Is it waiting for approval?"

## Tools

| Tool | What it does | Changes anything? |
|---|---|---|
| `inspect_project` | Deployment facts table for a project | No |
| `server_discovery_commands` | Read-only commands for you to run on the server | No |
| `generate_deploy_kit` | Renders the deploy kit; dry run by default | Only with `write: true` |
| `validate_deploy_kit` | Checks the kit, and runs the release manager's tests | No (works in a temporary folder) |
| `server_discover` | The same read-only commands, over SSH | No |
| `deploy_status` | Releases on the server, and which is live | No |
| `deploy_logs` | The end of the deploy log | No |
| `rollback` | Makes the previous good release live | **Yes (destructive)** |
| `github_deploy_runs` | Status of recent Deploy to Plesk runs | No |

Every tool declares `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, and returns structured content next to readable text.

### `inspect_project`

It reads manifests, lockfiles, runtime pins, framework configs, Dockerfiles, CI, migrations and source code. It returns a **Deployment facts** table where each fact is *verified* (with the file it came from) or *unknown*, so nothing is guessed. It also lists the apps with their build, start and migrate commands, and the env variable **names**, split into build-time and run-time.

```json
{ "project_dir": "/Users/me/code/acme" }
```

### `server_discovery_commands`

It returns the read-only block to run as root on the server and paste back: Plesk and the OS, PM2 as root and as the domain user, ports, nginx directives, the document root, env file **names**, databases, crontabs, and whether `.env` and `.git` are exposed.

```json
{ "domain": "example.com", "app": "acme", "system_user": "acme_sys", "pm2_processes": ["acme-api"] }
```

### `generate_deploy_kit`

It renders these files:
- `.github/workflows/deploy-plesk.yml`
- `deploy/plesk/`: `build-bundle.sh`, the `<app>-deploy` release manager, `deploy.conf.example`, `server-setup.sh`, `<app>-db-backup`, PM2 or systemd definitions, optional nginx directives, and `README.md`

Each new file is shown as a diff against the vetted template it came from. Values it doesn't know are left as `FILL IN`, and you get a list of what a person still has to adapt.

```json
{
  "project_dir": "/Users/me/code/acme",
  "app": "acme",
  "stack": "node",
  "process_manager": "pm2",
  "site_url": "https://example.com/",
  "public_health_url": "https://example.com/health",
  "base_dir": "/var/www/acme-app",
  "health_checks": [{ "url": "http://127.0.0.1:3001/health/ready", "contains": "\"status\":\"ready\"" }],
  "health_commit_url": "http://127.0.0.1:3001/health/ready",
  "pm2_apps": [{ "name": "acme-api", "dir": ".", "script": "dist/main.js" }],
  "database": "postgres",
  "migrate_cmd": "NODE_ENV=production node node_modules/typeorm/cli.js migration:run -d dist/data-source.js",
  "write": false
}
```

Call it again with `"write": true` once you've agreed the diff. Add `"overwrite": ["deploy/plesk/README.md"]` only for a file you agreed to replace.

### `validate_deploy_kit`

It runs these checks:
- `bash -n` on every script, and `shellcheck` if it's installed
- a YAML parse of the workflows
- the workflow's safety settings: strict host keys, the `production` approval gate, deploys never cancelled, the key removed afterwards, read-only permissions, callable CI
- that the release manager kept every safety check
- that a backup runs before migrations
- a secret scan, which reports file and line, never the value
- the release manager's own test suite, against your adapted copy

```json
{ "project_dir": "/Users/me/code/acme" }
```

### `server_discover`

It runs the `server_discovery_commands` list over one SSH session. Each command runs under a timeout with stdin closed, and output that looks like a secret is redacted. Add `"sudo": true` to run as root through `sudo -n`, which only works with password-less sudo.

```json
{ "host_alias": "myserver", "domain": "example.com", "app": "acme" }
```

### `deploy_status`

It runs `/usr/local/bin/<app>-deploy --status`, which needs no sudo.

```json
{ "host_alias": "myserver", "app": "acme" }
```

### `deploy_logs`

It runs `sudo -n <app>-deploy --log <lines>`. The log is root-only, so this goes through the deploy account's single sudo rule.

```json
{ "host_alias": "myserver", "app": "acme", "lines": 100 }
```

### `rollback`

It runs `sudo -n <app>-deploy --rollback` and reports which release was live before and which is live now. Migrations are **not** undone; that's why migrations must only ever add (expand, then contract).

```json
{ "host_alias": "myserver", "app": "acme", "confirm": "acme@myserver" }
```

### `github_deploy_runs`

It reads runs, their jobs, and runs **waiting for approval** from `api.github.com`. For a private repository, set `PLESK_DEPLOY_GITHUB_TOKEN` to a fine-grained token with *Actions: read* and *Metadata: read*.

```json
{ "repo": "me/acme", "branch": "main", "limit": 5 }
```

## Resources and prompt

- `plesk-deploy://workflow`: the 8 phases and the rules that are never relaxed.
- `plesk-deploy://references/<name>`: discovery, hosting-models, github-actions, release-manager, environment-and-database, security-and-safety, verification-checklist, troubleshooting, rollback, and worked-example.
- `plesk-deploy://templates/<dir>/<file>`: the 12 templates the kit is rendered from, for example `plesk-deploy://templates/server/app-deploy`.
- The prompt `setup-plesk-deployment`, with two optional arguments: `project_dir` and `host_alias`.

## Configuration

| Variable | Meaning |
|---|---|
| `PLESK_DEPLOY_SSH_HOSTS` | Comma-separated `~/.ssh/config` aliases the SSH tools may reach. If it's unset, the SSH tools are off. |
| `PLESK_DEPLOY_GITHUB_TOKEN` | Optional. A read-only fine-grained token for `github_deploy_runs` on private repositories. |
| `PLESK_DEPLOY_SSH_BIN` | Optional path to `ssh`. The default is `ssh` on your PATH. |

Run `npx -y plesk-deploy-mcp --help` to see this list.

## FAQ

**Does it deploy from my machine?**
No. Deploys run in GitHub Actions after a person approves them in the `production` environment. Locally, the server only reads, renders files, and runs scripts inside temporary folders.

**Which SSH account should the alias use?**
Use the deploy account (`<app>-deploy`). Its only sudo right is the release manager, so `deploy_status`, `deploy_logs` and `rollback` all work through it. `server_discover` is more useful as root, but it only ever runs read-only commands.

**Can it read my `.env`?**
No. Locally, real `.env` files are reported as present, never opened. On the server, env files are listed as `NAME=<set>` or `NAME=<empty>` by a command that prints nothing else, not even the continuation lines of multi-line values. Everything returned also passes through the redactor.

**Why is `generate_deploy_kit` marked destructive?**
It *can* replace a file, but only one you listed in `overwrite`. By default it is a dry run and writes nothing.

**My servers run an older release manager. Does `deploy_logs` still work?**
`--log` is new in this kit. Re-run `server-setup.sh` with the new kit, which reinstalls the release manager, or read the log as root yourself. `deploy_logs` tells you which.

**Does it work if my server isn't Plesk?**
The release manager and the pipeline work on any Linux server with SSH. The Plesk-specific parts are only the discovery commands and the guidance, which cover the document root, nginx directives, PHP-FPM and system users.

**Windows?**
The local tools work on Windows. `validate_deploy_kit` needs `bash` for its shell checks; without it, those checks report *skipped*. The SSH tools use the Windows OpenSSH client.

**Which version runs with `npx -y plesk-deploy-mcp`?**
The latest one, though npx may reuse a cached copy. To pin a version, use `plesk-deploy-mcp@0.1.0`.

## Contributing, security, licence

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to work on the code. Report vulnerabilities privately ([SECURITY.md](SECURITY.md)). MIT licensed ([LICENSE](LICENSE)).

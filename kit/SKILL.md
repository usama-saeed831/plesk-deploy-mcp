---
name: plesk-deploy
description: Set up, review or repair a production deployment to a Plesk server for any project, using GitHub Actions to test and build, an approval gate, and a release manager on the server that deploys into timestamped releases, migrates safely, health-checks, and rolls back by itself. Works for Node (Express, NestJS, Next.js under PM2 or systemd), static frontends (React, Vite, Angular), PHP and Laravel, WordPress, and full-stack apps with a separate frontend and backend. Use this skill whenever the user mentions Plesk, deploying to their VPS or "the server", setting up CI/CD or GitHub Actions for production, automatic deploys from git, PM2 on a server, release folders, rollbacks, or says "set up Plesk deployment for this project", even if they don't name the skill.
---

# Plesk deployment workflow

This skill turns a project into one that deploys to a Plesk server the same way
every time: GitHub tests and builds it, a person approves it, and a small release
manager on the server switches to it and switches back if it isn't healthy.

The pattern was proven on a production NestJS + Next.js monorepo (see
`references/worked-example.md`, an anonymised account of it). Treat that
project as a worked example, not a template to copy. Every project gets the shape that fits
its stack, its server and the people who run it.

## Rules that are never relaxed

These come from running real production systems. Each one has a reason. When a
rule gets in the way, stop and ask the user. Don't work around it.

1. **Inspect before you change.** Read the existing Plesk settings, processes,
   files and workflows before you change anything. A server that "should" be
   set up one way often isn't. The deploy you design has to fit what is there.
2. **Never overwrite production blindly.** Don't overwrite files, databases,
   `.env` files, nginx directives, crontabs or workflows without first showing
   what is there and getting agreement. Copy, never move. Add, never replace.
   Before deleting or replacing an existing workflow or deploy script, say what
   it does and ask.
3. **Secrets never pass through you.** Don't ask the user to paste a key,
   password or token into the chat. Don't write one into code, git,
   `.env.example`, logs, screenshots, tickets or reports. Tell the user exactly
   where each secret goes (a GitHub environment secret, or a root-owned file on
   the server) and let them put it there. When you check a secret, report only
   whether it is present and its shape (for example "starts with
   `-----BEGIN OPENSSH PRIVATE KEY`", "32 characters"), never its value.
4. **Development is not production.** Don't assume production matches the local
   `.env`, docker-compose, Node version, database engine or paths. Find out.
5. **Change as little as possible.** Keep the existing proxy, ports, domains,
   process manager and database unless there is a concrete reason to change them,
   and say what the reason is. A deploy pipeline is not a chance to re-platform.
6. **Keep production working.** Until the first new deploy, the site keeps
   running exactly as it does today. Set-up steps are idempotent and safe to run
   again. Every migration must leave the previous release working (expand, then
   contract), because rollback switches code, not schemas.
7. **Back up before migrating.** Take a database dump before every migration,
   and confirm the daily backups exist and restore. Never run seeds, `db:push`,
   `synchronize`, `migrate:fresh` or anything destructive against production.
8. **Check permissions and exposure.** Know which account runs the app. Make sure
   `.env`, `.git` and backups can't be fetched over HTTP. Keep app ports
   closed to the outside. Give the deploy account exactly one sudo command.
9. **Say who does what.** Every step is either automated (it runs in the
   pipeline or a script) or manual (a person runs it in Plesk, on the server as
   root, or in GitHub settings). Label each one. Give manual steps as exact
   click paths or commands, with what the user should see.
10. **It isn't deployed until it's verified live.** A green pipeline isn't proof.
    Report success only after the live URL answers from outside, through Plesk's
    proxy, and reports the new commit (or shows the new content). Then try a
    rollback.

Also respect the user's machine and process. Many developers deploy from a
laptop that struggles with full builds. Run targeted checks locally and let CI do
the heavy work. Commit with the user's own git identity and the trailers they
want. Don't push, merge to the default branch, or deploy without asking.

## The workflow

Work through these phases in order. Each one ends with something concrete to
show the user. You need the user's agreement after phase 4 before you write
anything that affects production.

### Phase 1: Inspect the project

Read `references/discovery.md`, section "The project". Find out the stack, the
build commands, what runs in production (processes, ports, workers,
schedulers), how configuration is read (`.env`, `process.env`, `config/*.php`,
`wp-config.php`), which variables are needed at build time and which at run
time, the database and how migrations run, and what files the app writes at run
time (uploads, storage, cache). Also look for any existing CI, Dockerfiles,
deploy scripts and deployment docs. They hold decisions someone already made.

Write the findings as a short **Deployment facts** table. Mark each row
*verified* (you read it in the code), *reported* (the user told you), or *unknown*.

### Phase 2: Inspect the server, read-only

Read `references/discovery.md`, section "The server". You usually can't reach
the server yourself. Give the user a block of **read-only** commands to run as
root and paste back, such as `plesk bin site --list`, `pm2 ls` (as root *and* as
the domain's system user), the process's working directory and Node version,
listening ports, the domain's document root, its additional nginx directives,
crontabs, and where the current `.env` lives. Ask them to redact secrets before
pasting. Nothing in this phase changes the server.

Add what you learn to the facts table. Correct any assumption the server
contradicts. Servers often differ from the docs: the app runs from a path
nobody wrote down, PM2 runs as root, or Plesk added a prefix to the database
names.

### Phase 3: Choose the deployment model

Read `references/hosting-models.md` and pick the model that fits:

| Project | Usual model |
|---|---|
| Node API, Next.js, NestJS, Express, full-stack Node monorepo | Release bundle built in CI, release manager, PM2 (or systemd), Plesk nginx proxy to localhost ports |
| React / Vite / Angular static build | Release bundle, release manager with no process, document root on `current` |
| Laravel / PHP app | Release bundle with `vendor/`, release manager, shared `storage/` and `.env`, php-fpm reload, document root on `current/public` |
| WordPress | Deploy only the theme or plugins you own; WordPress core, the database and uploads stay as they are |
| Small site where the user prefers Plesk's own tools | Plesk Git extension (pull and deploy actions), if it fits; say what it can't do (no automatic rollback) |

Keep whatever process manager is already working. If PM2 runs the app today,
keep PM2. Don't switch to systemd or Docker unless there's a reason the user
agrees with.

### Phase 4: Write the plan and agree it

Give the user a plan before you write any files. It should cover:

- The pipeline: what runs on pull requests, what runs on the default branch,
  where the approval gate sits, and what doesn't deploy (docs-only changes).
- The layout on the server: base folder, releases, `current`, shared files,
  the env file, backups, logs.
- Every change to the server, Plesk and GitHub, each labelled automated or
  manual and marked as new or changed. Note anything that is removed, and why.
- How migrations, backups, health checks and rollback will work for this stack.
- What stays exactly as it is.
- Open questions. Each one should have a recommended answer.

Wait for agreement. Earlier approval doesn't carry over to production changes
the user hasn't seen.

### Phase 5: Build it in the repository

Read `references/github-actions.md` and `references/release-manager.md`. Then
adapt the templates in `templates/`:

| Template | Becomes |
|---|---|
| `templates/github/deploy-plesk.yml` | `.github/workflows/deploy-plesk.yml` |
| `templates/github/ci-callable.md` | changes that make the existing CI reusable (`workflow_call`) |
| `templates/build/build-bundle.sh` | `deploy/plesk/build-bundle.sh`: builds and stages the release on the runner |
| `templates/server/app-deploy` | `deploy/plesk/<app>-deploy`: the release manager |
| `templates/server/deploy.conf.example` | `deploy/plesk/deploy.conf.example` |
| `templates/server/server-setup.sh` | `deploy/plesk/server-setup.sh`: the one-time, idempotent server set-up |
| `templates/server/db-backup` | `deploy/plesk/db-backup`: the dump before migrating |
| `templates/process/ecosystem.config.js` or `app.service` | PM2 or systemd process definitions that run from `current` |
| `templates/plesk/*.conf` | additional nginx directives, if the proxy needs changing |
| `templates/docs/DEPLOY-README.md` | `deploy/plesk/README.md`: set-up, secrets, every day, rollback |

Rename everything for the app (`<app>-deploy`, `/etc/<app>/`). Delete the
settings and branches the stack doesn't use. Keep every safety check. Before
you hand it over, test the release manager on the laptop with
`scripts/test-release-manager.sh` (it uses stand-ins, so it needs no server).
Only run the project's own targeted checks.

### Phase 6: Hand over the manual steps

Give the user one ordered checklist, split by place:

1. **On the server, as root:** copy the kit, run `server-setup.sh` once to write
   the settings file, fill it in from phase 2, create the deploy key, then run
   `server-setup.sh` again for real. Copy the existing `.env` into place. Don't
   move it.
2. **In Plesk:** check the proxy, the document root, SSL and the HTTP→HTTPS
   redirect. Check the firewall keeps app ports closed. Only change anything if
   the plan says to.
3. **In GitHub:** create the `production` environment with required reviewers
   and main-only branches. Add the environment secrets (SSH host, user, key,
   known_hosts, port) and the repository variables (public, build-time values).
   Say exactly which kind each one is. A setting created in the wrong place is
   the most common first-run failure.

Read `references/environment-and-database.md` for where each kind of value
goes, and `references/security-and-safety.md` for the deploy account and key.

### Phase 7: First deploy, verification and a rollback drill

Push a branch first, so CI runs where nothing deploys. Once it passes, merge or
run the deploy workflow. The user approves the run. Follow
`references/verification-checklist.md`: the release manager's own checks, then
from outside (HTTPS, the commit the app reports, login, one real journey, logs,
no exposed files), then `--status`, then one `--rollback` and a deploy back.
Read `references/troubleshooting.md` when something fails.

Only after all of that do you report the deploy as working. Your report should
list what was verified and how, what is still the user's to do, and anything you
couldn't verify.

### Phase 8: Leave it documented

Make sure `deploy/plesk/README.md` in the repository covers: how a deploy works,
the one-time set-up, the secrets and variables table (names only, never values),
the every-day table (deploy, deploy an older commit, emergency deploy without
tests, redeploy, roll back, status, logs, change a setting), and the rollback and
migration policy (`references/rollback.md`). Point to it from the project's main
deployment doc.

## Reporting

- Always separate **done and verified**, **done but not verified** and
  **the user's to do**.
- Label each fact with its source: *verified*, *reported* or *assumed*.
  Don't present an assumption as a fact.
- When something fails, show the actual error, what you think caused it, and
  the smallest fix. Don't retry the same thing hoping for a different result.
- Never claim a deploy worked because a command exited 0.

## Files in this skill

- `references/discovery.md`: what to read in the project, and read-only commands for the server and Plesk
- `references/hosting-models.md`: per-stack guidance (Node/PM2, Next.js, NestJS, static SPA, Laravel/PHP, WordPress, full-stack, Plesk Git extension)
- `references/github-actions.md`: pipeline design, environments, secrets versus variables, concurrency, reusable CI
- `references/release-manager.md`: how `app-deploy` works, every setting, a configuration per stack, testing it
- `references/environment-and-database.md`: env files, build-time versus run-time values, databases, migrations, backups, Redis, cron, workers
- `references/security-and-safety.md`: the deploy account, keys, sudo, file exposure, ports, logs
- `references/verification-checklist.md`: before, during and after the first deploy
- `references/troubleshooting.md`: symptom, cause and fix, including failures seen in real deployments
- `references/rollback.md`: automatic, manual, database, emergency
- `references/worked-example.md`: the production setup this skill came from, anonymised: every name, domain, path and date is changed
- `templates/`: files to adapt (see the table in phase 5)
- `scripts/test-release-manager.sh`: exercises the release manager in a temporary folder
- `INSTALL.md`: how to install this skill for Claude Code or another agent

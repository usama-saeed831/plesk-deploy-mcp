# Environment, database, and the things that run on a schedule

## Where each value goes

| Value | Lives in | Set by |
|---|---|---|
| Run-time secrets and settings (DB login, API keys, JWT, SMTP, payment, `PORT`, `FRONTEND_URL`) | The server's env file, for example `/etc/<app>/app.env`, mode **640**, `root:<APP_GROUP>`, linked into each release | The user, on the server |
| Public build-time values (`NEXT_PUBLIC_*`, `VITE_*`, base paths, CSP mode) | GitHub **repository variables** | The user, in GitHub |
| SSH access for the deploy | GitHub **environment secrets** (`production`) | The user, in GitHub |
| Non-secret deploy settings (paths, users, health URLs) | `/etc/<app>/deploy.conf`, mode 644 | The user from the example, guided by you |
| The release's commit | `RELEASE.txt` in the bundle, passed to the app as `RELEASE_VERSION` | The pipeline |

Rules:

- **You never see a secret's value.** Write `.env.example` with names and harmless placeholders, and tell the
  user which file each real value goes in. When you check, check presence (`grep -c '^NAME=.'`), not content.
- Prefer a file **outside the document root and outside the release**. If the current `.env` sits inside
  `httpdocs`, copy it out (don't move it) during set-up and check from outside that the old path isn't
  downloadable.
- Values with spaces, `#` or quotes: check how the app's loader parses them (dotenv, Laravel and systemd
  `EnvironmentFile` differ).
- **Changing a setting:** edit the env file, then reload with the new environment. That's
  `pm2 reload all --update-env` for PM2 (as the app user), `systemctl restart` for systemd,
  `php artisan config:cache` for Laravel. Say which in the README.
- Production values aren't development values. `NODE_ENV=production`, the real
  `FRONTEND_URL`, CORS origins, cookie domain, `APP_DEBUG=false`, mail sender
  and webhook URLs all need checking for production specifically.

## Live integrations in development

Developers' local `.env` files often hold **live** keys (payments, SMS, voice,
email, AI). When you run anything locally while setting this up, blank the
provider keys for that run, and never trigger flows that send real messages or
calls. If a test suite would hit a live provider, don't run it locally.

## Databases

**Discover first:** the engine and version on the server, whether it's native or
in a container, the exact database and user names (Plesk may prefix them), and
where the app's login is configured. Check the login from the server with the
app's own settings. `server-setup.sh` does this without printing the password.

**Migrations own the schema in production.** Turn off `synchronize`,
`db:push`, auto-migrate or anything like it outside development. Seeds don't run
in production. Demo accounts with known passwords must never reach a real
database.

**Migrations run once per deploy, from the new release, before the switch, as
the app user.** When a migration fails, the release is abandoned, the live code
is untouched, and the dump from just before is there. Prefer a migration tool
that runs each migration in its own transaction, so a failure rolls back
cleanly. MySQL can't roll back DDL, which is one more reason for small
migrations.

**Write every migration so the previous release still works** (expand, then contract):

| Change | Release N (expand) | Release N+1 or later (contract) |
|---|---|---|
| Add a column | add it nullable or with a default | make it required once all code writes it |
| Rename a column | add the new one, write both, backfill | stop reading the old one; drop it later |
| Drop a column / table | stop using it in code | drop it in a later release, after a rollback window |
| Change a type | add a new column, dual-write | switch reads, then drop |
| Add an enum value | add it | — (Postgres enum values can't be removed; plan for that) |

This is what makes rollback a code switch. If a change can't be made backward
compatible, say so in the plan. It then needs a maintenance window and a
rehearsed restore, not this pipeline's automatic rollback.

**Never edit a migration that has run in production.** Write a new one.

**Rehearse risky migrations** on a copy of production data (a restored dump in a
scratch database) before they ship. Measure how long they lock tables.

## Backups

Two kinds, and both are needed:

1. **Before each migration**, made by the release manager (`PRE_MIGRATE_CMD`,
   `templates/server/db-backup`). It's a fast local dump for undoing one deploy.
   The newest five are kept, mode 600, in a root-only folder.
2. **Daily, off-server, encrypted, verified**: the real backups. Check that they
   exist (Plesk Backup Manager, a cron script, the host's snapshots) and when a
   restore was last tested. If nobody knows, add "test a restore" to the user's
   list. A backup nobody has restored isn't yet proof of anything.

Credentials for dumps come from the env file or `~/.pgpass` (mode 600), **never
the command line**, where `ps` shows them to every user.

## Redis and other shared services

- Several sites on one Plesk server often share one Redis. Give each app its own database number
  (`redis://127.0.0.1:6379/1`) or key prefix, and record which one belongs to whom.
- Don't flush a shared Redis. Don't restart shared services as part of a deploy.
- If the app degrades gracefully without Redis (in-memory fallbacks), say what is lost when it's absent,
  for example rate limits or job locks per process instead of per cluster.

## Scheduled jobs, queues and workers

- **In-app schedulers** (`@nestjs/schedule`, `node-cron`, Laravel scheduler run by one cron line): make sure
  exactly one process runs each job. With more than one instance, use a lock (Redis `SET NX PX`, a database
  advisory lock). Check what the lock does when Redis is down: failing open means duplicate runs.
- **System cron** (Plesk Scheduled Tasks or `crontab -l -u <user>`): point commands at `<BASE>/current/...`
  so they always run the live release. Never point them at a specific release folder.
- **Queue workers** (Bull, BullMQ, Laravel queues, Sidekiq-like): run them under the same process manager,
  from `current`, and restart them on each deploy (PM2 reload, `queue:restart`) so they don't keep running
  old code.
- **Long-running jobs** at deploy time: a reload interrupts them. Make jobs resumable or let them finish
  (`kill_timeout` / graceful shutdown) rather than hoping deploys miss them.
- Jobs that **send messages or charge money** (morning check-ins, reminders,
  invoices) start the moment production config is live. Confirm with the user
  that they should, before the first deploy that turns them on.

## Uploads and generated files

Anything the app writes at run time (uploads, generated PDFs, `storage/`, SQLite
files) goes in `shared/` and is linked into each release. Copy the existing
files there during set-up with `cp -Rpn` (copy what's missing, never
overwrite). Back them up with the database.

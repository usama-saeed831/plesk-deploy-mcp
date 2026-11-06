# Discovery: the project, then the server

The goal is a **Deployment facts** table you can defend. Every row says where
the fact came from:

| Fact | Value | Source |
|---|---|---|
| Runtime | Node 24 (`.nvmrc`) | verified: repo |
| Process on the server | PM2, as root, cwd `/var/www/vhosts/example.com/httpdocs/backend` | reported: `pm2 info` output |
| Database | PostgreSQL 16, native on the host | unknown, ask |

*verified* means you read it yourself. *reported* means the user ran a command
and pasted the output. *unknown* means you have to ask. Never upgrade an
*unknown* to a fact because it's likely.

## Contents

- The project: what to read
- The server: read-only commands to give the user
- Plesk specifics
- Questions to ask the user

---

## The project

Read these, in roughly this order. Use search tools; don't run builds yet.

**Shape**
- Root manifest and lockfile: `package.json` + `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`;
  `composer.json` + `composer.lock`; workspaces (`"workspaces"`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`).
- Which folders are deployable apps and which are libraries, mobile apps or docs.
- Runtime version pins: `.nvmrc`, `.node-version`, `engines`, `volta`, `composer.json` `require.php`,
  `Dockerfile` `FROM` lines. The server must run the same **major** version
  when native modules are bundled (`bcrypt`, `sharp`, `argon2`, `better-sqlite3`, `canvas`).

**Build and start**
- `scripts` in each `package.json`: `build`, `start`, `start:prod`, `migration:run`, `postinstall`.
- Framework config: `next.config.*` (`output: 'standalone'`? `basePath`? image domains?),
  `nest-cli.json`, `vite.config.*` (`base`), `angular.json` (`outputPath`, `baseHref`).
- `Dockerfile*` and `docker-compose*`: even if production doesn't use Docker, these show how someone
  already built a production image (which deps, which env vars, which start command).
- Existing `ecosystem.config.js`, `Procfile`, `*.service`, `supervisor` configs.

**Configuration**
- How config is read: `@nestjs/config` / `dotenv` (which path? relative to cwd?), `process.env.X` directly,
  Laravel `config/*.php` + `.env`, `wp-config.php`.
- `.env.example` files: the full list of names. Never open a real `.env` to read values. If you must
  check one, report key names and whether each is set.
- **Build-time versus run-time.** Anything inlined at build (`NEXT_PUBLIC_*`, `VITE_*`, Angular
  `environment.prod.ts`, `REACT_APP_*`) is fixed when CI builds, so it belongs in CI variables, and it is
  public. Anything read at start belongs in the server's env file.
- Release identification: does the app report its version or commit anywhere (`/health`, `/version`,
  a meta tag)? If not, plan to add one: it is the only reliable proof of what is live.

**Data**
- Database engine and how the app connects (`DB_*`, `DATABASE_URL`).
- Migrations: tool, command, where compiled migrations live, whether `synchronize`/auto-migrate is on
  anywhere (it must be off in production), whether migrations run in a transaction.
- Seeds: which ones exist, and confirm that none run automatically.
- Files written at run time: uploads, `storage/`, generated PDFs, caches, SQLite files. These must
  live outside the release folder and be shared.
- Redis, queues, scheduled jobs (`@Cron`, `node-cron`, `bull`, `agenda`, Laravel scheduler/queue, WP-Cron).
  Is there a lock so two processes don't both run a job?

**Existing delivery**
- `.github/workflows/*`, other CI files, `deploy*.sh`, `Makefile`, docs under `docs/` about deployment.
  Note what each one does. You'll be asked before replacing any of them.
- Tests that read deployment files (some projects assert Dockerfiles or workflows contain certain lines);
  changing those files may need test updates.

**Health**
- An endpoint that checks dependencies (`/health/ready`) versus one that only proves the process is up.
  The release manager needs one that fails when the database is unreachable.

## The server

You normally have no shell on the server. Give the user **one block of read-only
commands** to run as root, explain what each answers, and ask them to redact any
secret before pasting. Adapt it; skip what doesn't apply.

```bash
# --- Plesk and the OS
plesk version
cat /etc/os-release | sed -n '1,3p'
plesk bin site --list                         # every domain and subdomain on this server
plesk bin subscription --info example.com     # owner, system user, hosting type (look for "FTP Login", "Hosting type")

# --- What runs the app today (PM2 lists only the account that started it: run both)
pm2 ls
sudo -u <domain system user> pm2 ls 2>/dev/null
pm2 info <process name> | grep -E 'exec cwd|script path|node.js version|interpreter|exec mode'
systemctl list-units --type=service --no-pager | grep -Ei 'node|pm2|php|queue|worker|<app>'
ls /opt/plesk/node/ 2>/dev/null; ls /opt/plesk/php/ 2>/dev/null
command -v node pm2 php composer; node -v

# --- Ports and the proxy
ss -ltnp | grep -E 'node|php|nginx|httpd|redis|postgres|mysql'
ls -la /var/www/vhosts/system/example.com/conf/
cat /var/www/vhosts/system/example.com/conf/vhost_nginx.conf 2>/dev/null   # "Additional nginx directives"

# --- The files
ls -la /var/www/vhosts/example.com/
ls -la /var/www/vhosts/example.com/httpdocs/ | /usr/bin/head -30
stat -c '%U:%G %a %n' /var/www/vhosts/example.com/httpdocs
cd <app folder> && git status --short | head -5; git log -1 --oneline; git remote -v   # if it is a checkout

# --- Configuration (names only)
ls -la <path to .env>
sed -E 's/=.*/=<set>/' <path to .env> | grep -v '^#'          # key names, values hidden

# --- Data
psql --version 2>/dev/null; mysql --version 2>/dev/null; redis-cli ping 2>/dev/null
plesk bin database --list 2>/dev/null

# --- Scheduled work
crontab -l 2>/dev/null; crontab -l -u <domain system user> 2>/dev/null
ls /etc/cron.d/

# --- Exposure, from anywhere
curl -sI https://example.com/.env | /usr/bin/head -1
curl -sI https://example.com/.git/config | /usr/bin/head -1
```

What you are looking for:

- **Who runs the app, on which runtime.** The PM2 owner (root or the domain
  user), the Node binary PM2 uses (`pm2 info` shows the version; Plesk's Node
  builds live in `/opt/plesk/node/<major>/bin/`), PHP-FPM's version for the
  domain.
- **Where it runs from.** The real working directory is often a git checkout
  inside `httpdocs`, which matters for exposure (below) and for the first
  switch to `current`.
- **What the proxy does.** Which local ports nginx forwards to, and whether that
  comes from Plesk's Node.js extension or from "Additional nginx directives".
  Don't change a working proxy.
- **Other tenants.** Other sites on the same server share Redis, ports, PM2 and
  disk. Record their ports and Redis database numbers so you don't collide.
- **Exposure.** If the app lives inside the document root, check from outside
  that `.env` and `.git` return 403 or 404.

## Plesk specifics

Plesk generates the web server configuration, so **edits go through Plesk, never
into generated files**.

- **Generated config:** `/var/www/vhosts/system/<domain>/conf/` (`nginx.conf`, `httpd.conf` and
  others) is rewritten by Plesk. Read it to understand the setup; change it only through the UI, or
  `vhost_nginx.conf` / `vhost.conf` as Plesk writes them from **Apache & nginx Settings**.
- **Additional nginx directives:** Websites & Domains → *domain* → Hosting & DNS → Apache & nginx Settings
  (the label differs between Plesk versions). A `location /` there can collide with one Plesk already
  generates ("duplicate location"); see `troubleshooting.md`.
- **Static files served by nginx:** "Serve static files directly by nginx" / "Smart static files
  processing". For a proxied Node app it is usually off, so requests reach the app.
- **Document root:** Hosting settings for the domain. It is relative to the
  subscription's home (`/var/www/vhosts/<domain>/`) and must stay inside it.
  This decides where a PHP or static release can live.
- **PHP:** each domain has its own PHP version and handler (`plesk bin php_handler --list`); FPM
  services are named like `plesk-php83-fpm` (`systemctl list-units 'plesk-php*'`). PHP's `open_basedir`
  usually limits a site to its own webspace, another reason to keep PHP releases inside it.
- **Node.js extension:** Plesk can run Node itself (through Phusion Passenger) with an "Application root"
  and "Application startup file". If the site uses it, the process isn't PM2's, and deploying means
  restarting it through Plesk. Find out which is in use before planning.
- **Git extension:** Plesk can pull a repository and run "additional deployment actions". It's simple
  but has no build isolation, approval or automatic rollback. See `hosting-models.md`.
- **Databases:** created in Plesk's Databases page. Plesk may prefix names with
  the subscription's login. Use the exact names Plesk shows.
- **Scheduled tasks:** Plesk's Scheduled Tasks page writes the system user's
  crontab. Tasks there and in `crontab -l` are the same thing.
- **SSL:** Let's Encrypt (SSL It! or SSL/TLS Certificates) per domain, with "Redirect from HTTP to HTTPS".
  After any certificate change check the chain from outside:
  `openssl s_client -connect example.com:443 -servername example.com -showcerts </dev/null | grep -c 'BEGIN CERT'`
  should be 2 or more.
- **Logs:** `/var/www/vhosts/system/<domain>/logs/` (access, error and proxy error logs), also on the
  domain's Logs page.
- **System users:** each subscription has a system user (often its FTP login)
  and a home at `/var/www/vhosts/<domain>`. Running the app as that user is
  safer than root. If it already runs as root, say so and recommend a later
  migration, but don't change it as part of setting up the pipeline.

## Questions to ask the user

Ask only what you couldn't find, and suggest an answer for each:

- Which branch deploys, and who approves production releases?
- Is there a staging site, and should it deploy automatically?
- Which services does production use: Redis, queues, mail, storage, payments?
  Are they live, and are any shared with other sites?
- How is the database backed up today, and when was a restore last tested?
- Are there maintenance windows, or users in time zones where a short
  interruption matters?
- Who has root on the server, and can they run the set-up steps?

# Hosting models, per stack

Pick the model that fits what the server already does. Every model shares the same
skeleton, and only the contents of the release and what "reload" means differ:

```
<BASE>/
  releases/20261106-101500/     one unpacked bundle per deploy (newest KEEP_RELEASES kept)
  releases/20261106-093000-failed
  current -> releases/20261106-101500
  shared/                       files that outlive releases: uploads, storage, .env (or under /etc/<app>)
  ecosystem.config.js           PM2 only: copied from the live release on every deploy
```

The release manager (`templates/server/app-deploy`) handles the skeleton for
every model. This file covers what goes inside a release.

## Contents

- A. Node services under PM2 (Express, NestJS, Fastify, Next.js `next start`)
- B. Node services under systemd
- C. Static frontends (React, Vite, Angular, Next.js `output: 'export'`)
- D. PHP and Laravel
- E. WordPress
- F. Full-stack: separate frontend and backend
- G. Plesk's own tools: the Git extension and the Node.js extension
- Choosing where the release lives

---

## A. Node services under PM2

**When:** PM2 already runs the app, or nothing runs it yet and the team knows PM2.

**Build on the runner, not the server.** The server only unpacks. That keeps
compilers, dev dependencies and memory-heavy builds off production, and makes the
bundle the thing that was tested.

- Install with the lockfile (`npm ci`), build with `NODE_ENV=production`.
- Ship **production dependencies only**, installed the way the project's production Dockerfile does it,
  when there is one. In npm workspaces: `npm ci --workspace=<app> --omit=dev` into a clean staging copy, then
  remove the symlinks npm creates for sibling workspaces (they'd point back into the runner's checkout).
- Copy only what runs: `dist/`, `package.json`, `node_modules/`, and any files the code reads at run time
  (templates, JSON data, `public/`). Write `RELEASE.txt` with `commit=`, `ref=`, `built_at=`, `node_major=`.
- Native modules make the bundle **specific to a Node major and to Linux x64/glibc**. Build on
  `ubuntu-latest` with the same major as the server (pin it in `.nvmrc`). The release manager refuses a bundle
  whose `node_major` differs from the server's.

**Run from `current`.** Every path in `ecosystem.config.js` goes through
`<BASE>/current` (`templates/process/ecosystem.config.js`), so PM2 keeps the same
process names from release to release. A reload starts in whatever `current`
points at by then.

- `pm2 startOrReload <BASE>/ecosystem.config.js --update-env` then `pm2 save`.
- **The first switch.** A process started from an old checkout keeps that cwd through a reload. The release
  manager deletes and restarts it once from `current` when the cwd differs (`PM2_APPS`). That costs a few
  seconds of downtime, once. Tell the user before the first deploy.
- Run PM2 commands **as the account that owns the processes** (`pm2 ls` as root shows nothing of another
  user's PM2, and the other way round). Set `APP_USER` and `PM2_HOME` to match.
- `pm2 startup` must be configured for that account, or the apps won't come back after a reboot.
- Cluster mode with `instances > 1` needs the app to be stateless across processes (sessions, sockets, cron
  locks). If production runs one instance today, keep one.

**Config:** the app's `.env` lives outside the release (for example `/etc/<app>/backend.env`, mode 640,
root:APP_GROUP). It's linked into each release where the app expects it (`SHARED_LINKS="api/app/.env=/etc/<app>/backend.env"`).
Check where the app reads it from: `@nestjs/config` and `dotenv` read relative to the **cwd** by default.

**Next.js (`next start`)**
- `NEXT_PUBLIC_*` are inlined at build time. They're CI repository variables, not server settings.
- Ship `.next/` (without `.next/cache`), `public/`, `next.config.*`, `package.json`, production
  `node_modules`. Or use `output: 'standalone'` and ship `.next/standalone` + `.next/static` + `public`,
  which is smaller but a different start command (`node server.js`). Use whichever the project already uses.
- Build with `NODE_ENV=production`. A runner-wide `NODE_ENV=development` breaks `next build`.
- Anything `next.config.js` `require`s at start (for example a security-policy module) must be in the bundle.

**NestJS / Express**
- Migrations usually run from compiled JS: `node ../node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js`
  (TypeORM), `npx prisma migrate deploy` (Prisma, which needs the `prisma` CLI and schema in the bundle),
  `npx knex migrate:latest`, `npx sequelize-cli db:migrate`. Run them **as the app user, inside the new release,
  before switching**. A failure there leaves the live release untouched.
- The health endpoint should check the database and report the release. Pass the commit as an env var from
  the PM2 config (`RELEASE_VERSION` read from `RELEASE.txt`), so `/health` shows exactly what is running.

## B. Node services under systemd

**When:** the server already uses systemd units for the app, or the team prefers
it to PM2.

- One unit per process (`templates/process/app.service`), `WorkingDirectory=<BASE>/current/...`,
  `EnvironmentFile=/etc/<app>/app.env`, `User=<APP_USER>`, `Restart=always`.
- Set `PROCESS_MANAGER=systemd` and `SYSTEMD_UNITS="app-api app-web"` in `deploy.conf`. The release manager runs
  `systemctl restart` after the switch. A restart briefly drops connections. If that matters, use socket
  activation or two instances behind nginx, but only if the user asks for it.
- The unit files are installed once by root (`server-setup.sh`), not by each deploy, so a deploy can't change
  how the service runs.

## C. Static frontends

**When:** React (CRA), Vite, Angular, Vue, Svelte static builds, or Next.js with
`output: 'export'`.

- Build in CI with the production API URL and base path baked in (`VITE_API_URL`, Angular
  `environment.prod.ts`, `base` / `baseHref`).
- The bundle is the build output (`dist/`, `build/`, `out/`, Angular's `dist/<project>/browser`) plus `RELEASE.txt`.
  Put a `version.json` with the commit at the site root, so verifying from outside is a single `curl`.
- `PROCESS_MANAGER=none`. `HEALTH_CHECKS` fetches the public URL (or `version.json`) and the commit check
  reads `version.json`.
- **Document root** → `<BASE>/current` (or `current/browser`). The BASE must be inside the subscription
  home for Plesk to accept it, for example `/var/www/vhosts/example.com/app`, document root `app/current`.
- **SPA fallback:** client-side routes need unknown paths to serve `index.html`. With nginx serving static
  files: `templates/plesk/nginx-spa-directives.conf`. With Apache handling the request, use an `.htaccess`
  with a rewrite to `index.html` in the build output. Check which serves the domain before choosing.
- Cache: hashed assets can be cached for a long time, but `index.html` mustn't be,
  or browsers keep loading the old release.

## D. PHP and Laravel

**When:** a Laravel, Symfony or plain PHP app, served by Plesk's PHP-FPM.

- **Build on the runner:** `composer install --no-dev --optimize-autoloader --no-interaction`, plus
  `npm ci && npm run build` for Vite/Mix assets. Ship the app with `vendor/` and `public/build/`, without
  `node_modules/`, `tests/` or `.git`. The PHP version on the runner (`shivammathur/setup-php`) must match the
  domain's PHP major.minor. Write `php_version=` into `RELEASE.txt` and add a check if it matters.
- **Shared:** `.env` (`SHARED_LINKS=".env=<BASE>/shared/.env storage=<BASE>/shared/storage"`). Laravel's
  `storage/` holds logs, sessions, cache and uploads, so it is shared, with the
  `app/public`, `framework/{cache,sessions,views}` and `logs` folders created
  once. Keep `public/storage` → `storage/app/public` inside the release (`php artisan storage:link`, or
  ship the symlink relative).
- **Migrations:** `MIGRATE_CMD="php artisan migrate --force"`, using the domain's PHP binary
  (`/opt/plesk/php/8.3/bin/php artisan ...` or whatever `ls /opt/plesk/php/` shows).
- **After the switch:** `POST_SWITCH_CMD="php artisan config:cache && php artisan route:cache && php artisan view:cache && php artisan queue:restart"`.
  Cached config holds the `.env` values, so re-cache on every deploy and after every `.env` change.
- **Reload PHP-FPM** (`PROCESS_MANAGER=php-fpm`, `PHP_FPM_SERVICE=plesk-php83-fpm`) so OPcache doesn't keep
  serving the old release's files through the old symlink target.
- **Document root** → `<BASE>/current/public`, with BASE inside the subscription home (open_basedir and
  Apache's symlink ownership rules both expect it). Owner and group should match the existing `httpdocs`
  (check with `stat`). Don't guess them.
- **Workers:** queue workers (`php artisan queue:work`) under supervisor, systemd or PM2
  (`interpreter: 'php'`), started from `current`, and restarted after each deploy (`queue:restart`).
  **Scheduler:** one cron line, `* * * * * cd <BASE>/current && php artisan schedule:run >> /dev/null 2>&1`,
  in the system user's crontab (Plesk Scheduled Tasks).
- **Maintenance mode** (`php artisan down`) is only needed for migrations that
  aren't backward compatible. Design migrations so they are, and you won't need it.

## E. WordPress

WordPress keeps its state in the database and `wp-content/uploads`, and both
belong to production. **Don't release WordPress core, the database or uploads
from git.**

- Deploy only what the team writes: a theme (`wp-content/themes/<theme>`), a plugin, or `mu-plugins`.
  The release is that folder. `SHARED_LINKS` isn't needed. The trick is the other way round: link
  `wp-content/themes/<theme>` → `<BASE>/current`, once, by root, after backing up the folder that is there.
- If the theme has a build step (Sass, webpack), build in CI and ship the built theme.
- Plugin and core updates stay in WordPress (or Plesk's WP Toolkit), with a backup first, outside this pipeline,
  unless the team already manages them with Composer (Bedrock). In that case the Laravel-like model (D)
  applies to the whole app, with `web/app/uploads` shared.
- Never push a local database to production. Content flows from production to staging, not the other way.
- Health check: the home page, and `wp-admin` returning a redirect to login.

## F. Full-stack: separate frontend and backend

- **One bundle, one release, one switch** when both are in one repository and
  are released together, as in the reference implementation. Frontend and API
  can't drift apart, and rollback moves both.
- **Two release managers** (two BASEs, two `<app>-deploy` names) when they are
  released separately or live in separate repositories. Then the API must stay
  compatible with the previous frontend, and the other way round.
- Each process listens on its own localhost port. Plesk's nginx proxies each domain or path to it.
  Keep the ports already in use, and keep them closed in the firewall.
- CORS, cookie domain, `FRONTEND_URL` / `API_URL` and CSP have to agree across
  both domains. They're usually where "works locally, fails in production" comes
  from.

## G. Plesk's own tools

**Git extension** (Websites & Domains → Git): pulls from a remote on push (with a
webhook) or by hand, and can run "additional deployment actions" (shell
commands). It suits a small static or PHP site whose owner wants to manage it in
Plesk. Its limits:

- It builds on the server (load, dependencies, memory) and deploys into the live
  folder, so a failed build can leave the site half updated.
- There's no approval step and no automatic rollback. Rolling back means
  redeploying an older commit.

If the user chooses it anyway, keep the safety rules: don't deploy over a dirty
folder, back up before migrating, and verify from outside afterwards.

**Node.js extension** (Passenger): Plesk runs the app from an "Application root"
with an "Application startup file". If a site already uses it, you can point the
application root at `<BASE>/current/...` and restart with
`touch <app root>/tmp/restart.txt`, or the extension's own restart. Confirm that
works on this Plesk version before you rely on it. Don't run PM2 *and* Passenger
for the same app.

## Choosing where the release lives

| Model | BASE | Why |
|---|---|---|
| Node under PM2/systemd, proxied | Anywhere the app user can read: `/var/www/<app>-app` | nginx proxies to a port; it never reads the files |
| Static, PHP, WordPress theme | Inside the subscription home: `/var/www/vhosts/<domain>/<app>` | The document root and PHP's open_basedir must reach it |

Keep the env file and backups **outside** any document root. If the old checkout
was inside `httpdocs`, the new layout is a chance to move secrets out of the web
root. Do it by copying, and check from outside that nothing is exposed.

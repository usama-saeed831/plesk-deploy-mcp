# The release manager

`templates/server/app-deploy` is one bash script (portable to bash 3.2, so it can
be tested on a Mac), installed as `/usr/local/bin/<app>-deploy` and configured by
`/etc/<app>/deploy.conf`. The deploy user may run it, and only it, with sudo.

```
sudo <app>-deploy <bundle.tgz>   # deploy (GitHub Actions runs this)
sudo <app>-deploy --rollback     # previous good release
sudo <app>-deploy --status       # releases, commits, which is live
sudo <app>-deploy --log 200      # the end of the deploy log (it is root-only)
```

## What a deploy does, and why

| Step | What | Why |
|---|---|---|
| 1 | Accept only a `.tgz` in `INCOMING` (resolved path, no symlink) | sudo runs it as root, so it must not unpack an arbitrary path |
| 2 | Unpack into `releases/<UTC timestamp>` | each release is complete and separate; the live one is never written to |
| 3 | Check `REQUIRED_FILES`, and `node_major` from `RELEASE.txt` against the server's Node | a bundle built for another runtime fails here, not after the switch |
| 4 | Link `SHARED_LINKS` (env files, uploads, storage) | state outlives releases; a release never contains secrets |
| 5 | `chown` to `APP_USER:APP_GROUP` | the app user runs migrations and the processes |
| 6 | `PRE_MIGRATE_CMD` as root (a dump) | a way back from a bad migration |
| 7 | `MIGRATE_CMD` as the app user, in the new release | runs before the switch: if it fails, nothing live changed |
| 8 | Switch `current` atomically (`ln -sfn` + `mv -T`) | there's never a moment without a `current` |
| 9 | Reload: PM2 `startOrReload --update-env` + `save`, or `systemctl restart`, or a php-fpm reload; then `POST_SWITCH_CMD` | |
| 10 | `HEALTH_CHECKS` until healthy or `HEALTH_TIMEOUT_SECONDS`, plus `HEALTH_COMMIT_URL` must contain the commit | proves the *new* code is answering, not the old process that hasn't restarted |
| 11 | Unhealthy: switch back, reload, check the old one, rename the new release `-failed` | automatic rollback |
| 12 | Healthy: delete the uploaded bundle, prune to `KEEP_RELEASES` (never the live one; 3 failed kept for reading) | disk |

Every step logs to `LOG_FILE` and to the GitHub step output. Two deploys can't
overlap, because of `flock` (or a `mkdir` lock where `flock` doesn't exist).

**A rollback switches code only. Migrations aren't undone.** That's why migrations must be additive: see
`rollback.md` and `environment-and-database.md`.

## Settings (`deploy.conf`)

All settings are shell assignments. The file holds no secrets (mode 644, root-owned).

| Setting | Meaning | Example |
|---|---|---|
| `BASE` | Where releases live | `/var/www/myapp-app` |
| `APP_USER`, `APP_GROUP` | The account that runs the app (owns the PM2 processes, or the PHP files) | `myapp_sys` / `psacln`. Find it, don't guess |
| `DEPLOY_USER`, `INCOMING` | The SSH account GitHub uses, and its upload folder | `myapp-deploy`, `/home/myapp-deploy/incoming` |
| `PROCESS_MANAGER` | `pm2`, `systemd`, `php-fpm` or `none` | |
| `NODE_BIN_DIR` | Folder with the `node` (and `pm2`) the app uses | `/opt/plesk/node/24/bin` |
| `PM2_HOME` | That account's PM2 home, if not `~/.pm2` | `/root/.pm2` |
| `PM2_ECOSYSTEM` | The PM2 file inside a release, copied to BASE | `ecosystem.config.js` |
| `PM2_APPS` | `name=path/under/current` per process, to move processes off an old cwd once | `"myapp-api=api/app myapp-web=web/app"` |
| `SYSTEMD_UNITS` | Units to restart | `"myapp-api myapp-worker"` |
| `PHP_FPM_SERVICE` | FPM service to reload | `plesk-php83-fpm` |
| `SHARED_LINKS` | `path/in/release=/absolute/target`, space-separated | `".env=/etc/myapp/app.env storage=/var/www/vhosts/example.com/myapp/shared/storage"` |
| `REQUIRED_FILES` | Must exist in a release | `"RELEASE.txt dist/main.js package.json"` |
| `PRE_MIGRATE_CMD` | Root, in the new release, before migrating (`$RELEASE_ID` is set) | `"/usr/local/bin/myapp-db-backup"` |
| `MIGRATE_CMD` | App user, in the new release | `"NODE_ENV=production node node_modules/typeorm/cli.js migration:run -d dist/data-source.js"` |
| `POST_SWITCH_CMD` | App user, in `current`, after the reload | `"php artisan config:cache && php artisan queue:restart"` |
| `HEALTH_CHECKS` | `url` or `url\|text it must contain`, space-separated (no spaces inside) | `'http://127.0.0.1:3001/health/ready|"status":"ready" http://127.0.0.1:3000/'` |
| `HEALTH_COMMIT_URL` | Its answer must contain the release's commit | `http://127.0.0.1:3001/health/ready` |
| `HEALTH_TIMEOUT_SECONDS` | How long to wait for healthy | `90` |
| `KEEP_RELEASES` | Good releases kept | `5` |
| `LOG_FILE`, `LOCK_FILE` | | `/var/log/myapp-deploy.log` |

Prefer `127.0.0.1:<port>` health URLs for proxied apps: they test the new
process directly. The pipeline then tests the public URL from outside. For a
static or PHP site served by Plesk, use the public URL with a `version.json` (or
a meta tag) carrying the commit.

## Configurations per stack

**Node API + Next.js under PM2** (the reference implementation, generalised):
```bash
PROCESS_MANAGER=pm2
NODE_BIN_DIR=/opt/plesk/node/24/bin
PM2_APPS="myapp-backend=api/app myapp-frontend=web/app"
SHARED_LINKS="api/app/.env=/etc/myapp/backend.env api/app/uploads=/var/www/myapp-app/shared/uploads"
REQUIRED_FILES="RELEASE.txt ecosystem.config.js api/app/dist/main.js web/app/.next/BUILD_ID"
PRE_MIGRATE_CMD="/usr/local/bin/myapp-db-backup"
MIGRATE_CMD="cd api/app && NODE_ENV=production node ../node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js"
HEALTH_CHECKS='http://127.0.0.1:3001/api/v1/health/ready|"status":"ready" http://127.0.0.1:3000/'
HEALTH_COMMIT_URL=http://127.0.0.1:3001/api/v1/health/ready
```

**Express API under systemd, Prisma:**
```bash
PROCESS_MANAGER=systemd
SYSTEMD_UNITS="myapp-api"
SHARED_LINKS=".env=/etc/myapp/app.env"
REQUIRED_FILES="RELEASE.txt dist/server.js node_modules/.prisma"
MIGRATE_CMD="npx --no-install prisma migrate deploy"
HEALTH_CHECKS="http://127.0.0.1:4000/health"
HEALTH_COMMIT_URL=http://127.0.0.1:4000/version
```

**Vite / Angular static site:**
```bash
BASE=/var/www/vhosts/example.com/site       # document root in Plesk: site/current
PROCESS_MANAGER=none
REQUIRED_FILES="RELEASE.txt index.html version.json"
HEALTH_CHECKS="https://example.com/"
HEALTH_COMMIT_URL=https://example.com/version.json
```

**Laravel:**
```bash
BASE=/var/www/vhosts/example.com/laravel    # document root: laravel/current/public
APP_USER=<subscription system user>; APP_GROUP=psacln   # match `stat` of httpdocs
PROCESS_MANAGER=php-fpm
PHP_FPM_SERVICE=plesk-php83-fpm
SHARED_LINKS=".env=/var/www/vhosts/example.com/laravel/shared/.env storage=/var/www/vhosts/example.com/laravel/shared/storage"
REQUIRED_FILES="RELEASE.txt artisan vendor/autoload.php public/index.php"
PRE_MIGRATE_CMD="/usr/local/bin/myapp-db-backup"
MIGRATE_CMD="/opt/plesk/php/8.3/bin/php artisan migrate --force"
POST_SWITCH_CMD="/opt/plesk/php/8.3/bin/php artisan config:cache && /opt/plesk/php/8.3/bin/php artisan route:cache && /opt/plesk/php/8.3/bin/php artisan view:cache && /opt/plesk/php/8.3/bin/php artisan queue:restart"
HEALTH_CHECKS="https://example.com/up"       # Laravel 11's health route, if enabled
```

**WordPress theme:**
```bash
BASE=/var/www/vhosts/example.com/theme-releases   # wp-content/themes/<theme> -> BASE/current, linked once by root
PROCESS_MANAGER=php-fpm
PHP_FPM_SERVICE=plesk-php82-fpm
REQUIRED_FILES="RELEASE.txt style.css functions.php"
HEALTH_CHECKS="https://example.com/"
```

Each of these is an example. Every value comes from the server's own discovery
output.

## The pre-migration dump

`templates/server/db-backup` reads the database login from the app's env file
(`DB_*`, Laravel's `DB_DATABASE`/`DB_USERNAME`, or `DATABASE_URL` for
PostgreSQL). It writes `pg_dump -Fc` or `mysqldump --single-transaction` to
`BACKUP_DIR/pre-<release>.dump`, mode 600, keeps the newest five, and fails the
deploy if the dump fails. It doesn't replace the daily, off-server, tested
backups.

## The one-time set-up

`templates/server/server-setup.sh`, run by root, safe to run again:

1. The first run writes `/etc/<app>/deploy.conf` from the example and stops, so the user fills it in.
2. Validates the settings: users and groups exist, the runtime is where it says.
3. Creates the deploy user, its `incoming/`, and `authorized_keys` with `restrict` on the deploy key.
4. Installs `/etc/sudoers.d/<app>-deploy` (validated with `visudo -cf`): the deploy user may run
   `/usr/local/bin/<app>-deploy` and nothing else.
5. Creates BASE, `releases/`, `shared/`, the backup folder (700) and the log.
6. **Copies** (never moves) the env file and uploads from the current checkout, if one is given. It never
   overwrites existing ones.
7. Installs the release manager and the backup helper, and checks the database login.
8. Prints what's left (PM2 startup for the app user, Plesk document root, etc.).

## Testing it without a server

`scripts/test-release-manager.sh <path to the adapted app-deploy>` builds a
temporary BASE, stand-in `pm2`/`systemctl`/migrate/backup commands and
`file://` health URLs. It runs the scenarios that matter: first deploy, second
deploy, failed health with automatic rollback, failed migration with nothing
switched, a missing required file, a bundle outside `INCOMING`, a Node major
mismatch, `--rollback`, `--status`, pruning, the lock, and `--log`. Run it after every
change to the script. It needs only bash, tar and curl.

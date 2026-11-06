<!-- TEMPLATE for deploy/plesk/README.md in the target repository.
     Replace every <placeholder>, delete sections the project doesn't use, and keep
     the tables: they're what people open in an incident. Names of secrets only,
     never values. -->

# Deploying <app> to Plesk from GitHub Actions

Every push to `<main>` is tested and built on GitHub. It's deployed to the Plesk
server only once the tests pass and somebody approves it. Nothing is built on the
server: it only unpacks a finished release, migrates, and switches to it.

| File | What it does |
|---|---|
| `.github/workflows/deploy-plesk.yml` | Tests (calls `ci.yml`) and builds in parallel, waits for approval, uploads the bundle and runs the release manager |
| `.github/workflows/ci.yml` | The tests. Also runs on pull requests and other branches; those never deploy |
| `build-bundle.sh` | Builds the release bundle on the runner |
| `<app>-deploy` | The release manager on the server: deploy, `--rollback`, `--status` |
| `<app>-db-backup` | The database dump before each migration |
| `server-setup.sh` | One-time set-up of the server. Safe to run again |
| `deploy.conf.example` | The settings, installed as `/etc/<app>/deploy.conf` |
| `ecosystem.config.js` / `*.service` | The processes, run from `current` |

## How a deploy works

1. A push to `<main>` starts **Deploy to Plesk**. The tests and the bundle build run side by side.
2. A push that changes only <docs/…> is tested, and nothing is deployed.
3. **Deploy to production** waits for approval (Actions → the run → **Review deployments**).
4. Once approved, the bundle is copied to the server and `sudo <app>-deploy` runs. It:
   - unpacks it into `<BASE>/releases/<date-time>` and checks its contents and runtime version;
   - links the shared <`.env`, uploads, storage> into it;
   - takes a database dump, then runs the migrations;
   - switches `current` to the new release and reloads <PM2 / the services / PHP-FPM>;
   - checks <the health URL> answers **and reports the new commit**.
5. If the checks fail, it switches back to the previous release by itself. A failure up to and including the
   migrations never touches the live site.
6. The workflow then checks <public health URL> from outside.

## One-time set-up

### On the server (as root)

1. <What discovery found: who runs the app, on which runtime, from where. The commands to check it.>
2. Copy this folder to the server, and run the set-up once to write the settings file:
   `scp -r deploy/plesk root@<server>:/root/<app>-kit` then `sudo bash /root/<app>-kit/server-setup.sh`.
   Fill in `/etc/<app>/deploy.conf`.
3. Make the deploy key **on your own machine**:
   `ssh-keygen -t ed25519 -N '' -f ~/.ssh/<app>_deploy`, then
   `scp ~/.ssh/<app>_deploy.pub root@<server>:/root/`.
4. Run the set-up for real:
   `sudo bash /root/<app>-kit/server-setup.sh --public-key /root/<app>_deploy.pub --from-checkout <current folder>`.
   It copies (doesn't move) the current env file and uploads. The site keeps running as it does until the
   first deploy.
5. <Anything else: PM2 startup, systemd units, Redis database number.>

### In Plesk

- <What stays the same: proxy, ports, document root. Or the exact change, with its click path.>
- SSL: <certificate, redirect>. Check the chain after any certificate change.
- Firewall: ports <…> closed to the outside.

### In GitHub (Settings)

1. **Environments → New environment → `production`**: required reviewers <who>; deployment branches `<main>` only.
2. **Environment secrets** in `production`:

   | Secret | Value |
   |---|---|
   | `PLESK_SSH_HOST` | The server's address |
   | `PLESK_SSH_USER` | `<app>-deploy` |
   | `PLESK_SSH_KEY` | The whole private key file `~/.ssh/<app>_deploy` |
   | `PLESK_SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <server>` |
   | `PLESK_SSH_PORT` | Only if SSH isn't on 22 |

3. **Repository variables** (Secrets and variables → Actions → Variables → *Repository*, not the environment):

   | Variable | Value |
   |---|---|
   | `<PUBLIC_API_URL>` | `<https://…>` |

The app's own secrets stay in `<ENV_FILE>` on the server. They never go into GitHub.

### The first deploy

1. Push a branch first: CI runs, and nothing deploys.
2. Merge to `<main>` (or Actions → Deploy to Plesk → Run workflow), approve, and watch **Deploy on the server**.
3. <What's special about the first one, for example PM2 moving off the old checkout.>
4. Check from outside that <health URL> reports the commit. Then do a rollback drill (below) and deploy again.

## Every day

| To | Do |
|---|---|
| Deploy | Push to `<main>`, then approve the run |
| Deploy an older commit | Actions → Deploy to Plesk → Run workflow → `ref` |
| Deploy without tests (emergency only) | Run workflow → tick `skip_tests` |
| Deploy the same bundle again | Re-run failed jobs on the run (the bundle is kept for 7 days) |
| Roll back | `sudo <app>-deploy --rollback` on the server |
| See what's live | `sudo <app>-deploy --status` |
| Read the deploy log | `sudo tail -n 200 /var/log/<app>-deploy.log` |
| Read the app's logs | <`sudo -u <user> pm2 logs <name> --lines 100` / `journalctl -u <unit>` / Plesk → Logs> |
| Change a setting | Edit `<ENV_FILE>`, then <`pm2 reload all --update-env` / `systemctl restart …` / `php artisan config:cache`> |

## Rollback and migrations

A rollback switches the code back. It does **not** undo migrations. Migrations
add rather than remove (expand now, contract in a later release), which keeps the
previous release working. Never edit a migration that has already run.

Each deploy leaves a database dump in `<BACKUP_DIR>/pre-<release>.dump` (the newest five). Those are for undoing
one deploy. The daily backups are <where, how often, last restore test>.

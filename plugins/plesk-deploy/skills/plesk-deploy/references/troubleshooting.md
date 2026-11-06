# Troubleshooting

Read the actual error first: the GitHub step log, then
`sudo tail -n 200 /var/log/<app>-deploy.log`, then the app's own logs. Fix the
cause, not the symptom. Entries marked **(seen)** happened while setting up the
reference implementation. The others are common on Plesk.

## Contents

- In GitHub Actions
- Connecting to the server
- In the release manager
- After the switch: the app
- Plesk, nginx and PHP
- On the server set-up

---

## In GitHub Actions

| Symptom | Cause | Fix |
|---|---|---|
| Build job fails at once: "Set the repository variable …" **(seen)** | The variable was created as an *environment* variable (or not at all); the build job has no environment | Settings → Secrets and variables → Actions → **Variables → Repository variables**. Re-run |
| "Missing secrets in the production environment: …" | Secrets added as repository secrets, or to another environment | Settings → Environments → `production` → Environment secrets |
| `next build` fails with odd React/prerender errors in CI only **(seen)** | `NODE_ENV=development` set for the job | Set `NODE_ENV=production` on the build and start commands |
| Static or audit step fails on the first run **(seen)** | A new advisory in a dependency | Upgrade, or `overrides` for a transitive dependency; don't lower the audit level |
| An integration shard fails, the same test passes alone **(seen)** | Test depends on another test having run first (data or app state) | Make the test set up what it needs; don't un-shard |
| Browser test fails on a step the app requires **(seen)** | The test's fixture is missing a field production validation now requires | Fix the fixture, and assert each step succeeded so the failure points at the right step |
| Deploy job skipped though tests passed | The change filter decided "docs only", or `needs.*.result` was `skipped` and the `if:` didn't allow it | Check the "Is there anything to deploy?" step; check the job's `if:` |
| Deploy job waits forever | Nobody approved; or the run's branch isn't allowed by the environment's branch rule | Review deployments; check Environments → `production` → deployment branches |

## Connecting to the server

| Symptom | Cause | Fix |
|---|---|---|
| `Host key verification failed` | `PLESK_SSH_KNOWN_HOSTS` missing, for another key type, or another port | `ssh-keyscan -t ed25519 [-p port] <host>`; paste the whole line |
| `Permission denied (publickey)` | The public key isn't in the deploy user's `authorized_keys`, wrong user, or wrong permissions | `server-setup.sh --public-key …` again; `~/.ssh` 700, `authorized_keys` 600, owned by the deploy user |
| `Load key …: invalid format` | `PLESK_SSH_KEY` truncated, or the public half pasted | Paste the whole private key file, BEGIN and END lines included |
| `sudo: a password is required` | The sudoers rule names another path, or wasn't installed | `sudo -l -U <app>-deploy`; the path must match `/usr/local/bin/<app>-deploy` exactly |
| `sudo: sorry, you must have a tty` | `requiretty` on this distribution | `Defaults:<app>-deploy !requiretty` in the rule |
| `scp: … No such file or directory` | `incoming/` missing in the deploy user's home | Re-run `server-setup.sh` |
| Times out | SSH limited by IP or on another port | `PLESK_SSH_PORT`; discuss runner IPs with the user |

## In the release manager

| Message | Cause | Fix |
|---|---|---|
| Stops with no FAILED line, right after "is live" or during pruning **(seen)** | A `grep` that matched nothing, under `set -o pipefail`, ended the script | Wrap such pipelines `{ … \|\| true; }` and end helper functions with `return 0`. The template already does |
| "Bundles are only taken from …" | The command was given another path (or `~` expanded differently) | Upload to `INCOMING`, pass `~/incoming/<file>` from the deploy user's shell |
| "Missing from the release: …" | The bundle script didn't copy a file, or the path in `REQUIRED_FILES` is wrong | Fix the bundle script; list the tarball (`tar tzf … \| head`) |
| "The bundle was built with Node X; this server runs Node Y" | `.nvmrc` and the server's Node differ, or `NODE_BIN_DIR` points at the wrong Node | Use the Node the app's processes use (`pm2 info` shows it), or change `.nvmrc`; never bypass the check |
| "Shared target missing" | The env file or uploads folder isn't there | `server-setup.sh`, or create it; check the path in `SHARED_LINKS` |
| "The pre-migration step (backup) failed" | `pg_dump`/`mysqldump` missing, version older than the server, or login failed | Install the client of the same major; check the login from the env file |
| "The migrations failed" **(seen)** | A migration that runs locally fails on production data or a stricter engine (for example `COMMENT ON … IS` given an expression instead of a string literal) | Nothing was switched. Fix it in a *new* commit; never edit a migration that already ran elsewhere |
| "Not healthy after 90s" then "Back on …" | The new release doesn't start or doesn't pass its checks | Read the app's logs for the new release (the `-failed` folder still exists); fix and deploy again |
| Healthy except the commit check | The app doesn't get `RELEASE_VERSION`, or the health URL doesn't include it | Check the process config passes it (PM2 `--update-env`), and the endpoint reports it |
| "Another deploy is running" | One is; or a run stopped without clearing the `mkdir` lock (only where `flock` is missing) | Wait; if none runs, `rmdir <LOCK_FILE>.d` |

## After the switch: the app

| Symptom | Cause | Fix |
|---|---|---|
| 502 Bad Gateway from the domain | Nothing listening on the proxied port: crashed, wrong `PORT`, still starting | `pm2 logs <name>`, `ss -ltnp \| grep <port>`; compare `PORT` in the env file with the proxy |
| PM2 still runs the old code | Process started from an old checkout keeps its cwd through a reload | `PM2_APPS` makes the release manager delete and start it once from `current`. Check with `pm2 info <name> \| grep 'exec cwd'` |
| `pm2 ls` shows nothing | PM2 commands run as another account than the one that owns the processes | Run as `APP_USER` with its `PM2_HOME` |
| Apps don't come back after a reboot | `pm2 startup` not configured for the app user, or `pm2 save` not run | `pm2 startup systemd -u <user> --hp <home>` (as root, with Node on PATH), then `pm2 save` |
| "Cannot find module …" | A run-time file or dependency not in the bundle; a workspace symlink pointing back into the runner | Add it to the bundle script; remove workspace symlinks; install prod deps per app |
| Native module error (`invalid ELF header`, `NODE_MODULE_VERSION`) | Built for another OS or Node major | Build on Linux with the server's Node major (the Node check should have caught it) |
| Config change has no effect | The process kept its old environment | `pm2 reload all --update-env`; Laravel `config:cache` |
| Sessions or uploads lost after deploy | They were inside the release folder | Move them to `shared/` and link them |

## Plesk, nginx and PHP

| Symptom | Cause | Fix |
|---|---|---|
| Plesk refuses the nginx directives: `duplicate location "/"` | Plesk already generates `location /` for this domain (proxy mode on, or the Node.js extension) | Turn off proxy mode / the extension for that domain only if the plan says so, or use a different location; never edit generated files |
| Static files 404 while the app works locally | nginx serves static files itself from the document root | Turn off "Serve static files directly by nginx" for a proxied app |
| SPA routes 404 on refresh | No fallback to `index.html` | `templates/plesk/nginx-spa-directives.conf`, or an Apache rewrite |
| PHP: `open_basedir restriction in effect` | Releases or shared files outside the webspace | Keep BASE inside `/var/www/vhosts/<domain>/`; adjust open_basedir only if the user agrees |
| PHP serves the previous release after the switch | OPcache / realpath cache | `PROCESS_MANAGER=php-fpm` with the domain's FPM service |
| 403 on a symlinked document root | Apache `SymLinksIfOwnerMatch` and different owners | Release and `current` owned by the subscription user, as `httpdocs` is |
| Document root can't be set to the release path | Path outside the subscription home | Move BASE inside it |
| Certificate works in browsers, fails for webhooks or `curl` | Incomplete chain | Reissue in Plesk; check `-showcerts` shows 2+ certificates |

## On the server set-up

| Symptom | Cause | Fix |
|---|---|---|
| `server-setup.sh: command not found` **(seen)** | Run as a command from a folder not on PATH, or not executable | `sudo bash /root/<app>-kit/server-setup.sh` |
| Paths in the docs don't exist on the server **(seen)** | Production was set up differently from the docs (the app ran from `httpdocs`) | Use the paths `pm2 info` and `ls` show; fix the docs |
| "STOPPED: Wrote … from the example" | The first run, by design | Fill in the settings, run again |
| Database login check fails | Plesk prefixed the database or user name; wrong host (`localhost` versus `127.0.0.1` uses a socket versus TCP) | Use the exact names from Plesk → Databases; match the host the app uses |

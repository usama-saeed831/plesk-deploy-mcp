# Security and safety

## The deploy account

GitHub Actions signs in as a dedicated account (`<app>-deploy`) that can do
exactly two things: upload a file into its `incoming/` folder, and run the
release manager.

- **Its own key pair**, made for this purpose only: `ssh-keygen -t ed25519 -N '' -f ~/.ssh/<app>_deploy`
  on the user's machine. The public half goes to the server, the private half into the `PLESK_SSH_KEY`
  environment secret. Never reuse a personal key or root's key.
- `authorized_keys` line prefixed with **`restrict`** (no terminal, no forwarding, no agent). It can still
  run commands and `scp`. If the user wants it tighter still, a `command=` wrapper can allow only `scp -t`
  into `incoming/` and the one sudo command, but test it, because it breaks easily.
- **sudo for one command only**, in `/etc/sudoers.d/<app>-deploy`, validated with `visudo -cf` before
  installing:
  ```
  Defaults:<app>-deploy !requiretty
  <app>-deploy ALL=(root) NOPASSWD: /usr/local/bin/<app>-deploy
  ```
  The script is root-owned, mode 755, and validates its argument (a `.tgz` inside `INCOMING`, no symlink).
  Anyone who can edit the script or `deploy.conf` can run code as root, so both stay root-owned.
- `known_hosts` pinned in GitHub (`PLESK_SSH_KNOWN_HOSTS`), `StrictHostKeyChecking=yes`. The user runs
  `ssh-keyscan -t ed25519 <host>` and compares the fingerprint with
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.
- If the server limits SSH by IP, GitHub-hosted runners have changing addresses. Discuss that with the user
  (a self-hosted runner, or allowing GitHub's published ranges). Don't silently open SSH to the world.

## The account that runs the app

- Prefer the subscription's system user over root. If it runs as root today, keep it working, record it
  as a risk, and recommend moving it later as its own change.
- The env file is `root:<APP_GROUP>` mode 640: the app can read it, other site users can't, and the
  deploy user can't.
- Backups are root-only (700 folder, 600 files).
- Release folders are owned by the app user. The release manager `chown`s each
  one after unpacking.

## Nothing secret is reachable over HTTP

Check from outside, after set-up and after the first deploy:

```bash
for p in .env .git/config backend/.env storage/logs/laravel.log wp-config.php.bak composer.json package.json; do
  printf '%-32s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://example.com/$p")"
done
```

Each should be 403 or 404 (or the app's own 404 page). A 200 on `.env` or
`.git/config` is an incident. Stop, tell the user, and rotate whatever was
exposed. A proxied Node app with "serve static files directly by nginx" turned
on can expose files from the document root even though the app doesn't serve
them.

## Ports

App ports (3000, 3001, 4000…) listen on `127.0.0.1` where the app allows it, and
stay closed in the firewall (Plesk Firewall or the host's). Check:
`ss -ltnp | grep <port>` should show `127.0.0.1:<port>`. Otherwise check from
outside that `curl -m 5 http://<server ip>:<port>/` times out. Record other
tenants' ports so a new app doesn't collide with them.

## TLS

Let's Encrypt per domain in Plesk, HTTP→HTTPS redirect on, HSTS once everything
is on HTTPS. Check the chain from outside after any certificate change (some
clients fail on an incomplete chain even when browsers don't). Webhook providers
(payments, SMS, voice) usually need a valid public certificate and call the
public URL.

## Logs and reports

- Deploy logs (`/var/log/<app>-deploy.log`, GitHub step output) contain paths,
  commits and statuses. They never contain env values. Don't `echo` a secret,
  and don't `set -x` around anything that reads one.
- When the user pastes server output, check it for secrets before you quote it
  back. If one appears, say so and suggest rotating it. Don't repeat it.
- Reports, tickets and screenshots name secrets, never values.

## Changes to production

- Copy, never move. Add, never replace. Back up a file before you change it
  (`cp -p file file.$(date +%Y%m%d%H%M%S)`).
- Idempotent set-up: every step checks what is there. Running it twice changes nothing the second time.
- The old way of running keeps working until the first new deploy, and the old
  checkout is left in place as the way back. Only remove it later, with the
  user's agreement.
- Don't restart, upgrade or reconfigure shared services (nginx, PHP-FPM pools,
  Redis, PostgreSQL) as a side effect. If one needs changing, it's a separate,
  agreed step.

## Before you say "done"

- [ ] No secret in the repository, the workflow logs or your messages
- [ ] Deploy user: one key, `restrict`, one sudo command, validated sudoers
- [ ] Env file 640 outside any document root; backups 700/600
- [ ] `.env` and `.git` return 403/404 from outside
- [ ] App ports closed from outside
- [ ] TLS chain complete; HTTP redirects to HTTPS
- [ ] The app runs as the intended account; risks recorded if that's root

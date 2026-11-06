# Verification checklist

Use it for the first deploy, and in short form after any change to the pipeline.
Copy it into your report with each box ticked, marked *not checked*, or marked
*failed* along with the output.

## Before the first deploy

**Repository**
- [ ] The release manager passes `scripts/test-release-manager.sh` after adaptation
- [ ] `bash -n` on every shell script; `shellcheck` if available
- [ ] Workflow YAML parses (`python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' <file>`, or `actionlint`)
- [ ] The bundle script lists every file the app reads at run time (config modules, templates, JSON data)
- [ ] The health endpoint checks the database and reports the release
- [ ] Tests that read deployment files still pass (targeted run)
- [ ] No secret, hostname-specific password or private key in any committed file

**Server** (the user runs these, you read the output)
- [ ] `server-setup.sh` finished with no STOPPED line, and a second run changes nothing
- [ ] `sudo -l -U <app>-deploy` shows only `/usr/local/bin/<app>-deploy`
- [ ] `<app>-deploy --status` runs and shows nothing live yet
- [ ] The env file exists, 640, and has every key the app needs (key names compared against `.env.example`)
- [ ] The database login check in `server-setup.sh` passed
- [ ] The runtime the app uses is the major version the bundle is built for
- [ ] PM2 startup (or the systemd units) enabled for the app user

**GitHub**
- [ ] Environment `production`: required reviewers, branch rule `main`
- [ ] Environment secrets present (the workflow's first step says which are missing)
- [ ] Repository variables present: these are repository-level, not environment-level
- [ ] A branch push ran CI green, and didn't deploy

## During the first deploy

- [ ] Tests and bundle both green; bundle size reasonable (record it)
- [ ] Approval requested and given
- [ ] `Deploy on the server` log shows, in order: unpacked, commit, pre-migration dump, migrations, switch,
      reload (and, the first time, the processes moved to `current`), health checks passed, `is live`
- [ ] `Live, from outside` passed: the public health URL reports the new commit

## After it: the live application

From outside, through the real domain:
- [ ] `curl -sI https://<domain>/` returns 200 (or the expected redirect); HTTP redirects to HTTPS
- [ ] The public health or version URL reports the deployed **commit**
- [ ] Sign in works; one real journey works end to end (create something, see it, change it)
- [ ] Uploads from before the deploy still show (shared folder linked)
- [ ] Anything that depends on run-time config works: email sending (to a test address), webhooks reachable
- [ ] `.env`, `.git` and other private paths return 403/404 (`security-and-safety.md`)
- [ ] TLS chain complete

On the server:
- [ ] `<app>-deploy --status` shows the release marked live with the right commit
- [ ] `pm2 ls` (as the app user): the processes are online, restart count isn't climbing, cwd is under `current`
      (`pm2 info <name> | grep 'exec cwd'`). Or `systemctl status <unit>`.
- [ ] The app's logs show no errors since start (`pm2 logs <name> --lines 100 --nostream`, the Laravel log,
      Plesk's domain logs)
- [ ] Scheduled jobs and workers run from `current` and only once
- [ ] The pre-migration dump exists in the backup folder

## The rollback drill

Do it once, on purpose, while everyone is watching:
- [ ] Deploy a second time (any small change), so there's something to go back to
- [ ] `sudo <app>-deploy --rollback`: health checks pass, the public URL reports the previous commit
- [ ] Deploy again (re-run the workflow or push), and the newest commit is live again
- [ ] Record how long each took

## What to report

```
Live: <commit> at <time>, verified from outside (<URL> reports it).
Verified: <list>.
Not verified: <list, and why>.
For you to do: <list, each with where and how>.
Risks recorded: <for example, the app runs as root; restore never tested>.
```

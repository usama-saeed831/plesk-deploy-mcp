# Worked example: a NestJS API and a Next.js site on one Plesk server

This is the kind of production deployment the workflow was distilled from,
told end to end. It is **anonymised and illustrative**. The project is called
"Acme" here, and its names, domains, paths, ports, dates and versions are
changed or left out. The shape of the system and every lesson are kept.

Read it to see the pattern working end to end. **Don't copy its values.**
Even in the real system, the paths, users, ports and runtime were facts about
one server, and a new project has its own.

In the original, each fact was labelled with its source. The same labels are
used here, so you can see how a facts table is built:
- **repo**: read in the repository (`deploy/plesk/`, `.github/workflows/`, deployment docs)
- **server**: output that the server owner ran and pasted back during set-up
- **observed**: checked from outside (HTTP, TLS) or seen in GitHub Actions runs
- **documented**: written in the repository's docs and not independently checked on the server

## The application

| Fact | Value | Source |
|---|---|---|
| Shape | npm workspaces monorepo: `api` (NestJS, TypeORM), `web` (Next.js, `next start`), `mobile` (not deployed) | repo |
| Runtime | Node, pinned to one major in `.nvmrc`; the production Dockerfiles use the same major | repo |
| Database | PostgreSQL, native on the host. Migrations own the schema (`typeorm migration:run -d dist/database/data-source.js`), one transaction per migration | repo, documented |
| Config | `@nestjs/config` reads `.env` from the process's working directory; the data source calls `dotenv.config()` | repo |
| Build-time frontend values | `NEXT_PUBLIC_API_URL` | repo |
| Health | `GET /health/ready` reports `"status":"ready"` once its dependencies answer, and `release` from `RELEASE_VERSION` | repo |
| Scheduled work | Several NestJS `@Cron` jobs inside the API process, with a Redis-backed lock | repo |
| Redis | Optional (`REDIS_URL`). Without it, rate limits and job locks stay inside the one API process. Whether Redis ran on the server wasn't confirmed | repo; server: unknown |
| Run-time files | `api/uploads` (user-uploaded images) | repo |

## The server before the pipeline

| Fact | Value | Source |
|---|---|---|
| Hosting | Plesk. nginx proxies `example.com` → 127.0.0.1:3200 and `api.example.com` → 127.0.0.1:3201 through "Additional nginx directives"; serving static files through nginx is off | documented |
| Processes | PM2, **as root**: `acme-api` and `acme-web`, cluster mode, online | server (`pm2 ls`) |
| Working directory | `/var/www/vhosts/example.com/httpdocs/api`, a git checkout inside the domain's web folder. The docs said `/var/www/acme`, which didn't exist | server (`pm2 info`, `stat`) |
| Node | Plesk's build of the pinned major, at `/opt/plesk/node/<major>/bin/node`; `pm2` at `/usr/local/bin/pm2` | server |
| Previous deploy | By hand: `git pull` → build → `npm run migration:run` → `pm2 restart` | documented |
| `.env` exposure | `api/.env` sits inside `httpdocs`; requests for it from outside return 404 | observed |
| TLS | Let's Encrypt; complete chains for both domains | observed |
| Other tenants | Another site on the same server uses ports 5100–5102 and Redis's default database | documented, from the owner's report |

## What was built

| Piece | File | Notes |
|---|---|---|
| CI | `.github/workflows/ci.yml` | Runs on pull requests and non-main pushes, and is callable (`workflow_call` with `ref`, `skip_build`). Static checks, unit tests, integration tests in 3 shards, frontend, contract and browser tests, mobile, image builds |
| Deploy | `.github/workflows/deploy-plesk.yml` | Runs on a push to main or Run workflow (`ref`, `skip_tests`). Tests ∥ bundle → approval (`production` environment) → scp → `sudo acme-deploy` → an outside check that `/health/ready` reports the commit |
| Bundle | `deploy/plesk/build-bundle.sh` | Built on the runner. Production dependencies installed per app, as the Dockerfiles do it; workspace symlinks removed; `RELEASE.txt` with commit, ref, time and `node_major` |
| Release manager | `deploy/plesk/acme-deploy` | `templates/server/app-deploy` specialised: Node check, `pg_dump`, TypeORM migrations, PM2 |
| PM2 | `deploy/plesk/ecosystem.config.js` | Both apps run from `current/{api,web}`; `RELEASE_VERSION` is read from `RELEASE.txt` |
| Server set-up | `deploy/plesk/server-setup.sh` | Idempotent. Creates the deploy user `acme-deploy` with a `restrict` key and one sudo command. Copies the old checkout's `.env` and uploads |
| Docs | `deploy/plesk/README.md` | Set-up, the secrets table, the every-day table, rollback |

The server layout after set-up:
- `BASE=/var/www/acme-app`
- the env file at `/etc/acme/api.env` (640)
- uploads in `shared/uploads`
- pre-migration dumps in `/var/backups/acme`
- the log at `/var/log/acme-deploy.log`

`deploy.conf` has `APP_USER=root`, `APP_GROUP=root` and
`PM2_HOME=/root/.pm2`, which follow from the server facts above. Source: repo
and server.

On GitHub, there is a `production` environment with required reviewers that
allows only main. Its secrets are `PLESK_SSH_HOST`, `PLESK_SSH_USER`,
`PLESK_SSH_KEY` and `PLESK_SSH_KNOWN_HOSTS` (port 22 by default). There is
one repository variable, `NEXT_PUBLIC_API_URL`. Source: repo; the owner
confirmed they were added.

## What happened on the way (all observed)

1. **The first CI run failed, and each failure was fixed at its cause:**
   - new advisories in several dependencies (an upload middleware, an HTTP
     client and the frontend framework among them)
   - an integration suite that depended on test order
   - `NODE_ENV=development`, which broke `next build`
   - a browser test missing a field that onboarding now requires
2. **`server-setup.sh: command not found`.** It had to be run with
   `sudo bash …`.
3. **The deploy paths in the docs didn't match the server.** The real
   checkout was in `httpdocs`, so set-up was pointed at it.
4. **The bundle job failed until `NEXT_PUBLIC_API_URL` became a repository
   variable.** It had been created as an environment variable.
5. **The first deploy stopped silently after going live.** A `grep` in the
   pruning step matched nothing, and `pipefail` ended the script. The fix was
   `{ … || true; }` and `return 0`, and the template carries it.
6. **After that fix, it worked.** The owner reported the pipeline working end
   to end and the live site serving the new release.

Earlier, outside this pipeline, a production migration failed with
`syntax error at or near "||"` in a `COMMENT ON` statement. PostgreSQL needs
a string literal there, and the fix was a corrected migration. This is why
migrations run before the switch: the failure left the live release
untouched.

## Still open when the workflow was written up

- A rollback drill after the second release-managed deploy.
- Whether Redis runs on the server (`redis-cli ping`). If it does, the app
  should get its own database number, because the other tenant uses the
  default one.
- The apps run as root. A Plesk system user would be safer, as a separate
  change.
- The old checkout in `httpdocs` is kept as the way back until the new setup
  has proved itself.

## What to take from it, and what not

**Take:**
- the pipeline shape, built on the runner
- the approval gate
- release folders with an atomic switch
- migrations that run before the switch
- the commit check in the health endpoint
- automatic rollback
- the idempotent set-up that copies instead of moving
- the every-day table in the README

**Don't take:** root as the app user, the runtime version, the paths, the
port numbers, the TypeORM commands, or the monorepo bundle layout. These are
this project's facts. Find the new project's own.

# GitHub Actions: the pipeline

## Shape

```
pull_request / push to other branches ──► CI (tests)                       never deploys
push to main / Run workflow ──► Deploy to Plesk
                                 ├─ Tests  (calls CI with workflow_call)  ┐ in parallel
                                 ├─ Release bundle (build once)            ┘
                                 └─ Deploy to production   needs both; waits for approval
                                      download bundle → scp → ssh sudo <app>-deploy → check from outside
```

Why this shape:

- **Build once, deploy that.** The bundle that deploys is the one that was
  built from the tested commit. The server never runs `npm install` or a build.
- **Tests and build run in parallel**, so approval is ready sooner. The deploy
  job needs both.
- **The approval gate is a GitHub environment.** Required reviewers approve. Its
  secrets are released only to an approved job on an allowed branch.
- **CI stays one file.** The deploy workflow calls the existing CI with
  `workflow_call`, so tests aren't duplicated and can't drift.

Template: `templates/github/deploy-plesk.yml`. Making existing CI callable:
`templates/github/ci-callable.md`.

## Triggers and inputs

- `push: branches: [main]` (or the project's production branch) and `workflow_dispatch` with:
  - `ref`: deploy an older commit, tag or branch. The deploy **tooling** still comes from the newest commit
    (checked out separately), so a fix to the deploy scripts applies to old releases too.
  - `skip_tests`: an emergency switch. Make it obvious in the description, and record when it's used.
- `[skip ci]` in a commit message skips the whole run (GitHub's own behaviour).
- **Nothing to deploy:** when a push changes only docs, a mobile app or other
  non-deployed folders, test it and skip the deploy. Compare
  `github.event.before..HEAD`. Treat a new branch, a force-push or a missing
  `before` commit as "deploy".

## Secrets versus variables

The most common first-run failure is a value created in the wrong place.

| Kind | Where | Examples | Why there |
|---|---|---|---|
| SSH access to the server | **Environment secrets** of `production` | `PLESK_SSH_HOST`, `PLESK_SSH_USER`, `PLESK_SSH_KEY`, `PLESK_SSH_KNOWN_HOSTS`, `PLESK_SSH_PORT` | Released only to the approved deploy job |
| Public build-time settings | **Repository variables** (Actions → Variables → Repository) | `NEXT_PUBLIC_API_URL`, `VITE_API_URL`, `CSP_MODE` | The build job has no environment, so it can't read environment variables |
| The app's run-time secrets | **Not in GitHub.** The env file on the server | DB password, API keys, JWT secret, SMTP, payment keys | GitHub never needs them; fewer places to leak |

- Build-time values compiled into a frontend are public by definition. Never put
  a secret in one.
- Fail early and clearly: the first step of each job checks that its settings
  exist, names the missing ones, and says where to add them. It checks that the
  SSH key looks like a private key (`*"PRIVATE KEY"*`) without printing it.
- Use `StrictHostKeyChecking=yes` with `PLESK_SSH_KNOWN_HOSTS` from
  `ssh-keyscan -t ed25519 <host>`, which the user runs and checks. Don't use
  `StrictHostKeyChecking=no`.
- Remove the key in an `if: always()` step at the end.

## Environment `production`

The user does this by hand: Settings → Environments → New environment.

- Required reviewers: the people who approve releases.
- Deployment branches and tags: selected branches → `main`.
- Its secrets (above). Optionally a wait timer.
- Optionally `url:` on the job, so the run links to the live site.

## Concurrency

- CI: `group: ci-${{ github.event_name }}-${{ github.ref }}` with `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`,
  so a new push to a branch cancels the old run, but a test run on main isn't cancelled halfway.
- When CI is called from the deploy workflow, `github.event_name` and `github.ref` are the caller's, so the
  group includes the event name to keep them apart.
- Deploy job: `group: deploy-plesk-production`, `cancel-in-progress: false`. A started deploy always finishes,
  and later pushes queue behind it (GitHub keeps only the newest pending one).
- The release manager also holds its own lock on the server, in case two deploys arrive by other routes.

## The build job

- Two checkouts: `tooling` (this run's commit: the scripts) and `app` (the `ref` to release, `fetch-depth: 0`
  for the change filter).
- `actions/setup-node` with `node-version-file: tooling/.nvmrc` and the npm cache keyed on the app's lockfile.
- One script builds and stages (`templates/build/build-bundle.sh`): install, build, copy production files, write
  `RELEASE.txt`, check required files and that no symlink points outside the bundle, then `tar czf`.
  It writes `name=` and `commit=` to `$GITHUB_OUTPUT`.
- `actions/upload-artifact` with `retention-days: 7` and `compression-level: 0` (it's already gzipped).
  Keeping it a week means **Re-run failed jobs** can redeploy the same bundle without rebuilding.

## The deploy job

1. Check the secrets exist and are well-formed.
2. Download the bundle.
3. Write the key (mode 600) and `known_hosts`.
4. `scp` to the deploy user's `incoming/` folder.
5. `ssh ... "sudo /usr/local/bin/<app>-deploy ~/incoming/<bundle>"`. The release manager's output is the step log.
6. **From outside**, through Plesk's proxy and TLS: the public health URL answers and reports the commit that
   was built, and the site's front page answers 2xx. This catches proxy, DNS and certificate problems that
   localhost checks can't.
7. Remove the key.

## Making CI fast enough

- Run independent jobs in parallel: static checks, unit, integration, browser, build.
- Shard slow integration suites (`jest --shard=${{ matrix.shard }}/3`). Each shard gets its own database
  service, so they can't interfere.
- Cache the package manager and browser downloads (Playwright: cache `~/.cache/ms-playwright` keyed on its
  version).
- In the deploy run, skip CI's own build/image job (`skip_build: true` input) since the bundle job builds.

## Pitfalls seen in practice

- **Variable created as an environment variable** instead of a repository variable: the build job reads it as
  empty. The early check names it and says where it belongs.
- **`NODE_ENV=development` set for a whole job** breaks `next build`. Set `NODE_ENV=production` on build and
  start commands explicitly.
- **Audit gate fails on a new advisory** the day you set this up: upgrade (or override a transitive dependency)
  rather than lowering the gate.
- **Tests that depend on order** pass locally in one process and fail in a shard. Fix the test (make it
  set up what it needs) rather than un-sharding.
- **A release gate or script that looks for a specific workflow file** (for example "CI passed on this commit")
  needs updating when the tests move inside the deploy workflow: accept a deploy run whose `Tests / …` jobs all
  passed.
- **Path filters on the deploy workflow** (`on.push.paths`) skip the run entirely for those changes. Use the
  in-job change check instead, so the tests still run.

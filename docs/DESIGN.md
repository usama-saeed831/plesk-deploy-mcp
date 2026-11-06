# plesk-deploy-mcp: design for approval

Status: **proposal, not built yet**. The facts it relies on, with
citations, are in [RESEARCH.md](RESEARCH.md).

## 1. Decisions

### I need you to decide these

| # | Question | Options | My recommendation |
|---|---|---|---|
| **D2** | npm package name | (a) `plesk-deploy-mcp`, unscoped and free on 6 Nov. (b) `@<you>/plesk-deploy-mcp`, scoped, so nobody can take it. (c) A name without the brand, such as `release-deploy-mcp`. | **(a)**, plus a README line saying it isn't affiliated with Plesk or WebPros. npm and the registry accept it: three registry servers already use "plesk". The directory's plugin checklist holds names that "could be mistaken for a well-known brand that isn't yours" for a human reviewer. That's a hold, not a rejection. |
| **D3** | GitHub owner and repository | I can't detect it, because `gh` isn't logged in. The registry name is `io.github.<Login>/plesk-deploy-mcp`, with your login in **exact case** (the registry's matching is case-sensitive). An organisation owner needs the OIDC route, not `login github`. | Tell me the owner (user or organisation, exact case) and the repository name. |
| **D4** | Licence | MIT, Apache-2.0, other | **MIT**, copyright "Muhammad Usama Saeed". You asked me to check first. |
| **D7** | The Anthropic directory | It **no longer accepts `.mcpb`**. A local server is listed only inside a **plugin**, whose local server runs in Claude Code and Cowork but is ignored in chat. One older help article still links a `.mcpb` form. (a) Build the `.mcpb` for direct install only; PUBLISHING.md covers the plugin route, built after v1 is on npm. (b) Also build the plugin now: the skill plus this server, pinned to an exact npm version. (c) Try the old form as well. | **(a)**. The plugin needs an exact published npm version, so it naturally comes after the first release. Its skill would also reach Claude chat users, where the server can't run. |

### Defaults I'll use unless you object

| # | Default | Why |
|---|---|---|
| **D1** | Build on **`@modelcontextprotocol/server` v2** (2.4.0) with **zod 4** and `serveStdio()`, not `@modelcontextprotocol/sdk`. | v2 is the stable line and implements spec 2026-07-28. The SDK's own guide says v1-style stdio wiring "serves 2025-era clients only". v1 only gets fixes until about January 2027. |
| **D5** | `deploy_logs` reads the log through a new read-only **`--log N`** command in the release manager, run as `sudo -n <app>-deploy --log N`. I add tests for it and keep the existing 51. | `server-setup.sh` makes the log `640 root:root`, so a plain `tail` only works for root. Going through the existing **single sudo rule** means the low-privilege deploy account can use `deploy_status`, `deploy_logs` and `rollback`, so the agent needs no root login. Without this, `deploy_logs` would need root or password-less sudo. It is an additive change to the source-of-truth template, so say no if you'd rather keep the template untouched; then `deploy_logs` falls back to `tail` with an optional `sudo -n`. |
| **D6** | SSH tools stay listed but refuse to run until you set **`PLESK_DEPLOY_SSH_HOSTS=alias1,alias2`**. A `host_alias` must be in that list. | This is the opt-in. The agent can't reach a host you didn't name, and the tool list stays the same whatever the configuration (simpler manifests, and the agent can tell you how to enable them). |
| **D8** | The release workflow attaches the `.mcpb` to a **draft** GitHub Release, which you publish yourself. | You said not to create releases without asking. A draft isn't public. |
| **D9** | Vulnerability reports go through **GitHub private vulnerability reporting**, so no email address is published. | Directory policy wants a support contact; GitHub Issues covers support. |
| **D11** | The `.mcpb` declares `darwin` and `win32`, which are Claude Desktop's platforms. CI runs unit tests on Windows too. On Windows, the bash-based checks in `validate_deploy_kit` report "skipped: bash not found". | That's honest about what is tested. |
| **D12** | `generate_deploy_kit` is annotated **`destructiveHint: true`**. | It can overwrite files you list in `overwrite`. The alternative is splitting it into a read-only preview tool and a write tool, which your brief doesn't ask for. |
| — | Commits use a **repository-local** git identity of `Muhammad Usama Saeed <musaeed1993@gmail.com>`, with one-line messages and no trailers. | Your global config says "usama saeed", so I won't touch it. |
| — | `engines.node: ">=22"`. CI tests on 22, 24 and 26, the newest LTS. `@types/node` is pinned to 22, so the code can't use APIs that Node 22 lacks. | Node 20 is end-of-life. Node 22 is the oldest LTS still supported, and the code must also work on the newest. |
| — | **TypeScript 7** (`typescript-7` alias) for typecheck and build. **TypeScript 6.0** stays installed only as ESLint's parser. | You asked for the latest TypeScript. TypeScript 7 drops the classic compiler API, and `typescript-eslint` supports only TypeScript below 6.1 (as of 6 Nov 2026). Drop 6.0 once `typescript-eslint` supports 7. |

## 2. What it is

It's a stdio MCP server that packages the `plesk-deploy` skill.

- **Local tools** read the project and render or check the deploy kit.
- **Server tools** are opt-in. They reach the server over the user's own
  `ssh` and can only read status and logs, or run the release manager's own
  rollback.
- **Deploys** always go through GitHub Actions with human approval. No tool
  builds, uploads or deploys.

## 3. How the skill's rules are enforced

| SKILL.md rule | How the server keeps it |
|---|---|
| 1 Inspect before you change | `inspect_project`, `server_discovery_commands`, `server_discover`. `generate_deploy_kit` is a dry run by default and shows a diff. |
| 2 Never overwrite blindly | Writing needs `write: true`. A file that exists is never overwritten unless its path is in `overwrite`. Writes stay inside the project, never follow symlinks, and need a git repository. Nothing is ever deleted. |
| 3 Secrets never pass through you | No tool takes or returns a secret. Real `.env` files are never opened, only reported as present. Every output passes through a central redactor. SSH uses the user's agent and config. The GitHub token is read only from the environment. |
| 4 Development isn't production | Server facts start as `unknown` and are never inferred from local files. |
| 5 Change as little as possible | nginx directives are only generated when asked for. The kit adds files and never edits existing CI; it shows the `workflow_call` changes as guidance. |
| 6 Keep production working | The server tools only read, apart from `rollback`, which runs the release manager's own documented `--rollback`. |
| 7 Back up before migrating | Choosing a database generates `<app>-db-backup` and `PRE_MIGRATE_CMD`. `validate_deploy_kit` checks they are wired together. |
| 8 Permissions and exposure | The `server-setup.sh` safety steps stay as they are. `server_discover` runs the exposure checks (`.env`, `.git`) and reads listening ports. |
| 9 Say who does what | The prompt and the generated README label every step as automated or manual. |
| 10 Only verified live counts | No tool reports "deployed". `rollback` and `deploy_status` results say what still needs checking from outside, and `github_deploy_runs` reports run state only. |

## 4. Configuration (environment only)

| Variable | Effect |
|---|---|
| `PLESK_DEPLOY_SSH_HOSTS` | A comma-separated list of `~/.ssh/config` host aliases. It enables the SSH tools for those aliases only. |
| `PLESK_DEPLOY_GITHUB_TOKEN` | Optional. A fine-grained token with *Actions: read* and *Metadata: read* on the repository, for `github_deploy_runs` on private repositories. Public repositories work without it. |
| `PLESK_DEPLOY_SSH_BIN` | Optional path to `ssh`. The default is `ssh` on PATH. |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code. It is the default `project_dir` for local tools. |

## 5. Resources (all static, so every client can list them)

| URI | Content |
|---|---|
| `plesk-deploy://workflow` | SKILL.md: the 8 phases and the rules |
| `plesk-deploy://references/<name>` | The 9 reference documents, plus `worked-example`, which replaces the private reference implementation (§11) |
| `plesk-deploy://templates/<dir>/<file>` | The 12 templates, e.g. `plesk-deploy://templates/server/app-deploy` |

## 6. Prompt: `setup-plesk-deployment`

- **Arguments:** `project_dir` (optional) and `host_alias` (optional).
- **Content:** the rules, quoted from SKILL.md, then the 8 phases. Each phase
  names the tool or resource to use and where to stop. The agent stops for
  approval after phase 4, and never deploys from a laptop.
- **Server `instructions`:** a short version of the same.

## 7. Tools

Shared validators (strict allowlist patterns; anything else is rejected):

| Name | Pattern / rule |
|---|---|
| `host_alias` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$` and in `PLESK_DEPLOY_SSH_HOSTS` |
| `app` | `^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$` (≤ 24, so `<app>-deploy` fits a Linux user name) |
| `domain` | lowercase hostname, ≥ 1 dot, labels ≤ 63, total ≤ 253 (IDN as punycode) |
| `system_user` | `^[a-z_][a-z0-9_.-]{0,31}$` |
| `pm2_name` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `remote_path` | absolute; segments `[A-Za-z0-9._@+-]+`; no `..`, `//` or spaces; ≤ 255 |
| `rel_path` | relative; same characters; no `..` or leading `/` |
| `url` | parsed with `URL`; http/https only; no credentials, quotes or spaces; ≤ 2048 (site and public health URLs must be https) |
| `repo` | `owner/name`, GitHub's character rules |
| `env_name` | `^[A-Z_][A-Z0-9_]{0,127}$` |
| `shell_command` | for `MIGRATE_CMD`-type values that are **written to a file, never run by this server**: one line, printable, ≤ 1000 characters, written single-quoted |

### Annotations

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `inspect_project` | true | false | true | false |
| `generate_deploy_kit` | false | **true** (D12) | true | false |
| `validate_deploy_kit` | true | false | true | false |
| `server_discovery_commands` | true | false | true | false |
| `server_discover` | true | false | true | true |
| `deploy_status` | true | false | true | true |
| `deploy_logs` | true | false | true | true |
| `rollback` | false | **true** | false | true |
| `github_deploy_runs` | true | false | true | true |

Every tool also has a `title`, as directory policy §5E requires, and an
`outputSchema` with `structuredContent`, alongside a readable text summary.

### Local tools

**`inspect_project`**

- **Input:** `{ project_dir?: abs path }`.
- **What it reads:** manifests and lockfiles, workspaces, runtime pins
  (`.nvmrc`, `.node-version`, `engines`, `volta`, `composer.json`
  `require.php`, Dockerfile `FROM`), and build/start/migration scripts. It
  also reads framework configs (`next.config.*` output mode, `vite.config.*`
  base, `angular.json`), migration tools, and `synchronize`/`db:push`
  settings. It searches for seeds, run-time write folders, schedulers, Redis
  and queues, health routes and `RELEASE_VERSION`. Finally it reads
  Dockerfiles, existing CI and deploy scripts, and native modules.
- **Environment variable names:** from `.env.example`-style files and from
  code (`process.env.X`, `import.meta.env.VITE_X`, `env('X')`). Each name is
  split into build-time (`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`) or
  run-time. **Real `.env*` files are reported as present, never opened.**
- **Output:** the **Deployment facts** table, each row `verified` (with the
  file it came from) or `unknown`. Server rows are always `unknown` and point
  to `server_discovery_commands`. It also returns the apps with their
  build/start commands, the env names, existing CI, and a labelled stack
  *suggestion*.
- **Limits:** skips `node_modules`, `vendor`, `.git`, `dist`, `build` and
  `.next`. At most 5,000 files, 512 KB per file. Symlinks are not followed.

**`generate_deploy_kit`**

- **Input:**
  - Required: `app`, `stack` (`node|next|static|laravel`: the
    `build-bundle.sh` branches), `process_manager`
    (`pm2|systemd|php-fpm|none`), `site_url`, `public_health_url`,
    `base_dir`, and `health_checks[{url, contains?}]`.
  - Optional, only what is known: `project_dir`, `branch` (`main`),
    `ci_workflow` (`ci.yml`), `app_user`, `app_group`, `node_bin_dir`,
    `pm2_home`, `pm2_apps[{name, dir, script, args?}]`,
    `systemd_units[{name, dir, exec}]`, `php_fpm_service`, `env_file`,
    `shared_links[{path, target}]`, `required_files[]`,
    `database (postgres|mysql|none)`, `migrate_cmd`, `post_switch_cmd`,
    `health_commit_url`, `build_time_vars[]`, `runtime_env_names[]`,
    `not_deployed_paths[]`, `static_dir`, `nginx (none|proxy|spa)`,
    `proxy_port`.
  - Write control: `write` (default **false**) and `overwrite: rel_path[]`
    (default `[]`).
- **Files:**
  - `.github/workflows/deploy-plesk.yml`
  - `deploy/plesk/{build-bundle.sh, <app>-deploy, deploy.conf.example, server-setup.sh, README.md}`
  - `<app>-db-backup` when there is a database
  - `ecosystem.config.js` (pm2) or `<unit>.service` (systemd)
  - `nginx-directives.conf` only when asked for
- **Rendering:**
  - The vendored templates stay byte-identical to the skill. The renderer
    makes **anchored substitutions** and fails loudly if an anchor is missing,
    which a test catches.
  - The release manager is copied unchanged, because it takes its name from
    its file name.
  - Values that are unknown are left **empty** with a `# FILL IN from
    discovery` comment, never guessed.
- **Output:**
  - Per file, the action (`create`, `unchanged`, `blocked: exists`,
    `overwrite`) and a unified diff.
  - A list of the **ADAPT points still open**, such as which run-time files
    the bundle must copy.
  - A warning if the CI workflow is missing ("never deploy untested") or
    isn't callable (with the `workflow_call` guidance).
- **Before writing:** the rendered kit is scanned for secrets, and nothing
  is written if it fails.

**`validate_deploy_kit`**

- **Input:** `{ project_dir?, app?, run_release_manager_tests = true }`.
- **Checks** (each reports pass, fail or skipped):
  1. `bash -n` on every script.
  2. `shellcheck`, if it is on PATH.
  3. A YAML parse of the workflows, using the JS `yaml` package. `pyyaml`
     isn't on this Mac.
  4. Workflow safety:
     - `StrictHostKeyChecking=yes` is set and `=no` never appears
     - the deploy job uses `environment: production` and `cancel-in-progress: false`
     - the key is removed in an `if: always()` step
     - `permissions: contents: read`
     - CI is callable
  5. The release manager suite, run against the **project's adapted copy**,
     in a temporary folder with stand-ins.
  6. A secret scan of the kit and the workflow, reporting file, line and
     kind (never the value).
  7. No `.env` files in the kit.
  8. The backup is wired in when migrations are.
- **Limits:** argv-only `spawn` calls. 10 s per `bash -n`, and 180 s for the
  suite.

**`server_discovery_commands`**

- **Input:** `{ domain, app?, system_user?, pm2_processes?, app_dir?, env_file? }`.
- **Output:** the read-only block from `discovery.md`, with validated values
  filled in and `<placeholders>` left for unknowns. It adds what each command
  answers and asks the user to redact secrets before pasting.
- **Shared allowlist:** the block comes from the **same structured allowlist**
  that `server_discover` runs, so the two can't drift apart.

### Server tools (opt-in, SSH)

**SSH runner.** Every SSH tool runs `spawn(ssh, argv, {shell: false})` with
these options:

```
-T  -o BatchMode=yes  -o StrictHostKeyChecking=yes  -o ConnectTimeout=15
-o ForwardAgent=no  -o ForwardX11=no  -o ClearAllForwardings=yes
-o PermitLocalCommand=no  -o RequestTTY=no  -o LogLevel=ERROR  --  <alias>  <remote command>
```

- Command-line `-o` options override the user's config, so host keys are
  always checked strictly and the agent is never forwarded.
- `ssh` always passes the remote command to a shell as a string. So every
  value is validated and then **POSIX single-quoted**, and commands come only
  from fixed templates.
- The child process gets a **minimal environment** (`PATH`, `HOME`, `USER`,
  `SSH_AUTH_SOCK`), so `SendEnv` can't leak the GitHub token.
- Output is capped at 1 MB and every call has a timeout. An unknown host key
  produces an explanation of how to add it after checking the fingerprint.

**`server_discover`**

- **Input:** the same as `server_discovery_commands`, plus `host_alias`,
  `sudo = false` and `sections?`
  (`plesk|processes|ports|files|config|data|cron|exposure`).
- **How it runs:** one SSH session runs the fixed allowlist as a script on
  stdin (`sh -s`, or `sudo -n sh -s`). That's one connection, so one prompt
  if the agent asks for a touch or confirmation. Each command runs under
  `timeout 20`, with 120 s overall.
- **Output:** one section per command, with the command, exit code and
  redacted output (capped at 20 KB), plus the notes from `discovery.md`.
  `.env` files are listed **as names only**, by the same `sed` command the
  skill uses.

**`deploy_status`**

- **Input:** `{ host_alias, app }`.
- **Runs:** `/usr/local/bin/<app>-deploy --status`. No sudo is needed:
  `--status` only reads, and the configuration file is mode 644.
- **Output:** releases `{id, commit, live, failed}`, the live release, and the
  raw redacted text. Timeout 30 s.

**`deploy_logs`**

- **Input:** `{ host_alias, app, lines = 100 (1–500) }`.
- **Runs:** `sudo -n /usr/local/bin/<app>-deploy --log <lines>` (D5).
- **On a server whose release manager predates `--log`:** it says so and
  explains how to update.

**`rollback`**

- **Input:** `{ host_alias, app, confirm }`. `confirm` must be exactly
  `"<app>@<host_alias>"`, otherwise nothing runs.
- **Steps:**
  1. Run `--status` to record what is live now.
  2. Run `sudo -n /usr/local/bin/<app>-deploy --rollback`.
  3. Run `--status` again.
- **Output:** before and after, the release manager's output, and a reminder
  that migrations aren't undone and that the result must be verified from
  outside.
- **Timeout:** the default is 600 s. A timeout or a cancellation **doesn't
  kill** the SSH process, because an interrupted rollback is worse than a
  slow one. The tool says it's still running and to check `deploy_status`.

**`github_deploy_runs`**

- **Input:** `{ repo, workflow = "deploy-plesk.yml", branch?, limit = 5 (1–20), include_jobs = true }`.
- **Calls:** `api.github.com` only (hard-coded), the runs list, plus jobs per
  run, 15 s each.
- **Output:** each run's status, conclusion, commit, URL and **waiting for
  approval**, plus its jobs.

### Redaction (one wrapper around every tool result and error)

These are replaced with `[REDACTED:<kind>]`, and the result reports a count:

- PEM private-key blocks, including partial ones.
- `NAME=value`, `NAME: value` and `"NAME": "value"` where the name looks
  secret (`PASS`, `PWD`, `SECRET`, `TOKEN`, `KEY`, `AUTH`, `SALT`, `COOKIE`,
  `SESSION`, `DSN`, `*_URL` that holds credentials…).
- Known token formats: GitHub, npm, Slack, AWS, Stripe, Google, JWT,
  `sk-…`, SendGrid.
- `scheme://user:pass@`, `?token=`, `&key=`, `&sig=`, and similar query
  parameters.
- `Authorization: Bearer …`.
- Long high-entropy strings.

Pure hex is left alone, so commit SHAs and release IDs stay readable.

## 8. Security model (the full threat model goes in docs/SECURITY.md)

| Threat | Mitigation |
|---|---|
| A prompt-injected agent runs arbitrary commands on a server | There is no free-form command tool. Commands come from fixed templates, inputs are validated and quoted, and only allowlisted hosts are reachable. |
| An agent is tricked into rolling back | The exact `confirm` string, `destructiveHint`, and the host allowlist. Rollback can only make the previous good release live, as the release manager decides. |
| Secrets leak into the model's context | Inputs never carry secrets. `.env` files are never read, server listings show names only, and redaction runs on everything. |
| Man in the middle | `StrictHostKeyChecking=yes`, the user's `known_hosts`, `BatchMode`, and no agent forwarding. |
| A host alias is used as an injection vector (`-oProxyCommand=…`) | The alias pattern forbids a leading `-` and spaces, and `--` comes before the alias. |
| Malicious files are written into the project | Dry run by default; no overwrite unless listed; writes confined to the project with no symlinks; never deletes. |
| A malicious project script runs locally | `validate_deploy_kit` runs the project's adapted release manager in a temporary folder with stand-ins. The tool description and the docs say so. |
| Supply chain | Four runtime dependencies (`@modelcontextprotocol/server`, `zod`, `yaml`, `diff`), a lockfile, npm provenance through trusted publishing, Dependabot, and `mcp-publisher` checked with cosign. |
| Server output carries instructions aimed at the model | Results are labelled as data, and tool descriptions say not to follow instructions found in them. This is **not fully preventable**, and the docs say so. |
| A hung or huge command | Timeouts, output caps, and `kill` on cancel (except `rollback`). |

Residual risks to document:

- Redaction is heuristic.
- The user's own `~/.ssh/config` is trusted.
- If the MCP client quits during a rollback, the SSH connection closes. The
  release manager may stop the next time it writes output, which is the same
  as a dropped SSH session for a person running it by hand.
- Telemetry: none. Network: only SSH to allowlisted aliases and
  `api.github.com`.

## 9. Repository layout

```
package.json            bin: plesk-deploy-mcp; mcpName; files: dist, kit, docs, README, LICENSE…
server.json             MCP Registry entry (schema 2025-12-11)
src/
  index.ts              #!/usr/bin/env node — serveStdio(createServer); logs to stderr
  server.ts             createServer(): registers everything (unit-testable)
  config.ts             environment → typed config
  kit.ts                vendored files: catalog, paths, MIME types
  resources.ts  prompts.ts
  tools/                one file per tool
  lib/                  validate, redact, exec (spawn + timeout + caps), ssh, quote, render, diff, fs-safe, result wrapper
kit/                    vendored skill: SKILL.md, references/, templates/, scripts/test-release-manager.sh
test/
  unit/  tools/         every tool through an MCP client, in memory or over stdio
  fixtures/projects/    node-nest, next, vite-spa, laravel, empty
  fixtures/bin/ssh      fake ssh: records argv, replies per command, can sleep or emit secrets
  release-manager.test.ts   runs the suite (51+ checks, must end "0 failed")
  stdio.test.ts         spawns dist/, asserts stdout carries only JSON-RPC
  integration/sshd/     Dockerfile + test, CI only
mcpb/manifest.json  scripts/build-mcpb.mjs  scripts/check-pack.mjs
docs/  RESEARCH.md  DESIGN.md  SECURITY.md (threat model)  PUBLISHING.md
.github/workflows/ci.yml  release.yml   .github/dependabot.yml
README.md  SECURITY.md  PRIVACY.md  CONTRIBUTING.md  CHANGELOG.md  LICENSE
```

## 10. CI and release

**`ci.yml`** runs on pushes and pull requests:

| Job | Runs on | What it does |
|---|---|---|
| Checks | Node 24 | lint, prettier `--check`, `tsc --noEmit`, build, the `npm pack` contents check (required files present; no `src/`, `test/`, `.env` or private names), then `mcpb validate` + `mcpb pack` (kept as an artifact) |
| Tests | Ubuntu and macOS × Node 22, 24, 26, plus Windows × Node 24 | the test suite, including the release manager suite |
| sshd | Ubuntu | a Docker container with `sshd` and the real release manager. The server tools run against it through an `ssh_config` alias with a pinned `known_hosts` |

**`release.yml`** runs only on a `v*.*.*` tag that **you** push:

1. Check that the tag, `package.json` and `server.json` versions agree, then
   run all the checks.
2. Publish to npm through **trusted publishing**: OIDC, no token stored,
   provenance automatic. Gated by a `release` environment that you approve.
3. Publish to the MCP Registry: `mcp-publisher` pinned and verified with
   cosign, then `login github-oidc` and `publish`.
4. Build the `.mcpb` and attach it to a **draft** release (D8).

The first npm version has to exist before trusted publishing can be set up.
docs/PUBLISHING.md gives the options: a one-off manual publish with 2FA, or a
short-lived granular token, revoked afterwards.

## 11. Vendoring the skill

- Templates, references and the test script are copied **unchanged**. The one
  addition is `--log` in the release manager, if you approve D5.
- The skill's reference-implementation file describes a private production
  system. It is **not shipped**, and its name doesn't appear in this
  repository.
  `references/worked-example.md` replaces it:
  - It describes a fictional NestJS API and Next.js app on `example.com`.
  - It keeps the structure and every lesson: first-run failures,
    repository vs environment variables, `pipefail` in pruning, a checkout in
    `httpdocs`, PM2 as root.
  - Every identifying detail is changed: names, domains, dates, paths, ports,
    and versions where they identify.
  - It is labelled as illustrative.
- The two mentions of that file in SKILL.md now point to the worked example.
- Tests and the pack check fail if the private project's name appears
  anywhere. They compare SHA-256 hashes of words against a denylist, so the
  name itself is never written into this repository.

## 12. Build order (one commit and a summary after each)

1. Scaffold (git, package, TypeScript, lint, vitest, LICENSE) and vendor the
   kit. The release manager suite runs as a test.
2. Libraries: validate, redact, quote, exec, ssh. Unit tests, including an
   injection corpus.
3. Server skeleton: resources, prompt, instructions, stdio entry, and the
   stdout-purity test.
4. `inspect_project` and `server_discovery_commands`, with fixtures.
5. `generate_deploy_kit`.
6. `validate_deploy_kit`.
7. SSH tools against the fake `ssh`. `--log` and its tests, if D5 is
   approved.
8. `github_deploy_runs` (with a mocked `fetch`).
9. CI, the pack check, and the sshd integration job (CI only).
10. `server.json`, the `.mcpb` manifest and build, and all the docs.
11. End to end:
    - `claude mcp add --scope local` this build, then `claude mcp list`.
    - Every local tool against a sample project I create, through a
      scripted MCP client and one headless `claude -p` run.
    - The SSH tools **only against the fake ssh**, and I'll say so.

**Laptop budget:** one heavy command at a time. Only targeted test files run
locally; the full matrix and the Docker test run in CI.

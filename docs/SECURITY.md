# Threat model

This is the security design of plesk-deploy-mcp, written for reviewers and
contributors. To report a vulnerability, see [../SECURITY.md](../SECURITY.md).

## What is being protected

| Asset | Why it matters |
|---|---|
| Production servers | The SSH tools can reach them, and `rollback` changes what is live |
| SSH keys, the agent and `known_hosts` | They grant access to those servers |
| Application secrets (`.env` values, database passwords, API keys) | They are on the servers and in projects; they must never reach a model's context |
| The GitHub token (optional) | It reads workflow runs |
| The user's project | `generate_deploy_kit` can write files into it |
| The user's machine | Tools run programs on it (`bash`, `ssh`, the release manager suite) |

## Who and what is not trusted

1. **The model and its inputs.** Any tool argument may be adversarial,
   because prompt injection can make a model call tools with crafted inputs.
   The server treats every argument as untrusted.
2. **Content the tools read:** project files, server output, logs and GitHub
   responses. These may contain instructions aimed at the model, or secrets.
3. **The network**, between this machine and the server or GitHub.
4. **Dependencies**, in the supply chain.

The user, their MCP client configuration (environment variables) and their
`~/.ssh/config` are trusted. The configuration decides what the server may do,
and no tool can change it.

## Threats and mitigations

| # | Threat | Mitigation | Where | Proved by |
|---|---|---|---|---|
| T1 | A prompt-injected model runs an arbitrary command on a server | There is no free-form command tool. Remote commands come from fixed templates only: the discovery allowlist and the release manager's `--status`, `--log N` and `--rollback`. Every value is validated by a strict pattern and then POSIX-quoted. | `src/discovery/commands.ts`, `src/lib/validate.ts`, `src/lib/quote.ts`, `src/tools/*` | `test/unit/validate.test.ts` (an injection corpus every schema rejects), `test/unit/quote.test.ts` (a real `sh` gets back exactly the words), `test/tools/ssh-tools.test.ts` (the script sent holds only allowlisted commands) |
| T2 | The model reaches a host the user didn't intend | The SSH tools refuse every alias not listed in `PLESK_DEPLOY_SSH_HOSTS`, which is empty by default. A malformed list entry is ignored whole, never split into another alias. | `src/lib/ssh.ts` `assertHostAllowed`, `src/config.ts` | `test/unit/ssh.test.ts`, `test/unit/config.test.ts`, `test/tools/ssh-tools.test.ts` (ssh never starts) |
| T3 | An alias is used for option injection (`-oProxyCommand=…`) | The alias pattern forbids a leading `-`, spaces, `@` and `:`, and `--` always comes before the alias in the ssh argv. | `src/lib/validate.ts`, `src/lib/ssh.ts` | `test/unit/ssh.test.ts` |
| T4 | The model is tricked into rolling back | `rollback` needs `confirm` to be exactly `<app>@<host_alias>`, and it is annotated `destructiveHint: true` so clients ask the user. The release manager decides the target: only the previous good release. | `src/tools/rollback.ts` | `test/tools/ssh-tools.test.ts` (wrong confirmations run nothing) |
| T5 | A secret reaches the model's context | Tools never take secrets as input. Real `.env` files are never opened locally. On the server, env files are listed by a command that prints only `NAME=<set>`/`<empty>`. Every result (text, structured content and errors) passes through one redactor. | `src/lib/fs-safe.ts`, `src/discovery/commands.ts`, `src/lib/redact.ts`, `src/lib/result.ts` | `test/tools/inspect-project.test.ts` (canary values never appear), `test/tools/server-discovery-commands.test.ts` (a multi-line private key in an env file prints nothing), `test/unit/redact.test.ts`, `test/tools/ssh-tools.test.ts` |
| T6 | A man-in-the-middle or a changed host key | Command-line options force `StrictHostKeyChecking=yes` and `BatchMode=yes`, overriding the user's config. Host keys are never added. Agent forwarding, X11 forwarding, port forwarding and `LocalCommand` are off. | `src/lib/ssh.ts` `SSH_OPTIONS` | `test/unit/ssh.test.ts`, the CI integration test (an unpinned host is refused) |
| T7 | The GitHub token leaks through ssh `SendEnv` or a child process | Child processes get a minimal environment (PATH, HOME, the agent socket and the locale), never the token. The token goes only in the `Authorization` header to `api.github.com`, a hard-coded host. | `src/lib/exec.ts` `minimalEnv`, `src/tools/github-deploy-runs.ts` | `test/unit/exec.test.ts`, `test/unit/ssh.test.ts`, `test/tools/github-deploy-runs.test.ts` |
| T8 | Files are written outside the project, or replace the user's work | Dry run by default. Writing needs `write: true` and a git repository root. Output paths are fixed by the tool, never passed in. A path through a symlink is refused, and an existing file is replaced only if listed in `overwrite`. Nothing is ever deleted. Writes go through a temporary file and an atomic rename. | `src/tools/generate-deploy-kit.ts` | `test/tools/generate-deploy-kit.test.ts` |
| T9 | Secrets are written into the kit (for example a password in `migrate_cmd`) | The rendered kit is scanned before writing. Nothing is written if anything looks like a secret, and the value isn't echoed. | `src/lib/secrets.ts` | `test/tools/generate-deploy-kit.test.ts` |
| T10 | A hung or huge command | Every child process has a timeout and an output cap. Read-only commands are killed on cancel or timeout. Each discovery command runs under `timeout 20`, with 120 s for the whole run. Results are capped at 45,000 characters. | `src/lib/exec.ts`, `src/tools/server-discover.ts`, `src/lib/result.ts` | `test/unit/exec.test.ts`, `test/unit/ssh.test.ts` |
| T11 | A rollback interrupted halfway (by a cancel or a client timeout) | The rollback's ssh process is never killed. On a timeout or cancel the tool reports "still running" and keeps draining the output. | `src/lib/exec.ts` `detachOnTimeout`, `src/tools/rollback.ts` | `test/tools/ssh-tools.test.ts` (a cancelled rollback still completes) |
| T12 | Server output fakes the discovery frames | Each run's markers carry a random 64-bit nonce. | `src/tools/server-discover.ts` | `test/tools/ssh-tools.test.ts` |
| T13 | A discovery command reads the rest of the script from stdin | Every command runs with `</dev/null`. | `src/tools/server-discover.ts` | `test/tools/ssh-tools.test.ts` |
| T14 | Tool output carries instructions to the model (prompt injection through files, logs or server output) | Tool descriptions and results say that such text is data, never instructions, and the server instructions say the same. **This can't be fully prevented by a server**; it relies on the client and the model. | `src/tools/common.ts` `DATA_NOTE`, `src/instructions.ts` | — |
| T15 | stdout corruption (a log line breaks the protocol) | ESLint forbids `console.log` in `src/`. Logs go to stderr. | `eslint.config.js` | `test/stdio.test.ts` (every stdout line is JSON-RPC) |
| T16 | Supply chain | 4 runtime dependencies, a lockfile, Dependabot, npm trusted publishing with provenance (no long-lived token), `mcp-publisher` verified with cosign, and third-party actions pinned by SHA. | `package.json`, `.github/` | CI |
| T17 | The kit weakens a safety check of the release manager | `validate_deploy_kit` fails if any of the release manager's safety checks is missing, and runs its test suite against the project's copy. | `src/tools/validate-deploy-kit.ts` | `test/tools/validate-deploy-kit.test.ts` |

## Privileges on the server

The recommended SSH account is the **deploy account** created by
`server-setup.sh`:
- its key line in `authorized_keys` is prefixed with `restrict`;
- it has one sudo rule, for `/usr/local/bin/<app>-deploy`, validated with
  `visudo -cf`.

Through that account, `deploy_status` runs without sudo, while `deploy_logs`
(`--log`) and `rollback` (`--rollback`) use the one sudo rule. `--log` only
accepts a number from 1 to 5000, and reads `LOG_FILE` from the root-owned
`deploy.conf`; it takes no path. `server_discover` is read-only; with
`sudo: true` it uses `sudo -n` and fails, rather than prompting, without
password-less sudo.

## Known and accepted risks

- **Redaction is heuristic.** It catches common formats (private keys,
  assignments with secret-looking names, credentials in URLs, Authorization
  headers, known token formats, long random strings) but can miss a secret in
  an unusual format. That's why tools are designed not to read secrets in the
  first place.
- **The user's `~/.ssh/config` is trusted.** An alias the user allowed can
  point anywhere their config says, including through a `ProxyJump`.
- **Losing the client during a rollback.** If the MCP client process exits
  during a rollback, the SSH connection closes. The release manager may then
  stop the next time it writes output, like a person's dropped SSH session.
  Check `deploy_status` afterwards.
- **`validate_deploy_kit` runs the project's adapted release manager** on this
  machine, in a temporary folder with stand-ins. A malicious project could put
  code in that script. Only validate projects you trust, as you would before
  running their tests.
- **Annotations are hints.** Clients decide how to treat them. The rollback
  confirmation is enforced by the server either way.

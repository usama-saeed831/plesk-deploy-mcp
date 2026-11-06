# Contributing

Thank you for helping. This server can reach production servers, so the bar
is safety first. Any change that weakens a safeguard needs a very good reason,
stated in the pull request.

## Set-up

You need Node.js 22 or later and `bash`. `git`, `tar` and `curl` are needed for
some tests.

```bash
npm ci
npm run build
npm test
```

| Script | What it does |
|---|---|
| `npm run lint` / `npm run format:check` / `npm run typecheck` | Static checks |
| `npm test` | All tests. The release manager suite and the tool tests take about a minute |
| `npx vitest run test/unit` | Just the fast unit tests |
| `npm run test:release-manager` | The release manager's own suite (bash) |
| `npm run test:integration` | Real sshd in Docker. CI only: it writes `~/.ssh/config` (needs `PLESK_IT_SSHD=1`) |
| `npm run check:pack` | What `npm pack` would publish |
| `npm run build:mcpb` | The Claude Desktop extension, in `build/` |
| `npm run sync:plugin` / `npm run check:plugin` | Copy `kit/` into the Claude Code plugin (`plugins/plesk-deploy/`), or check that it is in step |
| `npm run smoke -- /abs/path/to/throwaway-project` | The built server over real stdio: every local tool against a throwaway git project (it writes the kit there) |

If your machine is short on memory, run targeted tests (`npx vitest run
test/tools/inspect-project.test.ts`) and let CI run the full matrix.

TypeScript: `typecheck` and `build` use TypeScript 7, installed as the
`typescript-7` alias. TypeScript 6.0 stays installed only because
`typescript-eslint` doesn't support 7 yet; remove it once it does.

## Where things are

| Path | What |
|---|---|
| `src/index.ts` | The stdio entry point. stdout is the protocol, so log with `console.error` only |
| `src/server.ts` | Registers the resources, the prompt and the tools |
| `src/tools/` | One file per tool |
| `src/lib/` | Validation, redaction, quoting, the process runner, ssh, file safety |
| `src/kit/render.ts` | Renders the templates by anchored substitution |
| `src/discovery/commands.ts` | The read-only server command allowlist (shared by two tools) |
| `kit/` | The vendored plesk-deploy skill: workflow, references, templates, test script |
| `test/` | Unit tests, tool tests through an MCP client, fixtures, the fake `ssh` |

## Rules for changes

- **Tools**: every tool needs a zod input schema built from `src/lib/validate.ts`, a description that says what it does and when to use it, all five annotations (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), an `outputSchema`, and the `guarded()` wrapper (redaction and errors). Its tests go through the MCP client (`test/helpers/client.ts`).
- **No free-form commands.** Never add a tool that runs a command or a path chosen by the caller. Remote commands come from fixed templates, with validated and quoted values.
- **No secrets in or out.** No tool parameter may carry a secret, and new output must go through `guarded()`.
- **Templates** in `kit/templates/` stay as close to the skill as possible. When you change one, update the anchors in `src/kit/render.ts`; the render tests fail on a lost anchor. When you change `kit/templates/server/app-deploy`, run `npm run test:release-manager`, which must end with `0 failed`, and add a scenario for the new behaviour.
- **The Claude Code plugin** (`plugins/plesk-deploy/`) carries a copy of `kit/`. After changing anything in `kit/`, run `npm run sync:plugin`. CI fails if the copy drifts, and validates the plugin with `claude plugin validate --strict`.
- **The private reference project** must never be named in this repository. `test/private-names.test.ts` and `npm run check:pack` check for it.
- **Tests**: a bug fix comes with a test that fails without it. SSH behaviour is tested against `test/fixtures/bin/ssh` and `test/fixtures/server/`, never a real server.

## Commits and pull requests

- One logical change per pull request, with a one-line commit subject.
- CI must pass on every operating system and Node version in the matrix.
- Describe how you tested the change, and anything you couldn't test.

Report security problems privately: see [SECURITY.md](SECURITY.md).

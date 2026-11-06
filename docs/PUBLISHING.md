# Publishing

These are the steps the maintainer takes, in order. Nothing here publishes on
its own: a release starts only when you push a `v*.*.*` tag, and it then waits
for your approval in GitHub.

Sources for every requirement are in [RESEARCH.md](RESEARCH.md). Where the
official documentation is unclear or contradicts itself, this guide says so.

## Where each secret goes

| Secret | Where it goes | When |
|---|---|---|
| `NPM_TOKEN` (temporary) | GitHub → Settings → Environments → `release` → Environment secrets | Only for the first version, if you choose path A below. Delete it afterwards |
| — | — | Later releases use npm trusted publishing (OIDC), and the registry uses `github-oidc`. **No stored secret is needed** |
| `PLESK_DEPLOY_GITHUB_TOKEN` (optional) | Only in your own MCP client's configuration | When you use `github_deploy_runs` on private repositories |

Never paste a token into a chat, an issue, a commit or a file in the
repository.

## 1. One-time set-up in GitHub

1. **The `release` environment** (it gates every publish):
   1. Go to Settings → Environments → **New environment** and name it `release`.
   2. Under **Required reviewers**, add yourself (`usama-saeed831`), then **Save protection rules**.
   3. Under **Deployment branches and tags**, choose **Selected branches and tags**, then **Add deployment branch or tag rule** → **Ref type: Tag** → `v*.*.*`.
2. **Private vulnerability reporting** (SECURITY.md relies on it): Settings → Security (Code security) → **Private vulnerability reporting** → **Enable**.
3. Optional: **branch protection for `main`**. Settings → Branches → Add rule → require the CI checks to pass.

## 2. One-time set-up on npm

1. You need an npmjs.com account with **two-factor authentication** on (Account → Two-Factor Authentication).
2. Check the name is still free:

   ```bash
   npm view plesk-deploy-mcp
   ```

   You should see `E404 Not Found`. On 6 November 2026 it was free. npm also
   refuses new names that differ from an existing package only in
   punctuation; none did.
3. Sign in on your machine with `npm login` (it opens the browser), and check with `npm whoami`.

## 3. Prepare a release

1. Set the version everywhere it is written: `npm run set-version 0.1.0`.
2. Move the `[Unreleased]` notes in `CHANGELOG.md` under the new version.
3. Check everything agrees: `npm run check:metadata`.
4. Commit and push `main`, then wait for **CI** to pass on GitHub.

## 4. The first version (0.1.0)

npm trusted publishing can only be set up for a package that already exists.
So the very first version is published in one of two ways.

### Path A (recommended): through the workflow, with a one-week token

This gives 0.1.0 provenance like every later version.

1. On npmjs.com, go to your avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**, and set:
   - Name: `plesk-deploy-mcp first publish`
   - Expiration: **7 days**
   - **Packages and scopes**: Read and write, **All packages** (the package doesn't exist yet)
   - Tick **Bypass two-factor authentication**, because a CI job can't type a code.

   Copy the token straight into the next step and nowhere else.
2. In GitHub, go to Settings → Environments → `release` → **Add environment secret** → name `NPM_TOKEN`, then paste the token.
3. Tag and push:

   ```bash
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

4. Go to GitHub → Actions → **Release**. Wait for the checks, then **Review deployments** → `release` → **Approve and deploy**.
5. Watch the **Publish to npm and the MCP Registry** job finish.
6. Now set up trusted publishing and remove the token (section 5).

### Path B: by hand from your machine

Use this only if you'd rather never create a token. 0.1.0 then has no
provenance.

```bash
git tag -a v0.1.0 -m "v0.1.0"      # don't push the tag yet
git checkout v0.1.0
npm ci && npm run build
npm publish --access public          # asks for your 2FA code
git checkout main
```

Then set up trusted publishing (section 5), and push the tag with
`git push origin v0.1.0`. The workflow sees that 0.1.0 is already on npm,
skips that step, and goes on to the registry and the `.mcpb`.

Note: npm says direct publishing with granular tokens will be removed in
January 2027. Path A must happen before then; after that, use path B or
`npm stage publish`.

## 5. Trusted publishing (once, right after the first version)

1. On npmjs.com, go to the package **plesk-deploy-mcp** → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:
   - Organization or user: `usama-saeed831`
   - Repository: `plesk-deploy-mcp`
   - Workflow filename: `release.yml`
   - Environment: `release`
   - **Allowed actions: tick direct publishing (`npm publish`).** Configurations created after 3 September 2026 allow only `npm stage publish` unless you tick this, and the workflow uses `npm publish`.
2. If you used path A:
   - In GitHub, delete the `NPM_TOKEN` environment secret.
   - On npmjs.com, delete the token (Access Tokens).
3. On npmjs.com, go to the package → Settings → **Publishing access**, and choose **Require two-factor authentication and disallow tokens**. npm recommends this once trusted publishing works.

## 6. Check the release

1. **npm:**

   ```bash
   npx -y plesk-deploy-mcp@0.1.0 --version     # prints 0.1.0
   ```

   The package page on npmjs.com should show a provenance badge.
2. **The MCP Registry** (published by the workflow with `github-oidc`):

   ```bash
   curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.usama-saeed831/plesk-deploy-mcp&version=latest"
   ```

   The `io.github.usama-saeed831/...` namespace is proven by the workflow's
   GitHub token, so it needs no secret. Keep in mind:
   - The registry is still in **preview**: its docs warn of breaking changes
     or data resets.
   - A published version can't be changed or reused.
   - **If the registry step fails** (for example, npm was slow to show the new
     version), publish by hand from the tagged commit:

     ```bash
     brew install mcp-publisher        # or the release tarball from github.com/modelcontextprotocol/registry
     mcp-publisher login github        # browser device flow, as usama-saeed831
     mcp-publisher publish             # reads server.json
     ```
3. **The `.mcpb` draft:**
   1. Go to GitHub → **Releases**, where the workflow left a **draft** with `plesk-deploy-mcp-0.1.0.mcpb` attached.
   2. Install it in Claude Desktop first: Settings → Extensions → **Advanced settings** → **Install Extension…**. Enter your allowed host aliases, and ask it to inspect a project.
   3. If it works, edit the draft and **Publish release**.

   It is not signed. Signing (`mcpb sign`) needs a code-signing certificate,
   and the docs don't require it for direct installs.
4. **Claude Code:**

   ```bash
   claude mcp add --transport stdio --scope user plesk-deploy -- npx -y plesk-deploy-mcp
   claude mcp list
   ```

## 7. Every later release

```bash
npm run set-version 0.1.1
# edit CHANGELOG.md
npm run check:metadata
git commit -am "Release 0.1.1" && git push
# after CI passes:
git tag -a v0.1.1 -m "v0.1.1" && git push origin v0.1.1
```

Then approve the `release` deployment in GitHub Actions and publish the draft
release.

## 8. Anthropic's directory

**The current state of the docs (6 November 2026):**

- The directory **no longer accepts `.mcpb` submissions**. A local server is
  listed by putting it **inside a plugin**. Sources: claude.com/docs
  `connectors/building/mcpb.md`, `connectors/building/submission.md` and
  `directory/publish.md`.
- A plugin's local MCP server **runs in Claude Code and Cowork, but is ignored
  in Claude chat** (`plugins/platform-support.md`). Skills in a plugin load
  everywhere, so a plugin carrying the plesk-deploy skill as well would also
  help chat users.
- **Unclear:** one help-centre article (support.claude.com, "Getting started
  with local MCP servers on Claude Desktop") still points to a
  desktop-extension submission form. If you want the `.mcpb` itself listed,
  ask `directory@anthropic.com` before relying on that form.

The plugin is a follow-up to v0.1.0, because it must pin an exact npm version:
`npx -y plesk-deploy-mcp@0.1.0`. When you're ready:

1. Build a plugin, in this repository or a public one of its own, containing:
   - the skill under `skills/plesk-deploy/`;
   - the MCP server declared with `command` and `args` (not as a `.mcpb`),
     with `npx` pinned to the exact version;
   - the GitHub token as a `userConfig` option with `sensitive: true`.
2. Go through the pre-submission checklist (`plugins/pre-submission-checklist.md`) and the directory policy:

   | Requirement | Status |
   |---|---|
   | Name: lowercase, at most 64 characters, not made only of reserved words | `plesk-deploy-mcp` fits. **Expect a reviewer hold**: names that look like a brand that isn't yours ("Plesk") are held for review. The README says the project isn't affiliated |
   | README of at least 40 words, and a LICENSE file | Done |
   | Readable source, not minified | The source is public on GitHub |
   | A privacy policy link (policy 3A) | https://github.com/usama-saeed831/plesk-deploy-mcp/blob/main/PRIVACY.md |
   | Verified contact and support (3B) | Issues: https://github.com/usama-saeed831/plesk-deploy-mcp/issues. Make sure your GitHub profile shows a contact |
   | Documentation (3C) | README and docs/ |
   | A testing account with sample data (3D) | **Unclear for a local plugin.** Reviewers can use the local tools on any project. For the SSH tools, offer `test/integration/sshd` (a Docker server with the release manager) |
   | At least 3 working example prompts (3E) | The list below |
   | Tool annotations, especially `title`, `readOnlyHint` and `destructiveHint` (5E) | Every tool has all of them |
   | Tool names of at most 64 characters (5C), helpful errors (5A), frugal results (5B) | Done (results are capped at 45,000 characters) |
   | Reasonably current dependencies (5G) | Dependabot, weekly |
   | Screenshots | Documented only for MCP Apps (remote connectors), not plugins. Optional |

   Example prompts:
   1. "Set up a Plesk deployment for this project." (the `setup-plesk-deployment` prompt)
   2. "Inspect this project and show me its deployment facts."
   3. "What's live on `myserver` for app `acme`, and what does the deploy log say?"
   4. "Has my last Deploy to Plesk run in `me/acme` finished, or is it waiting for approval?"
3. Submit at https://claude.ai/directory/manage → **Submit new** → **Plugin bundle**. This needs a Pro, Max, Ultra, Team or Enterprise plan, and the repository must be public.
4. After it's listed, tell Anthropic about material changes (policy 3H). Later versions may publish automatically, depending on the listing's settings.

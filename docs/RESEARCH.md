# Research notes

These notes record what the current official documentation says, as read on
**6 November 2026**, and the decisions that follow from it. Every URL below
returned HTTP 200 on that date. Where the documentation is unclear or
contradicts itself, the conflict is listed instead of being resolved by
guesswork.

Facts marked **(checked)** were also confirmed directly from package metadata
or a live endpoint, not only read in prose.

## 1. The TypeScript MCP SDK

| Fact | Source |
|---|---|
| The stable SDK line is **v2**, published as split packages. `@modelcontextprotocol/server` is at **2.4.0** and needs Node `>=20` **(checked)**. 2.0.0 shipped on 2026-07-27. | https://github.com/modelcontextprotocol/typescript-sdk, https://ts.sdk.modelcontextprotocol.io/v2/ |
| `@modelcontextprotocol/sdk` (1.32.2) is the v1 **maintenance line** **(checked)**. It implements the spec "up to 2025-11-25" and receives fixes "for at least six months after the v2 release". | https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x |
| v2 drops Zod 3: "Zod v3 is no longer supported"; the packages depend on `zod ^4.2.0`. Schemas are passed as `z.object({...})`. Raw shapes still work through overloads marked deprecated. | https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html |
| Old-style stdio wiring "serves 2025-era clients only". The entry point that serves both 2025 and 2026 clients is `serveStdio(() => createServer())`, from `@modelcontextprotocol/server/stdio`. | https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html |
| API: `new McpServer(serverInfo, { instructions, capabilities })`; `registerTool(name, { title, description, inputSchema, outputSchema, annotations }, cb)`; `registerResource(name, uri, config, cb)`; `registerPrompt(name, { title, description, argsSchema }, cb)`. | https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/mcp.html |
| A tool that throws becomes an `isError: true` result. The docs recommend returning `isError: true` with a message that tells the model how to recover. Resource and prompt callbacks throw `ProtocolError`. | https://ts.sdk.modelcontextprotocol.io/v2/servers/errors.html |

**Decision:** build on `@modelcontextprotocol/server` v2, with `zod` 4 and
`serveStdio`. The brief named `@modelcontextprotocol/sdk`, so this needs your
approval (see DESIGN.md, decision D1).

## 2. The MCP specification (2026-07-28)

| Fact | Source |
|---|---|
| The latest published spec is **2026-07-28**. | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| `ToolAnnotations` fields and defaults: `title`; `readOnlyHint` (default **false**); `destructiveHint` (default **true**, meaningful only when not read-only); `idempotentHint` (default **false**); `openWorldHint` (default **true**). All of them are hints, and clients "MUST consider tool annotations to be untrusted unless they come from trusted servers". | https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts, https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| Tool execution errors go back as results with `isError: true`. Protocol problems go back as JSON-RPC errors. | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| Servers "MUST: Validate all tool inputs; Implement proper access controls; Rate limit tool invocations; Sanitize tool outputs." | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| stdio: "The server MUST NOT write anything to its stdout that is not a valid MCP message". It "MAY write UTF-8 strings to stderr", and "SHOULD exit promptly when their standard input is closed". | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio |
| MCP protocol logging is **deprecated** in 2026-07-28 **(checked)**: "New implementations SHOULD NOT adopt it; existing implementations SHOULD migrate to logging to `stderr`". | https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging |
| The local-server risks listed include arbitrary code execution and data theft (the page's example is `curl -X POST -d @~/.ssh/id_rsa`). Local servers should use stdio and minimal privileges. | https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices |

## 3. The official MCP Registry

| Fact | Source |
|---|---|
| The registry is "currently in preview. Breaking changes or data resets may occur before general availability." | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx |
| The newest dated `server.json` schema is `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` **(checked: 200)**. Required fields are `name`, `description` and `version`. `description` is limited to **100 characters**. | https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md, https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx |
| An npm package entry has `registryType: "npm"`, `identifier`, `version` (never `"latest"`), `transport: {"type":"stdio"}`, an optional `runtimeHint`, and `environmentVariables[]` (`name`, `description`, `isRequired`, `isSecret`, `format`, `default`). | https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md |
| Ownership: "The `mcpName` property MUST match the server name from `server.json`." The validator reads `mcpName` from the **published** npm version and compares it exactly. | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx |
| Namespaces: `io.github.<user-or-org>/*` is proven with `login github` (device flow) or `login github-oidc` (Actions). Reverse-DNS names are proven with `dns` or `http`. Publishing to an organisation namespace needs the Owner role, and `login github` "cannot currently publish to an organization namespace". | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx, https://github.com/modelcontextprotocol/registry/issues/1468 |
| Namespace matching is **case-sensitive**, although GitHub logins are not (open issue). Use the exact case of your GitHub login. | https://github.com/modelcontextprotocol/registry/issues/689 |
| `mcp-publisher` installs with `brew install mcp-publisher` or a release tarball. The latest release is v1.8.7, and releases come with sigstore bundles. Commands: `init`, `login github`, `login github-oidc`, `validate`, `publish`, `status`. | https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md |
| Every version string must be unique and can't be changed once published. Version ranges are rejected. Matching the package version is recommended but not required. | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/versioning.mdx |
| The CI example publishes on a `v*` tag with `permissions: id-token: write`, verifies `mcp-publisher` with cosign, then runs `login github-oidc` and `publish`. | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx |
| Lookup API: `/v0.1/` is the stable path. Example: `GET /v0.1/servers?search=<text>&version=latest`. | https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md |
| Existing Plesk servers in the registry **(checked)**: `io.github.FlayedOne/plesk-mcp` (PyPI, general hosting management), `io.github.barateza/mcp-plesk-dev-docs` (documentation search), `io.github.mohamedbenhariz/mcp-plesk-lite` (npm: domains, DNS, mail, SSL). **None is about deployment pipelines.** | https://registry.modelcontextprotocol.io/v0.1/servers?search=plesk&version=latest |

**Unclear or conflicting**
- The GitHub Actions page on modelcontextprotocol.io is older than the
  repository's `main` branch. The live page installs from `releases/latest`
  without cosign; `main` pins a version and verifies it.
- The registry's own example passes `NODE_AUTH_TOKEN` to `npm publish`
  without setting `registry-url`. It also doesn't mention npm trusted
  publishing, which npm now recommends (§4).
- The CLI docs and the source code disagree on whether `http` auth covers
  subdomains. It doesn't matter for an `io.github.*` name.

## 4. npm

| Fact | Source |
|---|---|
| These names were **available** on 2026-11-06 **(checked: E404)**: `plesk-deploy-mcp`, `plesk-mcp-deploy`, `mcp-plesk-deploy`, `plesk-release-mcp`, `plesk-mcp`, `plesk-deploy`, `plesk-mcp-server`. `mcp-plesk` was unpublished in June 2026 by its previous owner. | `npm view <name>` |
| New unscoped names must not be "spelled in a similar way to another package name", and names that differ only in punctuation are refused. New names must be lowercase and at most 214 characters. | https://docs.npmjs.com/package-name-guidelines |
| Trusted publishing (OIDC from GitHub Actions) has been generally available since 2025-07-31. It needs npm CLI ≥ 11.5.1 and Node ≥ 22.14.0, no npm token, and adds provenance automatically. It's configured per package on npmjs.com, so **the package must already exist**. Configurations created after 3 September 2026 default to `npm stage publish`; direct `npm publish` must be ticked separately. | https://docs.npmjs.com/trusted-publishers |
| Provenance without trusted publishing: `npm publish --provenance` with `id-token: write` on a GitHub-hosted runner. `repository.url` must match the repository exactly. | https://docs.npmjs.com/generating-provenance-statements |
| Publishing needs 2FA, or a granular token with bypass 2FA. Since November 2025 only granular tokens exist. **Direct publishing with a granular token will be removed in January 2027.** | https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification, https://docs.npmjs.com/about-access-tokens |

**Decision:** releases publish through trusted publishing, so no npm token is
stored in GitHub. The very first version has to be published another way,
because trusted publishing needs the package to exist. The options are in
docs/PUBLISHING.md.

## 5. Claude Desktop extensions (.mcpb)

| Fact | Source |
|---|---|
| The format was renamed from DXT to MCPB. The CLI is `@anthropic-ai/mcpb` 2.1.2 **(checked)**. `manifest_version` **0.3** is "current" and the default; 0.4 adds an experimental `uv` server type. | https://github.com/modelcontextprotocol/mcpb, https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md |
| Local Node stdio servers are supported (`server.type: "node"`, `mcp_config.command: "node"`, `args: ["${__dirname}/..."]`). Claude Desktop ships its own Node. | https://claude.com/docs/connectors/building/mcpb.md, https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop |
| Required manifest fields: `manifest_version`, `name`, `version`, `description`, `author`, `server`. `user_config` supports `string`, `number`, `boolean`, `directory` and `file`, and `sensitive: true` masks a value and stores it securely. Values are substituted with `${user_config.KEY}`. | https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md |
| `tools[]` in the manifest allows only `name` and `description`. **Annotations can't go in the manifest**; the server reports them itself in `tools/list`. | https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md |
| CLI commands: `mcpb init`, `mcpb validate`, `mcpb pack <dir> [output]`, `mcpb sign`, `mcpb verify`, `mcpb info`. `node_modules` is bundled, apart from `.cache` and `.bin`. | https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md |
| Claude Desktop runs on macOS (`darwin`) and Windows (`win32`). | https://claude.com/docs/connectors/building/mcpb.md |

## 6. Anthropic's directory

| Fact | Source |
|---|---|
| **"Desktop extension listings in the directory are deprecated, and the directory no longer accepts MCPB submissions. To distribute a local MCP server through the directory, include it in a plugin."** **(checked: quoted from the live page)** | https://claude.com/docs/connectors/building/mcpb.md, https://claude.com/docs/connectors/building/submission.md, https://claude.com/docs/directory/publish.md |
| A plugin's local MCP server is **ignored in Claude chat**. It loads in Cowork when the session runs on your computer, and in Claude Code. Skills in a plugin load on **every** surface. **(checked)** | https://claude.com/docs/plugins/platform-support.md |
| Submissions go through https://claude.ai/directory/manage → Submit new → Plugin bundle, from a public GitHub repository. Pro, Max, Ultra, Team or Enterprise plans only. | https://claude.com/docs/directory/publish.md |
| Plugin checklist: lowercase name of at most 64 characters. A name that could be mistaken for "a well-known brand that isn't yours" is held for a reviewer. You need a README of 40+ words and a LICENSE, readable source, and MCP servers declared with `command`/`args` (not as `.mcpb`). `npx` versions must be pinned exactly. Credentials go through `userConfig` with `sensitive: true`. | https://claude.com/docs/plugins/pre-submission-checklist.md |
| Directory policy items that apply here: §2A–2B (narrow tool descriptions that match what the tool does), §3A privacy policy, §3B support contact, §3C documentation, §3E at least three working example prompts, §5A helpful errors, §5B token frugality, §5C tool names ≤ 64 characters, §5E "all applicable annotations … in particular readOnlyHint, destructiveHint, and title", §5G reasonably current dependencies, §1F no IP infringement. | https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy |
| Remote connectors (not this project) also have their own review criteria, such as splitting reads and writes into separate tools. | https://claude.com/docs/connectors/building/review-criteria.md |

**Unclear or conflicting**
- A help-centre article (https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
  still points to a desktop-extension submission form. Three newer
  claude.com pages say MCPB submissions are closed. **Not resolved: needs
  your decision (DESIGN.md, D7).**
- submission.md still describes privacy-policy rules "for local connectors"
  in a page that also says local servers can't be submitted.
- No rule addresses third-party trademarks in names directly. The only
  relevant text is the "known brand" reviewer hold and policy §1F.

## 7. Installing in each client

| Client | How | Source |
|---|---|---|
| Claude Code | `claude mcp add --transport stdio --env KEY=value --scope user <name> -- npx -y <pkg>`. Put `--transport` between `--env` and the name. Scopes are `local` (default), `project` (`.mcp.json`) and `user`. Verify with `claude mcp list` / `/mcp`. Claude Code passes `CLAUDE_PROJECT_DIR` to servers. | https://code.claude.com/docs/en/mcp |
| Claude Desktop | `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) with `{"mcpServers": {...}}`. Logs are in `~/Library/Logs/Claude/mcp*.log`. A `.mcpb` installs from Settings → Extensions (Advanced settings → Install Extension…). | https://modelcontextprotocol.io/docs/develop/connect-local-servers, https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json`, with `{"mcpServers": {...}}` and `env`. Install link: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the inner server object>`. | https://cursor.com/docs/context/mcp, https://cursor.com/docs/context/mcp/install-links |
| VS Code | `.vscode/mcp.json` or the user `mcp.json` with top-level `servers` and `type: "stdio"`, or `code --add-mcp '{"name":…,"type":"stdio","command":"npx","args":[…]}'`. Install link: `vscode:mcp/install?<urlencoded JSON>`. | https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/api/extension-guides/ai/mcp |

**Unclear:** the VS Code guided flow now favours a portable Copilot config
and labels `.vscode/mcp.json` "deprecated in the guided flow". The
reference page still documents `.vscode/mcp.json` in full. The README will
show the reference format and `code --add-mcp`.

## 8. Node.js

| Fact | Source |
|---|---|
| **(checked)** Node 26 is Active LTS (since 2026-10-28). Node 24 and 22 are maintenance LTS, ending 2028-04-30 and 2027-04-30. Node 20 reached end of life on 2026-04-30. | https://github.com/nodejs/Release (schedule.json), https://nodejs.org/dist/index.json |

**Decision:** `engines.node: ">=22"`. CI tests on Node 22, 24 and 26.

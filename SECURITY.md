# Security policy

plesk-deploy-mcp can reach production servers over SSH (when you turn that
on), so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue for a vulnerability.** Report it privately
through GitHub instead:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe the problem, the version, and how to reproduce it.

If that isn't possible for you, open an issue that only asks for a private
channel, without any details.

What happens next:

- You'll get an acknowledgement within 7 days.
- The fix is developed in a private security advisory, and you'll be credited
  unless you'd rather not be.
- A fixed version is published to npm and the MCP Registry, and the advisory
  is then made public.

## Supported versions

Only the latest released version gets security fixes.

## Scope

Examples of what counts:

- A way to make a tool run a command other than the fixed ones, on this
  machine or a server.
- A way to reach an SSH host that isn't listed in `PLESK_DEPLOY_SSH_HOSTS`.
- A secret appearing unredacted in a tool result.
- A file written outside the project, or an existing file replaced without
  being listed in `overwrite`.
- Bypassing the rollback confirmation.

The threat model, and the risks that are known and accepted, are in
[docs/SECURITY.md](docs/SECURITY.md).

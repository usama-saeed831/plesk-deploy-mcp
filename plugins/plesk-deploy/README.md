# Plesk Deploy (Claude Code plugin)

This plugin sets up and runs safe deployments to Plesk servers. GitHub Actions
tests and builds a release bundle, a person approves it, and a small release
manager on the server switches to it, health-checks it, and rolls back by
itself when it isn't healthy.

It bundles two things:

- **The `plesk-deploy` skill.** It loads when you talk about deploying to
  Plesk, CI/CD for production, PM2 on a server or rollbacks. It brings the
  8-phase workflow, the rules that are never relaxed, and the reference
  documents and templates.
- **The [plesk-deploy-mcp](https://github.com/usama-saeed831/plesk-deploy-mcp)
  server.** It runs `npx -y plesk-deploy-mcp` at the version this plugin
  pins. Its tools inspect the project, generate and validate the deploy kit
  and, only if you allow hosts, read deploy status and logs and roll back over
  your own SSH.

## Install

```
/plugin marketplace add usama-saeed831/plesk-deploy-mcp
/plugin install plesk-deploy@plesk-deploy-mcp
```

When you enable it, Claude Code asks for two optional settings:

- **Allowed SSH host aliases.** Leave it empty to keep the SSH tools off.
- **A read-only GitHub token,** needed only for private repositories.

Neither ever needs a private key or a password. The server needs Node.js 22
or later.

## Use

> Set up a Plesk deployment for this project.

The safety model, every tool and the FAQ are in the
[main README](https://github.com/usama-saeed831/plesk-deploy-mcp#readme).
The privacy policy is
[PRIVACY.md](https://github.com/usama-saeed831/plesk-deploy-mcp/blob/main/PRIVACY.md).
Report problems through
[GitHub issues](https://github.com/usama-saeed831/plesk-deploy-mcp/issues).

MIT licensed. Not affiliated with or endorsed by Plesk or WebPros.

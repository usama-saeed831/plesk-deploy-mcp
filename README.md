# plesk-deploy-mcp

An MCP server that helps any AI agent set up and operate safe, approval-gated
deployments to Plesk servers. It packages the `plesk-deploy` workflow: it
inspects a project, generates and validates a deploy kit (GitHub Actions, a
release manager with automatic rollback, and server set-up), and, if you opt
in, checks deploy status and logs and rolls back over your own SSH.

**Status: under construction.** The design is in [docs/DESIGN.md](docs/DESIGN.md).

Not affiliated with or endorsed by Plesk or WebPros.

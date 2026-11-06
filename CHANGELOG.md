# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

The first release.

### Added

- Resources: the plesk-deploy workflow, 10 reference documents (including an
  anonymised worked example), and the 12 templates.
- The prompt `setup-plesk-deployment`, which walks through the 8 phases.
- Local tools: `inspect_project`, `server_discovery_commands`,
  `generate_deploy_kit` (a dry run by default) and `validate_deploy_kit`.
- SSH tools, off until `PLESK_DEPLOY_SSH_HOSTS` lists aliases:
  `server_discover`, `deploy_status`, `deploy_logs` and `rollback` (with an
  exact confirmation).
- `github_deploy_runs`, which reads deploy run status from the GitHub API.
- A `--log [N]` command in the release manager, so the deploy account can read
  the root-only deploy log through its single sudo rule.
- A Claude Desktop extension (`.mcpb`) and an MCP Registry entry.
- A Claude Code plugin (`plesk-deploy`: the skill plus this server, pinned to the same version), with this repository as its marketplace.

[Unreleased]: https://github.com/usama-saeed831/plesk-deploy-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/usama-saeed831/plesk-deploy-mcp/releases/tag/v0.1.0

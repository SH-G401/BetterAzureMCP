# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Tool names and their input parameters are part of the public API.

## [Unreleased]

## [0.1.0] - 2026-09-25

### Added

- Stdio MCP server supporting both the 2025-11-25 and the stateless 2026-07-28 protocol revisions.
- Tools: `azure_context`, `azure_find_resources`, `azure_resource_graph_query`, `azure_get_resource`.
- Non-interactive sign-in through environment variables, Azure CLI, Azure Developer CLI or Azure PowerShell, with token caching and immediate, actionable errors when not signed in.
- HTTP pipeline with an egress allowlist, a read-only policy, retries with backoff and proxy support.
- Per-call deadlines, secret masking and size-capped results.
- `betterazuremcp doctor` to check sign-in, subscriptions and connectivity.

[Unreleased]: https://github.com/SH-G401/BetterAzureMCP/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SH-G401/BetterAzureMCP/releases/tag/v0.1.0

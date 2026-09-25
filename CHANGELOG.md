# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Tool names and their input parameters are part of the public API.

## [Unreleased]

## [1.0.0] - 2026-09-25

First release on npm. Tool names and parameters are now covered by semantic versioning.

### Added

- Stdio MCP server supporting both the 2025-11-25 and the stateless 2026-07-28 protocol revisions.
- Discovery tools: `azure_context`, `azure_find_resources`, `azure_resource_graph_query`, `azure_get_resource`.
- Telemetry tools: `azure_resource_health`, `azure_recent_changes`, `azure_activity_log`, `azure_telemetry_locations`, `azure_metrics`, `azure_logs_query`, `azure_appinsights_failures`, `azure_appinsights_trace`.
- Platform tools: `azure_appservice_overview`, `azure_appservice_logs`, `azure_diagnostics`, `azure_containerapp_overview`, `azure_containerapp_logs`, `azure_aks_overview`, `azure_aks_workloads`, `azure_aks_pod_logs`.
- Current subscription: the server remembers the subscription and directory you worked in most recently, across sessions, and tells the assistant, so it no longer has to ask where to look. `azure_context` switches subscription or directory by name. `azure_activity_log` and `azure_recent_changes` use the current subscription when no scope is given. Stored locally; turn off with `BETTERAZUREMCP_REMEMBER_CONTEXT=false`.
- `BETTERAZUREMCP_SUBSCRIPTIONS` limits the server to chosen subscriptions, enforced in the HTTP pipeline.
- Prompt-injection hardening: results that carry free text are marked as untrusted, and text that reads like instructions to an AI assistant is flagged with a warning.
- Memory watchdog: the server stops itself if it exceeds `BETTERAZUREMCP_MAX_MEMORY_MB` (default 1024).
- Non-interactive sign-in through environment variables, Azure CLI, Azure Developer CLI or Azure PowerShell, with token caching and immediate, actionable errors when not signed in.
- HTTP pipeline with an egress allowlist (Azure Resource Manager, Log Analytics, App Service Kudu sites, AKS API servers), per-host read-only path rules, retries with backoff and proxy support.
- Per-call deadlines, secret masking, size-capped results, and role-specific guidance when access is denied.
- `betterazuremcp doctor` to check sign-in, subscriptions and connectivity.
- Development: tool-selection eval (`npm run eval:tools`), soak test (`npm run soak`), live check against your own tenant (`npm run live-check`), CodeQL and `npm audit` in CI, and a release workflow that publishes to npm with provenance.

[Unreleased]: https://github.com/SH-G401/BetterAzureMCP/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/SH-G401/BetterAzureMCP/releases/tag/v1.0.0

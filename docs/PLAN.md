# BetterAzureMCP: Design & Plan (v1)

_Follows [RESEARCH.md](RESEARCH.md). Decisions made 2026-09-25._

> **Status:** all milestones are implemented as of v1.0.0. Differences from this plan:
>
> - `azure_appinsights_query` was folded into `azure_logs_query`, which accepts an Application Insights resource as its scope. `azure_containerapp_logs` became a separate tool, and `azure_appservice_diagnostics` became `azure_diagnostics`, which also covers Container Apps. The total is still 20 tools.
> - Log queries go to `api.loganalytics.io` only. `api.applicationinsights.io` and `*.metrics.monitor.azure.com` are not needed: Application Insights data is read from its workspace, and metrics through Azure Resource Manager.
> - AKS workload access is on by default for clusters with Entra ID integration, where the user kubeconfig holds no credentials, and never attempted for other clusters.
> - The response cap is 12 KB by default (configurable).
>
> See the [README](../README.md) for current behaviour.

## 0. Decisions

| Topic          | Decision                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priorities     | 1. Ease of use, 2. Stability, 3. Privacy by design                                                                                                                                                |
| Target clients | GitHub Copilot Desktop app, VS Code + Copilot, Visual Studio, Copilot CLI (all via **local stdio**)                                                                                               |
| Scope          | **Read-only**. No create, update, or delete. Ever, in v1                                                                                                                                          |
| Focus          | Debugging read-outs for Azure applications: telemetry (App Insights, Log Analytics, metrics, activity log, resource health, diagnostic settings), App Service / Functions, Container Apps, AKS, … |
| Language       | **TypeScript** (Node.js). C++ was evaluated and rejected (see §6)                                                                                                                                 |

## 1. Privacy: what it means precisely

**Promise:** the server talks **only** to Azure's own endpoints, on your behalf, with your credentials. It sends nothing to us, to Microsoft telemetry, or to any third party.

How we enforce it (not just promise it):

1. **Egress allowlist in code.** Every outbound HTTP request goes through one pipeline policy. That policy rejects any host that isn't on this list:
   - `management.azure.com`
   - `api.loganalytics.io` / `api.loganalytics.azure.com`
   - `api.applicationinsights.io`
   - `*.metrics.monitor.azure.com`
   - `*.scm.azurewebsites.net` (Kudu)
   - `*.azmk8s.io` (AKS API servers)
   - sovereign-cloud equivalents, only when that cloud is selected

   A unit test asserts that the list never grows unnoticed.

2. **No telemetry code at all.** No Application Insights SDK, no crash reporting, no update checks, no "phone home". The HTTP `User-Agent` is set to a minimal `betterazuremcp/<version>`.
3. **Tokens stay local.** We don't store credentials ourselves. Tokens come from your existing `az` / `azd` / PowerShell login and are only held in memory.
4. **Logs are local only.** They go to stderr, or to an opt-in file, with secrets redacted.
5. **Secrets are masked by default.** App settings, connection strings, and anything that looks like a key or SAS token are shown as `***` (names stay visible). You can unmask per request only if you set `BETTERAZUREMCP_SHOW_SECRETS=1`.
6. **Minimal supply chain.** The server is bundled into a single JS file with a pinned lockfile and npm provenance, and it has as few dependencies as possible.

**What we can't control:** the AI client, Copilot, sends tool _results_ to its language model. That's the client's data flow, not ours. Masking (point 5) and response-size limits reduce what ends up there. The docs will state this plainly.

Also note that the Azure CLI has its own telemetry, separate from us. To turn it off: `az config set core.collect_telemetry=false`.

## 2. Read-only by design

Some Azure _read_ APIs use POST (for example Resource Graph queries, log queries, and metrics batch). So "GET only" isn't enough.

- **Method guard policy:** GET is allowed. **POST** is allowed only for an explicit list of read endpoints:
  - Resource Graph `resources`
  - Log Analytics / App Insights `query`
  - Metrics `batch`
  - AKS `listClusterUserCredential` (opt-in, see §4.4)

  PUT, PATCH, and DELETE are always refused.

- **Excluded POSTs:** `listKeys`, `listSecrets`, `publishxml`, `runCommand`, and similar calls that return secrets or change state are never on the list.
- On Kubernetes we only use the `get`/`list` verbs (plus `pods/log`). There's no `exec` and no `port-forward`.
- A test enumerates every request the tools can make and fails on anything outside the policy.

## 3. Stability rules (from the RESEARCH.md root causes)

| Root cause in the official server                       | Our rule                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: auth blocks for up to 5 minutes on a browser prompt | Only **non-interactive** credentials: Azure CLI → azd → Azure PowerShell → environment/managed identity. We check them in the background at startup. If none works, the tool returns _immediately_ with an error like `Not signed in: run "az login"` |
| F2: calls can hang for an hour                          | Every tool gets an `AbortSignal.timeout` (default 60 s). Log queries also send a server-side timeout. Responses are paginated                                                                                                                         |
| F3: stray output on stdout                              | Before anything else loads, `console.log`/`info`/`debug` are rerouted to stderr. A CI test starts the server and checks that stdout contains only valid JSON-RPC                                                                                      |
| F4: runtime platform-binary download                    | Pure JS with no native modules. The bundled file runs on any Node ≥ 22                                                                                                                                                                                |
| F5: auto-update and settings changes restart the server | No auto-update, pinned versions, and tool names treated as a semver public API                                                                                                                                                                        |
| F6: session loss                                        | MCP TS SDK v2 `serveStdio`, which serves `2026-07-28` (stateless) and the 2025-era protocol. The server keeps no per-session state                                                                                                                    |
| F7: tool overload and huge responses                    | About 20 tools total. Responses have a summary line followed by compact JSON, capped at about 8 KB, with a "narrow your query" hint when cut off                                                                                                      |
| F8: tenant confusion                                    | `azure_context` shows the credential source, user, tenant, and default subscription. Tenant and subscription can be pinned via env/config                                                                                                             |

A `betterazuremcp doctor` command checks the Node version, credential, tenant, subscriptions, and endpoint reachability, then prints the fixes.

## 4. Tool catalog (v1, all read-only)

The descriptions will be written for the model, with an example in each. Tool names are drafts.

### 4.1 Orientation

| Tool                         | Purpose                                                                                     | API                |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| `azure_context`              | Who am I, credential source, tenant, subscriptions, defaults                                | token claims + ARM |
| `azure_find_resources`       | Find resources by name, type, tag, or resource group across subscriptions                   | Resource Graph     |
| `azure_resource_graph_query` | Free-form KQL against Resource Graph (`resources`, `resourcechanges`, `healthresources`, …) | Resource Graph     |
| `azure_get_resource`         | Full ARM JSON for any resource ID (api-version resolved automatically), secrets masked      | ARM GET            |

### 4.2 "What's wrong?" for any resource

| Tool                        | Purpose                                                                                                                     | API                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `azure_resource_health`     | Current and recent availability, plus platform/service-health events                                                        | Resource Health                       |
| `azure_recent_changes`      | What changed on this resource or RG in the last N hours (property diffs)                                                    | Resource Graph `resourcechanges`      |
| `azure_activity_log`        | Who did what: failed operations, restarts, scale events, deployments                                                        | Activity Log                          |
| `azure_telemetry_locations` | **Where do this resource's logs and metrics go?** Diagnostic settings → workspaces, linked App Insights, storage, Event Hub | ARM diagnosticSettings + app settings |
| `azure_metrics`             | List available metrics, or query them (CPU, memory, HTTP 5xx, latency, restarts, DLQ count, …)                              | Azure Monitor metrics                 |

### 4.3 Telemetry

| Tool                         | Purpose                                                                                                        | API                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `azure_logs_query`           | KQL against a Log Analytics workspace (with time range and row cap)                                            | Log Analytics query     |
| `azure_appinsights_query`    | KQL against Application Insights (both workspace-based and classic)                                            | App Insights / LA query |
| `azure_appinsights_failures` | One-call triage: top exceptions, failed requests, failing dependencies, slowest operations, with operation IDs | preset KQL              |
| `azure_appinsights_trace`    | End-to-end transaction for one `operation_Id` (requests → dependencies → exceptions → traces)                  | preset KQL              |

### 4.4 Compute platforms

| Tool                           | Purpose                                                                                                               | API                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `azure_appservice_overview`    | State, plan, runtime, slots, health-check status, recent deployments, app settings (masked). Covers **Functions** too | ARM + Kudu                                      |
| `azure_appservice_diagnostics` | The "Diagnose and solve problems" detectors (availability, HTTP 5xx, crashes, restarts)                               | ARM `sites/detectors`                           |
| `azure_appservice_logs`        | Recent container/app logs and deployment logs                                                                         | Kudu `/api/logs/docker`, `/api/deployments`     |
| `azure_containerapp_overview`  | Revisions, replicas, restarts, ingress, scale rules, plus console/system logs from the linked workspace               | ARM + LA                                        |
| `azure_aks_overview`           | Cluster version, node pools, power and provisioning state, upgrade profile, diagnostics                               | ARM                                             |
| `azure_aks_workloads`          | Pods (status, restarts, reasons), Warning events, deployments, nodes, with namespace filter                           | Kubernetes API (Entra token), `get`/`list` only |
| `azure_aks_pod_logs`           | Tail logs of a pod or container, including `--previous` for crash loops                                               | Kubernetes API `pods/log`                       |

For AKS in-cluster reads, the first choice is clusters with Entra ID integration, using your own token and your Kubernetes RBAC. Local-account clusters need `listClusterUserCredential`, which is off by default. For private clusters, or clusters we can't reach, the tool falls back to Container Insights tables (`KubePodInventory`, `KubeEvents`, `ContainerLogV2`) in Log Analytics.

### 4.5 Later (v1.x): same patterns, easy to add

- Container Instances (logs, events)
- Service Bus / Event Hubs (queue depth, dead-letter counts via ARM/metrics)
- Azure SQL / PostgreSQL (query-performance insights, server logs)
- Front Door / App Gateway (access/WAF logs via LA)
- API Management (request logs)
- Key Vault (metadata and access failures, **never secret values**)
- Storage (availability and throttling metrics)

**v1 total: 20 tools**, well below the 128-tool limit. Each tool description targets about 150 tokens.

## 5. Technical architecture

```
betterazuremcp (single bundled ESM file, Node >= 22)
├─ src/main.ts            stdout guard first, CLI: `serve` (default) | `doctor` | `--version`
├─ src/server.ts          MCP TS SDK v2: serveStdio(), tool registration
├─ src/auth/              non-interactive credential chain, background pre-warm, tenant pinning
├─ src/http/              one pipeline: egress allowlist → read-only guard → timeout → retry(429/5xx) → redaction
├─ src/azure/             thin clients: arm.ts (api-version cache), resourceGraph.ts, logs.ts, metrics.ts, kudu.ts, k8s.ts
├─ src/tools/             one file per tool: zod input schema, description, handler, output formatter
├─ src/format/            summary line + compact JSON, size cap, masking
└─ test/                  vitest: unit tests, recorded HTTP fixtures, stdio protocol test, stdout-purity test, policy tests
```

- **MCP SDK:** `@modelcontextprotocol/server` v2 (currently 2.1.x) with `serveStdio`. It serves `2026-07-28` and the 2025-era protocol side by side.
- **Azure:**
  - `@azure/identity` for `AzureCliCredential`, `AzureDeveloperCliCredential`, `AzurePowerShellCredential`, `EnvironmentCredential`, `ManagedIdentityCredential`
  - `@azure/core-rest-pipeline` for our policies
  - Thin REST clients of our own instead of dozens of `@azure/arm-*` packages. That gives a smaller bundle, generic api-version handling, and one place to enforce the policies
- **Validation:** `zod` for tool input schemas.
- **Build:** `tsc --noEmit` for types, `esbuild` into one `dist/betterazuremcp.mjs`, no runtime `node_modules`.
- **Quality:** ESLint, Prettier, vitest. GitHub Actions on Windows, macOS, and Linux across Node 22, 24, and 26.

### Distribution (ease of use)

| Channel                   | Command                                                                      | Notes                                                                                |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| npm (primary)             | `npm i -g betterazuremcp` → command `betterazuremcp`                         | Stable: no `npx @latest` resolution on every launch                                  |
| npx (pinned)              | `npx -y betterazuremcp@1.2.3`                                                | Supported, always pinned in our docs                                                 |
| VS Code                   | one-click `vscode:mcp/install?…` badge                                       | Writes the `mcp.json` entry for you                                                  |
| GitHub Copilot Desktop    | Settings → MCP Servers → Add custom server → stdio, command `betterazuremcp` | Screenshot guide in README                                                           |
| Copilot CLI               | `/mcp add`, or `~/.copilot/mcp-config.json`                                  | Snippet in README                                                                    |
| Standalone binary (later) | Node SEA executables on GitHub Releases, winget/Homebrew                     | For machines without Node. SEA is still experimental in Node, so this comes after v1 |

Client config, identical everywhere:

```json
{ "servers": { "azure": { "type": "stdio", "command": "betterazuremcp" } } }
```

## 6. Why not C++?

C++ would be possible in theory, but it works against all three priorities:

- **No Azure SDK for what we need.** The Azure SDK for C++ covers only data-plane services. It has no ARM/management plane, no Resource Graph, and no Monitor query. We'd hand-write every REST client and token handling ourselves.
- **No official MCP SDK in the Tier 1 set.** The Tier 1 SDKs are TypeScript, Python, Go, and C#. We'd depend on a community library or write the protocol layer ourselves.
- **Stability risk.** Memory-safety bugs mean crashes, and a crashed process is exactly the "not connected" experience we're trying to eliminate.
- **Distribution.** We'd need per-platform native builds and signing.

TypeScript has the best MCP SDK, mature Azure SDKs, and is the language VS Code and Copilot tooling are built in.

## 7. Milestones

1. **M1 — Skeleton:** repo scaffold, build, stdout guard, auth chain, HTTP policies, `doctor`, `azure_context`, `azure_find_resources`, `azure_resource_graph_query`, `azure_get_resource`. Tested in VS Code and GitHub Copilot Desktop.
2. **M2 — Telemetry:** `azure_telemetry_locations`, `azure_logs_query`, `azure_appinsights_query`, `azure_appinsights_failures`, `azure_appinsights_trace`, `azure_metrics`, `azure_activity_log`, `azure_resource_health`, `azure_recent_changes`.
3. **M3 — Platforms:** App Service/Functions (overview, detectors, logs), Container Apps, AKS (overview, workloads, pod logs).
4. **M4 — Ship:** README with per-client setup, VS Code install badge, npm publish with provenance, v1.0.0.

## 8. To verify during M1

- That `serveStdio` in SDK v2 negotiates both protocol eras with VS Code, Copilot Desktop, and Copilot CLI as they ship today.
- That Kudu endpoints accept Entra bearer tokens when basic auth is disabled.
- The GitHub Copilot Desktop stdio config: whether it inherits `PATH`, so it can find `az` and `betterazuremcp`.

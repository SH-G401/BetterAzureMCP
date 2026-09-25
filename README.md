# BetterAzureMCP

[![CI](https://github.com/SH-G401/BetterAzureMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/SH-G401/BetterAzureMCP/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/betterazuremcp)](https://www.npmjs.com/package/betterazuremcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933)

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for Azure, built for one job: helping developers debug their Azure applications from GitHub Copilot, VS Code and other MCP clients.

Ask _"why is orders-api returning 500s since this morning?"_ and the assistant can check resource health, recent configuration changes, failed deployments, Application Insights exceptions, container logs and pod restarts, without you opening the portal.

- **Stable.** Every tool call has a hard deadline. Sign-in never waits on a hidden browser window. Nothing but protocol messages is written to stdout. No auto-updates and no runtime downloads.
- **Private.** The server only talks to Azure's own API endpoints, enforced by an allowlist in code. No telemetry, no analytics, no third parties.
- **Read-only.** Write operations are blocked at the HTTP layer, not just left out of the tool list. Secret values are masked before they leave the server.
- **Focused.** 20 tools that cover the debugging path, instead of hundreds of per-service wrappers competing for the model's attention.

## Contents

- [Quick start](#quick-start)
- [Client setup](#client-setup)
- [Tools](#tools)
- [Permissions](#permissions)
- [Current subscription](#current-subscription)
- [Configuration](#configuration)
- [Privacy and safety](#privacy-and-safety)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Quick start

You need Node.js 22 or later and an Azure login through the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az login`), the [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/) (`azd auth login`) or [Azure PowerShell](https://learn.microsoft.com/powershell/azure/) (`Connect-AzAccount`).

```sh
npm install -g betterazuremcp
az login
betterazuremcp doctor
```

`doctor` checks the setup and tells you what to fix:

```text
betterazuremcp 1.0.0 doctor

  ok    Node.js version: 22.22.2
  ok    Azure sign-in: dev@contoso.com (tenant 8a1c...e42f) via Azure CLI (az login)
  ok    Subscriptions: 3 accessible, 3 enabled
  ok    Azure Resource Graph: reachable, 412 resources indexed
```

Then add the server to your client.

## Client setup

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=azure&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22betterazuremcp%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_server-24bfa5?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=azure&quality=insiders&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22betterazuremcp%22%7D)

Every client starts the server the same way: the command `betterazuremcp`, over stdio, with no arguments.

### VS Code (GitHub Copilot)

Use the install button above, or add this to `.vscode/mcp.json` (or **MCP: Open User Configuration** for all workspaces):

```json
{
  "servers": {
    "azure": {
      "type": "stdio",
      "command": "betterazuremcp"
    }
  }
}
```

The tools are available in Copilot Chat in **Agent** mode.

### GitHub Copilot Desktop

1. Open **Settings** (gear icon, bottom left) → **MCP Servers** → **Add custom server**.
2. Name: `azure`. Transport: `stdio`. Command: `betterazuremcp`.
3. Save. The server starts with the next chat.

Visual Studio, Copilot CLI, Claude Desktop and others are covered in [docs/clients.md](docs/clients.md).

## Tools

**Finding things**

| Tool                         | What it does                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `azure_context`              | Who you are signed in as, the directory, your subscriptions and the current subscription. Switches subscription or directory. |
| `azure_find_resources`       | Finds resources by name, type, resource group, location or tag across all subscriptions.                                      |
| `azure_resource_graph_query` | KQL against Azure Resource Graph, for inventory questions across subscriptions.                                               |
| `azure_get_resource`         | The full definition of any resource by ID.                                                                                    |

**What is wrong with this resource?**

| Tool                        | What it does                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `azure_resource_health`     | Azure's own view of the resource's availability, recent outages, and active service issues.                     |
| `azure_recent_changes`      | Configuration changes in the last 14 days, with before and after values and who made them.                      |
| `azure_activity_log`        | Deployments, restarts, scaling and other operations, and why they failed.                                       |
| `azure_telemetry_locations` | Where the resource's logs go: workspaces, Application Insights, storage, Event Hubs, and which tables to query. |
| `azure_metrics`             | Platform metrics such as CPU, memory, HTTP 5xx, latency and restarts, summarized.                               |

**Telemetry**

| Tool                         | What it does                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `azure_logs_query`           | KQL against a Log Analytics workspace, an Application Insights resource, or one resource's logs.             |
| `azure_appinsights_failures` | One-call triage: failure rate, failing operations, top exceptions, failing dependencies, slowest operations. |
| `azure_appinsights_trace`    | Every request, dependency call, exception and trace of one operation, in time order.                         |

**Platforms**

| Tool                          | What it does                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `azure_appservice_overview`   | App Service and Function app state, runtime, plan, key settings, logging, slots, deployments, functions. |
| `azure_appservice_logs`       | The latest application or platform log lines from the app's log files.                                   |
| `azure_diagnostics`           | Azure's built-in "Diagnose and solve problems" detectors for App Service and Container Apps.             |
| `azure_containerapp_overview` | Container App revisions, replicas, restart counts, ingress, scale rules and containers.                  |
| `azure_containerapp_logs`     | Console and system logs of a Container App.                                                              |
| `azure_aks_overview`          | AKS cluster state, version and upgrades, node pools, networking and add-ons.                             |
| `azure_aks_workloads`         | Failing pods, Warning events, unavailable deployments and unhealthy nodes, live from the cluster.        |
| `azure_aks_pod_logs`          | Pod logs, including the previous instance of a crashing container.                                       |

Results start with a one-line summary followed by compact JSON, and are capped in size so they do not flood the model's context.

Things to ask:

- _"orders-api has been returning 500s since 9:00. Find out why."_
- _"What changed in resource group rg-orders-prod in the last 24 hours?"_
- _"Show the slowest operations of the checkout service this week and trace one of them."_
- _"Why does the latest revision of the payments container app not become healthy?"_
- _"Which pods in the shop namespace of aks-prod are crash-looping, and what do their logs say?"_

## Permissions

The server can only see what your account can see. Most tools work with the **Reader** role. A few need more:

| Tools                                                  | Role needed                                                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All tools, at the scope you want to inspect            | Reader                                                                                                                                                                                             |
| `azure_appservice_logs` (reads log files through Kudu) | A role with `Microsoft.Web/sites/publish/Action`, such as Website Contributor                                                                                                                      |
| `azure_aks_workloads`, `azure_aks_pod_logs`            | Azure Kubernetes Service Cluster User Role, plus read access inside the cluster (Azure Kubernetes Service RBAC Reader, or a Kubernetes `view` binding). The cluster must use Entra ID integration. |

When a role is missing, the tool says which one and suggests an alternative that works with Reader.

## Current subscription

The server remembers the subscription and directory (Entra tenant) you worked in most recently, so the assistant does not have to ask where to look every time.

- **It follows your work.** Whenever a tool reads a resource in a subscription, that subscription becomes the current one. Tools that need a scope, such as the activity log and recent changes, use it when you don't name another.
- **The assistant knows it.** The current subscription is part of the server's instructions at the start of every session, and `azure_context` shows it.
- **Switching is one sentence.** _"Switch to the Staging subscription"_ or _"look in the fabrikam.onmicrosoft.com directory"_ makes the assistant call `azure_context` with the new choice, which is then remembered.
- **It survives restarts and stays local.** The choice is stored in a small file in your user profile: `~/.local/state/betterazuremcp/context.json` on Linux, `~/Library/Application Support/betterazuremcp/` on macOS, `%APPDATA%\betterazuremcp\` on Windows. It holds only IDs and display names. Delete it to forget, or set `BETTERAZUREMCP_REMEMBER_CONTEXT=false`.

If the remembered directory stops working for your login, for example after you sign in with another account, the server falls back to your default directory and forgets the old choice. `BETTERAZUREMCP_TENANT_ID` and `BETTERAZUREMCP_SUBSCRIPTIONS` always take precedence.

## Configuration

Configuration is optional and done through environment variables. Most clients let you set them in the server entry (`"env": { ... }`).

| Variable                          | Default                  | Description                                                                                                                                                                                 |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTERAZUREMCP_TENANT_ID`        | tenant of your login     | Tenant to sign in to. Set this if you have access to several tenants.                                                                                                                       |
| `BETTERAZUREMCP_CREDENTIAL`       | `auto`                   | `auto` tries environment variables, Azure CLI, Azure Developer CLI and Azure PowerShell, in that order. Or pin one: `azurecli`, `azd`, `azurepowershell`, `environment`, `managedidentity`. |
| `BETTERAZUREMCP_TIMEOUT_SECONDS`  | `60`                     | Deadline for a single tool call (5–600).                                                                                                                                                    |
| `BETTERAZUREMCP_MAX_RESPONSE_KB`  | `12`                     | Size limit for a single tool result (2–256).                                                                                                                                                |
| `BETTERAZUREMCP_SUBSCRIPTIONS`    | all accessible           | Comma-separated subscription IDs. The server then reads only from these subscriptions, enforced for every request.                                                                          |
| `BETTERAZUREMCP_MAX_MEMORY_MB`    | `1024`                   | The server stops itself if it ever uses more memory than this. The client restarts it on the next call.                                                                                     |
| `BETTERAZUREMCP_REMEMBER_CONTEXT` | `true`                   | Remember the subscription and directory you worked in last. Set to `false` to turn it off.                                                                                                  |
| `BETTERAZUREMCP_STATE_DIR`        | per-user app data folder | Where the remembered context is stored.                                                                                                                                                     |
| `BETTERAZUREMCP_SHOW_SECRETS`     | `false`                  | Set to `true` to stop masking secret values. Not recommended.                                                                                                                               |
| `BETTERAZUREMCP_LOG_LEVEL`        | `info`                   | `error`, `warn`, `info` or `debug`. Logs go to stderr, which clients show in their output panel.                                                                                            |

Behind a corporate proxy, set `HTTPS_PROXY` (and `NO_PROXY` if needed).

## Privacy and safety

- **Where data goes.** Requests go only to Azure Resource Manager (`management.azure.com`), the Log Analytics query API (`api.loganalytics.io`), your App Service apps' Kudu sites (`*.scm.azurewebsites.net`) and your AKS API servers (`*.azmk8s.io`). Any other host is refused before a request is made.
- **What is sent.** Only the Azure API calls needed to answer a tool call. There is no telemetry, crash reporting or update check.
- **What cannot happen.** `PUT`, `PATCH` and `DELETE` are blocked, and so is every `POST` that is not a known read. Kudu access is limited to log files, and Kubernetes access to pod, event, deployment and node status and pod logs. Secrets, config maps, `exec` and calls such as `listKeys` are never reachable.
- **Prompt injection.** Logs, messages and tags can contain text written by anyone. Results that carry such text are marked as untrusted, and text that reads like instructions to an AI assistant is flagged with a warning. The server has nothing to steal and no way to send data out: it never reads secret values, cannot write, and can only reach Azure endpoints of resources you can already read.
- **What the AI sees.** Your MCP client passes tool results to its language model. Values that look like secrets (passwords, keys, connection strings, SAS tokens) are masked first, and app setting values are never read.

The full model is in [SECURITY.md](SECURITY.md).

## Troubleshooting

Start with `betterazuremcp doctor`. It checks sign-in, subscriptions and connectivity, and prints what to fix.

| Symptom                                       | Fix                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Not signed in to Azure"                      | Run `az login` in a terminal. The client does not need to be restarted.                                                                                                                  |
| Signed in, but no subscriptions or 403 errors | You may be in the wrong tenant. Run `az login --tenant <tenant>` or set `BETTERAZUREMCP_TENANT_ID`.                                                                                      |
| The client cannot start `betterazuremcp`      | The client may not see your `PATH`. Use the full path from `which betterazuremcp` (macOS/Linux) or `where betterazuremcp` (Windows). See [docs/clients.md](docs/clients.md) for Windows. |
| Timeouts on large queries                     | Narrow the query, or raise `BETTERAZUREMCP_TIMEOUT_SECONDS`.                                                                                                                             |
| AKS tools cannot reach a private cluster      | Private API servers are only reachable from their network. Use `azure_logs_query` with Container Insights tables instead.                                                                |

Server logs appear in your client's MCP output (in VS Code: **MCP: List Servers** → `azure` → **Show Output**). Set `BETTERAZUREMCP_LOG_LEVEL=debug` for more detail.

### Building from source

```sh
git clone https://github.com/SH-G401/BetterAzureMCP.git
cd BetterAzureMCP
npm ci
npm run build
npm link    # puts the `betterazuremcp` command on your PATH
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and ground rules, and [docs/architecture.md](docs/architecture.md) for how the code fits together. The reasoning behind the design is in [docs/RESEARCH.md](docs/RESEARCH.md) and [docs/PLAN.md](docs/PLAN.md), and [docs/COMPLAINTS.md](docs/COMPLAINTS.md) tracks user complaints about the official Azure MCP Server and what we do about each.

## License

[MIT](LICENSE)

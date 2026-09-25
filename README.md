# BetterAzureMCP

[![CI](https://github.com/SH-G401/BetterAzureMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/SH-G401/BetterAzureMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933)

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for Azure, built for one job: helping developers debug their Azure applications from GitHub Copilot, VS Code and other MCP clients.

It is designed to stay connected, stay out of the way, and never touch anything it should not:

- **Stable.** Every tool call has a hard deadline. Sign-in never waits on a hidden browser window. Nothing but protocol messages is written to stdout. No auto-updates, no runtime downloads.
- **Private.** The server talks only to Azure's own API endpoints, enforced by an allowlist in code. No telemetry, no analytics, no third parties.
- **Read-only.** Write operations are blocked at the HTTP layer, not just left out of the tool list. Secret values are masked before they leave the server.
- **Small.** A handful of general tools built on Azure Resource Graph and Azure Resource Manager, instead of hundreds of per-service wrappers.

> **Status:** early development (v0.1). The core tools below work today. Telemetry (Application Insights, Log Analytics, metrics) and App Service, Container Apps and AKS tools are next; see the [roadmap](#roadmap).

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Client setup](#client-setup)
- [Tools](#tools)
- [Configuration](#configuration)
- [Privacy and safety](#privacy-and-safety)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Requirements

- Node.js 22 or later
- An Azure login on the same machine through one of:
  - [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli): `az login` (recommended)
  - [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/): `azd auth login`
  - [Azure PowerShell](https://learn.microsoft.com/powershell/azure/): `Connect-AzAccount`
- Reader access to the subscriptions or resources you want to inspect

## Installation

BetterAzureMCP is not on npm yet. Until the first release, install it from source:

```sh
git clone https://github.com/SH-G401/BetterAzureMCP.git
cd BetterAzureMCP
npm ci
npm run build
npm link            # puts the `betterazuremcp` command on your PATH
```

Then check that everything is in order:

```sh
az login
betterazuremcp doctor
```

```text
betterazuremcp 0.1.0 doctor

  ok    Node.js version: 22.22.2
  ok    Azure sign-in: dev@contoso.com (tenant 8a1c...e42f) via Azure CLI (az login)
  ok    Subscriptions: 3 accessible, 3 enabled
  ok    Azure Resource Graph: reachable, 412 resources indexed
```

## Client setup

Every client starts the server the same way: the command `betterazuremcp`, over stdio, with no arguments.

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace, or run **MCP: Open User Configuration** to make it available everywhere:

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

Open Copilot Chat in **Agent** mode and the Azure tools are available.

### GitHub Copilot Desktop

1. Open **Settings** (gear icon, bottom left) → **MCP Servers** → **Add custom server**.
2. Name: `azure`. Transport: `stdio`. Command: `betterazuremcp`.
3. Save. The server starts on the next chat.

Other clients, including Visual Studio, Copilot CLI and Claude Desktop, are covered in [docs/clients.md](docs/clients.md).

## Tools

| Tool                         | What it does                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `azure_context`              | Shows who you are signed in as, the tenant, and the subscriptions you can read.                   |
| `azure_find_resources`       | Finds resources by name, type, resource group, location or tag across all subscriptions.          |
| `azure_resource_graph_query` | Runs a KQL query against Azure Resource Graph, including `resourcechanges` and `healthresources`. |
| `azure_get_resource`         | Returns the full definition of any resource by ID, with the API version picked automatically.     |

All tools are marked read-only to the client. Results start with a one-line summary followed by compact JSON, and are capped in size so they do not flood the model's context.

Things you can ask:

- _"Which App Services in westeurope are stopped?"_
- _"What changed in resource group rg-orders-prod in the last 24 hours?"_
- _"Show me the configuration of the orders-api web app. Is Always On enabled?"_
- _"List AKS clusters that are not in the Succeeded provisioning state."_

## Configuration

Configuration is optional and done through environment variables. Most clients let you set these in the server entry (`"env": { ... }`).

| Variable                         | Default              | Description                                                                                                                                                                                 |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTERAZUREMCP_TENANT_ID`       | tenant of your login | Tenant to sign in to. Set this if you have access to several tenants.                                                                                                                       |
| `BETTERAZUREMCP_CREDENTIAL`      | `auto`               | `auto` tries environment variables, Azure CLI, Azure Developer CLI and Azure PowerShell, in that order. Or pin one: `azurecli`, `azd`, `azurepowershell`, `environment`, `managedidentity`. |
| `BETTERAZUREMCP_TIMEOUT_SECONDS` | `60`                 | Deadline for a single tool call (5–600).                                                                                                                                                    |
| `BETTERAZUREMCP_MAX_RESPONSE_KB` | `12`                 | Size limit for a single tool result (2–256).                                                                                                                                                |
| `BETTERAZUREMCP_SHOW_SECRETS`    | `false`              | Set to `true` to stop masking secret values. Not recommended.                                                                                                                               |
| `BETTERAZUREMCP_LOG_LEVEL`       | `info`               | `error`, `warn`, `info` or `debug`. Logs go to stderr, which clients show in their output panel.                                                                                            |

Behind a corporate proxy, set `HTTPS_PROXY` (and `NO_PROXY` if needed).

## Privacy and safety

- **Where data goes.** Requests go only to `management.azure.com`. Any other host is refused before a request is made, and access tokens are only issued for that host. Sign-in itself is handled by the tool you logged in with (for example the Azure CLI).
- **What is sent.** Nothing leaves your machine except the Azure API calls needed to answer a tool call. There is no telemetry, crash reporting or update check.
- **What cannot happen.** `PUT`, `PATCH` and `DELETE` are blocked, and so is every `POST` that is not a known read (such as a Resource Graph query). Calls that return keys, like `listKeys`, are never made.
- **What the AI sees.** Tool results are passed by your MCP client to its language model. Values that look like secrets (passwords, keys, connection strings, SAS tokens) are masked first.

See [SECURITY.md](SECURITY.md) for the full model and how to report a vulnerability.

## Troubleshooting

Start with `betterazuremcp doctor`. It checks sign-in, subscriptions and connectivity, and prints what to fix.

| Symptom                                       | Fix                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Not signed in to Azure"                      | Run `az login` in a terminal. No restart of the client is needed.                                                                    |
| Signed in, but no subscriptions or 403 errors | You may be in the wrong tenant. Run `az login --tenant <tenant>` or set `BETTERAZUREMCP_TENANT_ID`.                                  |
| The client cannot start `betterazuremcp`      | The client may not see your `PATH`. Use the full path from `which betterazuremcp` (macOS/Linux) or `where betterazuremcp` (Windows). |
| Timeouts on large queries                     | Narrow the query, or raise `BETTERAZUREMCP_TIMEOUT_SECONDS`.                                                                         |

Server logs appear in your client's MCP output (in VS Code: **MCP: List Servers** → `azure` → **Show Output**). Set `BETTERAZUREMCP_LOG_LEVEL=debug` for more detail.

## Roadmap

- [x] **0.1** Core: sign-in, guarded HTTP stack, `doctor`, resource discovery and details
- [ ] **0.2** Telemetry: Application Insights and Log Analytics queries, failure triage, transaction traces, metrics, activity log, resource health, "where do this resource's logs go?"
- [ ] **0.3** Platforms: App Service and Functions (diagnostics, logs, deployments), Container Apps, AKS (workloads, events, pod logs)
- [ ] **1.0** npm release, one-click install for VS Code

The reasoning behind the design is in [docs/RESEARCH.md](docs/RESEARCH.md) and [docs/PLAN.md](docs/PLAN.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and the project's ground rules.

## License

[MIT](LICENSE)

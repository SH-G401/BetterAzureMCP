# Security and privacy

BetterAzureMCP gives an AI assistant read access to your Azure environment. This document describes exactly what that access covers, where data goes, and how the limits are enforced.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/SH-G401/BetterAzureMCP/security/advisories/new), not in a public issue. You can expect a first response within a week.

## Data flow

```
MCP client (Copilot, VS Code, ...)
      │  stdio, on your machine
      ▼
betterazuremcp ──── HTTPS ───▶ management.azure.com       Azure Resource Manager, Resource Graph
      │                   ───▶ api.loganalytics.io        Log Analytics and Application Insights queries
      │                   ───▶ <app>.scm.azurewebsites.net App Service log files (Kudu)
      │                   ───▶ <cluster>.azmk8s.io        AKS Kubernetes API
      │
      └─ access tokens from your existing login (Azure CLI, azd, Azure PowerShell)
```

- The server is a local process. It does not listen on any network port.
- It makes outbound requests only to the hosts in [`src/http/endpoints.ts`](src/http/endpoints.ts), shown above. Every request passes an egress check before a token is requested or a connection is opened. Redirects are not followed.
- It sends no telemetry, crash reports, usage statistics or update checks, and has no code to do so. The `User-Agent` header is `betterazuremcp/<version>`, without OS or runtime details.
- Access tokens are obtained through the credential you choose, held in memory, and never written to disk or logs. Tokens are requested only for the scope of the host being called. Token acquisition happens in that credential's own process or library: for example, the Azure CLI talks to `login.microsoftonline.com`, and managed identity uses the local instance metadata endpoint.
- Logs go to stderr only, and contain no tokens or tool results.
- The only file the server writes is the remembered context (see [Current subscription](README.md#current-subscription)): the IDs and display names of the subscription and directory you used last, readable only by your user account. It holds no tokens and no resource data, and is ignored if it is malformed. `BETTERAZUREMCP_REMEMBER_CONTEXT=false` turns it off.

The Azure CLI has its own telemetry, independent of this project. To turn it off, run `az config set core.collect_telemetry=false`.

## Read-only enforcement

Read-only is enforced by a policy in the HTTP pipeline ([`src/http/policies.ts`](src/http/policies.ts)), not only by which tools exist. Each host has its own rules:

| Host                      | Allowed                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `management.azure.com`    | `GET` and `HEAD`. `POST` only for Resource Graph queries and `listClusterUserCredential` (see below).                                      |
| `api.loganalytics.io`     | Query requests only (`/v1/workspaces/<id>/query` and resource-centric `/query`).                                                           |
| `*.scm.azurewebsites.net` | `GET` of `/api/logs/docker` and files under `/api/vfs/LogFiles/`. Not site content, configuration or any other Kudu API.                   |
| `*.azmk8s.io`             | `GET` of pods, events, deployments, nodes, namespaces and pod logs. Not secrets, config maps, `exec`, `attach`, `port-forward` or `proxy`. |

Everything else, including `PUT`, `PATCH`, `DELETE`, `POST` actions such as `listKeys`, `restart` or `runCommand`, and path traversal attempts, is refused before it is sent.

**About `listClusterUserCredential`.** To reach an AKS API server, the server needs its address and CA certificate, which Azure only returns through this `POST`. It is called only for clusters with Entra ID integration, where the returned kubeconfig contains no credentials: requests to the cluster use your own Entra ID token and your Kubernetes permissions. For clusters without Entra ID the call is never made. The admin credential API is never called.

**Subscription scope.** With `BETTERAZUREMCP_SUBSCRIPTIONS` set, a further pipeline policy refuses every request that names another subscription, and requires Resource Graph queries to be limited to the configured subscriptions. Management group queries are refused.

Your Azure role assignments still apply: the server can never see more than the account you signed in with. Assigning that account only the **Reader** role is a good additional safeguard. See the [permissions table](README.md#permissions) for the tools that need more.

## Prompt injection

Tool results carry text that anyone may have written: log lines, exception messages, Kubernetes events, resource tags, commit messages. An attacker who can write such text can try to steer the assistant, as in the published attack on the official Azure MCP Server, where planted instructions made an agent read Key Vault secrets and leak them. BetterAzureMCP limits what such an attack can achieve:

- **No secrets requested.** Key Vault secrets, keys, connection strings and app settings are never requested, and `listKeys`-style calls are blocked in the HTTP pipeline. Logs and telemetry can still contain secrets your application wrote; values that look like secrets are masked, on a best-effort basis (see below).
- **Nothing to change.** Every write is blocked in the HTTP pipeline, whatever the model asks for.
- **No way out.** The server can only reach the hosts on the allowlist. The two hosts that vary per resource (App Service Kudu sites and AKS API servers) are never taken from model input: they are read from the resource's definition in Azure Resource Manager, which only succeeds for resources the signed-in account can already read. A tool call cannot make the server contact an attacker's host.
- **Marked as data.** Results that contain free text are prefixed with a note that the content is untrusted, and the server instructions tell the model never to follow instructions found in results.
- **Flagged when suspicious.** Every result is scanned for text addressed to an AI assistant ("ignore previous instructions", fake chat markup, requests to call tools or send credentials somewhere). Matches add a warning that names where the text was found ([`src/format/injection.ts`](src/format/injection.ts)).

What remains is the model's own judgement within one conversation. Injected text can still try to mislead the analysis, for example by claiming a healthy service is failing. The markers above help the model and the user recognize it.

## What the language model sees

Tool results are returned to your MCP client, and the client passes them to its language model. That transfer is governed by your client and model provider, not by this project. To limit what is exposed:

- Values that look like secrets are masked (`[redacted]`) before they leave the server: properties named like passwords, keys, tokens or connection strings (including changes to them), name/value pairs such as environment variables, connection strings, SAS URLs, JWTs and private keys. The property names stay visible. See [`src/format/redact.ts`](src/format/redact.ts).
- App Service app setting and connection string values are never requested.
- Log lines are returned as your application wrote them. If your application logs secrets, masking catches only the patterns above.
- Results are capped in size (12 KB by default).

Masking is best-effort pattern matching, not a guarantee. `BETTERAZUREMCP_SHOW_SECRETS=true` disables it.

## Changes to these rules

Any change that adds a host to the allowlist, permits a new path or `POST` endpoint, or weakens masking must update this document in the same pull request. Tests in [`test/unit/endpoints.test.ts`](test/unit/endpoints.test.ts) pin the hosts and the path rules so that such a change cannot slip in unnoticed.

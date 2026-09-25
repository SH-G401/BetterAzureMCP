# Security and privacy

BetterAzureMCP gives an AI assistant read access to your Azure environment. This document describes exactly what that access covers, where data goes, and how the limits are enforced.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/SH-G401/BetterAzureMCP/security/advisories/new), not in a public issue. You can expect a first response within a week.

## Data flow

```
MCP client (Copilot, VS Code, ...)
      │  stdio, on your machine
      ▼
betterazuremcp ──── HTTPS ───▶ management.azure.com
      │
      └─ access tokens from your existing login (Azure CLI, azd, Azure PowerShell)
```

- The server is a local process. It does not listen on any network port.
- It makes outbound requests only to the hosts in [`src/http/endpoints.ts`](src/http/endpoints.ts). Today that is `management.azure.com` (Azure Resource Manager and Azure Resource Graph). Every request passes an egress check before a token is requested or a connection is opened. Redirects are not followed.
- It sends no telemetry, crash reports, usage statistics or update checks, and has no code to do so. The `User-Agent` header is `betterazuremcp/<version>`, without OS or runtime details.
- Access tokens are obtained through the credential you choose, held in memory, and never written to disk or logs. Token acquisition happens in that credential's own process or library: for example, the Azure CLI talks to `login.microsoftonline.com`, and managed identity uses the local instance metadata endpoint.
- Logs go to stderr only, and contain no tokens or tool results.

The Azure CLI has its own telemetry, independent of this project. To turn it off, run `az config set core.collect_telemetry=false`.

## Read-only enforcement

Read-only is enforced by a policy in the HTTP pipeline ([`src/http/policies.ts`](src/http/policies.ts)), not only by which tools exist:

- `GET` and `HEAD` are allowed.
- `POST` is allowed only for a fixed list of query endpoints that do not change state. Today that is the Azure Resource Graph query API.
- Everything else, including `PUT`, `PATCH`, `DELETE`, and `POST` actions such as `listKeys`, `restart` or `runCommand`, is refused before it is sent.

Your Azure role assignments still apply: the server can never see more than the account you signed in with. Assigning that account only the **Reader** role is a good additional safeguard.

## What the language model sees

Tool results are returned to your MCP client, and the client passes them to its language model. That transfer is governed by your client and model provider, not by this project. To limit what is exposed:

- Values that look like secrets are masked (`[redacted]`) before they leave the server: properties named like passwords, keys, tokens or connection strings, name/value pairs such as app settings, connection strings, SAS URLs, JWTs and private keys. The property names stay visible. See [`src/format/redact.ts`](src/format/redact.ts).
- Results are capped in size (12 KB by default).

Masking is best-effort pattern matching, not a guarantee. `BETTERAZUREMCP_SHOW_SECRETS=true` disables it.

## Changes to these guarantees

Any change that adds a host to the allowlist, adds an allowed `POST` endpoint, or weakens masking must update this document in the same pull request. Tests pin the allowlist so that such a change cannot slip in unnoticed.

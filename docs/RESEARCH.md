# BetterAzureMCP: Research Phase

> **Update 2026-09-25:** Decisions taken: TypeScript (not Go), read-only, GitHub Copilot Desktop + VS Code, privacy-first. See [PLAN.md](PLAN.md). Section 4 below is kept as the original analysis.

_Research date: 2026-09-25. Baseline studied: Microsoft Azure MCP Server `3.0.0-beta.47` (released 2026-09-24), source at [`microsoft/mcp`](https://github.com/microsoft/mcp) `main`._

## TL;DR

- **The official server is huge and still moving fast.** It has about 60 service namespaces and roughly 540 CLI commands. In `all` mode that becomes 800+ MCP tools. Microsoft ships a release twice a week, and those releases regularly carry breaking renames.
- **The flakiness has concrete causes.** They are in the source and the issue tracker, and the MCP transport isn't the problem. The main ones:
  1. Authentication can block a tool call for up to **5 minutes** waiting on an interactive browser/broker prompt.
  2. Some tools hang with **no timeout** (one hang lasted 54 minutes).
  3. Anything that writes non-JSON bytes to **stdout** corrupts the stdio stream.
  4. **Auto-updates and settings changes restart the server** in the middle of a session.
  5. The npm wrapper downloads a **per-platform binary** at runtime, and that step fails often.
- **Too many tools, and responses that are too big.** Even the curated "consolidated" mode exposes **161 tools**, which is over VS Code Copilot's 128-tool-per-request limit. In namespace mode a single help payload can be 23 KB, and one bug report measured 2.9× the token usage because of it.
- **The protocol changed in our favour.** The MCP spec `2026-07-28` removed protocol sessions (`Mcp-Session-Id`) and the `initialize` handshake. A server built for that spec from day one never shows "not connected to this session" for session reasons.
- **Recommendation:** write it in **Go**, using the official MCP Go SDK (v1.7+, which supports `2026-07-28`) and the Azure SDK for Go (`azidentity`, `armresourcegraph`, `azquery`). It ships as a single static binary with near-instant startup and no runtime to install. **TypeScript** is the runner-up.
- **The design bet:** about 12 general-purpose, well-described tools built on Azure Resource Graph, the ARM REST API, and Azure Monitor, instead of hundreds of per-service wrappers. Every call gets a hard deadline, and auth never blocks.

---

## 1. What the official Azure MCP Server is today

### 1.1 Facts

| Aspect | Current state |
|---|---|
| Repo | `microsoft/mcp` (the older `Azure/azure-mcp` was archived on 2025-08-25) |
| Language / runtime | C# on .NET 10. It uses Native AOT where possible (`PublishAot=true` in `Directory.Build.props`) |
| MCP SDK | `ModelContextProtocol` C# SDK 2.2.0 |
| Version | 2.0 went GA; the `3.0.0-beta.x` line is current, with releases every Tuesday and Thursday |
| Scope | 61 `Azure.Mcp.Tools.*` projects (AKS, Storage, Cosmos, KeyVault, Monitor, SQL, Postgres, Foundry, Backup, …) plus Fabric |
| Tool count | 541 commands documented in `azmcp-commands.md`. `--mode all` gives "~800+ tools" (per `TROUBLESHOOTING.md`) |
| Modes | `namespace` (default: one proxy tool per service), `consolidated` (161 intent-named tools covering 419 commands), `all`, `single` (one router tool) |
| Transports | stdio (local), Streamable HTTP (remote, with OBO or hosting-identity auth) |
| Distribution | VS Code extension (bundled binaries), `npx @azure/mcp@latest` (npm wrapper plus a per-platform package), `dnx` (NuGet), `uvx` (PyPI), Docker, `.mcpb` bundle, built into Visual Studio 2026 |
| Safety | `--read-only`, elicitation prompts for secrets and destructive operations, KQL "safety validation" |

### 1.2 How authentication works (`core/Microsoft.Mcp.Core/src/Services/Azure/Authentication/CustomChainedCredential.cs`)

1. If `VSCODE_PID` is set, the VS Code credential goes first. That's the account from the Azure Resources extension.
2. Next comes the default dev chain: Environment → Visual Studio → VS Code → Azure CLI → Azure PowerShell → azd.
3. If all of those fail, it falls back to an **`InteractiveBrowserCredential` (WAM broker)** wrapped in a `TimeoutTokenCredential` whose **default timeout is 300 seconds** (`AZURE_MCP_BROWSER_AUTH_TIMEOUT_SECONDS`).
4. When running as a CLI (no transport), it adds a device-code fallback.

There are more than 10 environment variables for tuning this (`AZURE_TOKEN_CREDENTIALS`, `AZURE_MCP_ONLY_USE_BROKER_CREDENTIAL`, `AZURE_MCP_AUTHENTICATION_RECORD`, `@azure.argTenant`, …). The troubleshooting guide spends a large share of its length on authentication, tenant, and token-issuer problems.

---

## 2. Why it feels flaky: root-cause analysis

I couldn't reproduce the user's disconnects in this sandbox, because it has no Azure tenant or GUI client. Each cause below comes from reading the source, the official troubleshooting and known-issues docs, the changelog, or public issues. The confidence rating says how directly the evidence ties that cause to the symptom.

| # | Cause | Evidence | How it shows up | Confidence |
|---|---|---|---|---|
| F1 | **Auth can block a tool call for up to 5 minutes.** When the silent credentials fail (expired `az` token, wrong tenant, VS Code account not signed in), the chain falls through to an interactive browser/broker login with a 300 s timeout. In an agent session nobody may see the window, and the window may not even be able to open (Remote/SSH/WSL). | `CustomChainedCredential.cs`, `TimeoutTokenCredential.cs` | The tool call hangs, then the client times out, gives up on the server, or reports it as disconnected | High |
| F2 | **No global per-call deadline.** Individual tools can hang for as long as the backend does. | [#3732](https://github.com/microsoft/mcp/issues/3732) (best-practices hung for about 54 min), [#3229](https://github.com/microsoft/mcp/issues/3229) (EventHubs timeouts), [#3255](https://github.com/microsoft/mcp/issues/3255) (long-running operations need hand-rolled polling), [github/copilot-cli#4910](https://github.com/github/copilot-cli/issues/4910) | "Tool is still running…" forever, and the session gets wedged | High |
| F3 | **stdout pollution breaks the JSON-RPC stream.** In stdio mode, any stray byte on stdout is fatal. | [#2439](https://github.com/microsoft/mcp/issues/2439) ("invalid character 'X'… connection closed"), [#2983](https://github.com/microsoft/mcp/issues/2983) (illegal characters). The changelog for beta.46 says the npm wrapper wrote npm output to stdout | "Connection closed" or "not connected" right after a call | High |
| F4 | **Runtime platform-binary download.** `npx @azure/mcp@latest` resolves `@latest` on every launch, then installs `@azure/mcp-<os>-<arch>` on the fly. | Troubleshooting: "Failed to load platform specific package". [Azure/azure-mcp#270](https://github.com/Azure/azure-mcp/issues/270) ("server exited before responding to initialize"), [#306](https://github.com/Azure/azure-mcp/issues/306) (WSL timeout on initialize). [#3519](https://github.com/microsoft/mcp/issues/3519) (the wrapper wrote into the user's `package.json`) | The server fails to start or starts slowly, often behind proxies or on WSL | High |
| F5 | **Restarts during a session.** The VS Code extension fires `onDidChangeMcpServerDefinitions` on any `azureMcp.*` settings change *and on a telemetry setting change*. Twice-weekly auto-updates replace the server too. Tool names get breaking renames, e.g. `resilience_*` → `resiliency_*` in beta.46. | `vscode/src/extension.ts:124-148`, `CHANGELOG.md` | In-flight calls die. Copilot still holds stale tool names. The next call returns "not connected" | Medium–High |
| F6 | **Session-bound HTTP transport (spec ≤ 2025-11-25).** Streamable HTTP tied the client to an `Mcp-Session-Id`. If the server restarts or a load balancer switches instances, that session is gone. | The MCP `2026-07-28` changelog removes sessions for exactly this reason. Microsoft has only now closed "Stateless HTTP transport and routing" ([#2970](https://github.com/microsoft/mcp/issues/2970)) and "MCP Protocol and SDK upgrade" ([#2969](https://github.com/microsoft/mcp/issues/2969)) | Remote or HTTP setups report "session not found" or "not connected to this session" | Medium (matches the user's wording) |
| F7 | **Tool overload and bloated responses.** Namespace-mode help blobs of about 23 KB make the model spill output to files and spend 6–12 extra turns. That cost 2.9× the tokens in [#3183](https://github.com/microsoft/mcp/issues/3183). Consolidated mode's 161 tools exceed Copilot's 128-tool cap. | [#3183](https://github.com/microsoft/mcp/issues/3183), troubleshooting "128-Tool Limit" | Slow, confused agents. Errors like "You may not include more than 128 tools". Context fills up | High |
| F8 | **Multi-account and tenant confusion.** VS Code's account takes priority over the CLI's, and tokens can come from the wrong tenant. | Troubleshooting: "Primary Access Token Wrong Issuer", "Service Principal 403 for OneLake in VS Code" | 401/403 errors that look random | High |

**Summary:** "not connected to this session" is almost always what the client says *after* the server process or session has died or stalled. F1–F6 are the ways that happens. A server that never blocks on interactive auth, enforces deadlines, keeps stdout clean, ships as one pre-built binary, never restarts on its own, and speaks the stateless spec rules out most of them by construction.

---

## 3. What we can do much better

### 3.1 Reliability (the main reason this project exists)

| Principle | Concrete rule |
|---|---|
| **Auth never blocks a tool call** | Resolve credentials *at startup* in the background and cache them. Use only non-interactive credentials during tool calls. When there's no token, return an immediate, useful error such as `Not signed in. Run: az login --tenant <id>`, or offer an explicit `azure_login` tool that starts a device-code or browser flow and **returns immediately** with the code and URL. No hidden 5-minute waits. |
| **Hard deadline on every call** | Default 60 s, configurable per tool. Handle cancellation via `context.Context`. Long-running ARM operations return an operation handle, and an `azure_operation_status` tool polls it. |
| **stdout is protocol-only** | Logs go to stderr or a log file. In Go, `os.Stdout` is only ever handed to the MCP transport, and a CI test fails if anything else writes to it. |
| **One static binary, no runtime downloads** | No npm/pip/dotnet runtime. Startup should be a few milliseconds. |
| **No surprise restarts** | Version is pinned by the user. Update via `betterazuremcp update` or the package manager, never on its own mid-session. Tool names are a **stable public API** (semver). |
| **Stateless by design** | Target spec `2026-07-28` (stateless, `server/discover`) and keep fallback support for `2025-11-25` clients. No per-session server state. Anything stateful becomes an explicit handle passed back as an argument. |
| **Retries built in** | Automatic retry with jitter for ARM 429/5xx (the Azure SDK retry policy), and surface `Retry-After`. |
| **Self-diagnosis** | A `doctor` subcommand and an `azure_whoami` tool report the credential source, tenant, subscription, token expiry, and network reachability of `login.microsoftonline.com` and `management.azure.com`. |

### 3.2 Model ergonomics: few, powerful, well-described tools

Instead of 161–800 per-service wrappers, about 12 tools cover almost everything because they sit on top of Azure's own universal APIs:

| Tool (draft) | Backed by | What it replaces |
|---|---|---|
| `azure_whoami` | token claims + ARM | auth debugging, the tenant/subscription context |
| `azure_list_subscriptions` | ARM | subscription/RG listing tools |
| `azure_resource_graph_query` | **Azure Resource Graph (KQL)** | nearly every "list/get X" tool across all services, in one call and across subscriptions. Microsoft's server doesn't expose a general ARG query tool |
| `azure_get_resource` | ARM GET by resource ID (automatic `api-version` resolution) | per-service "get details" tools |
| `azure_arm_request` | ARM REST (GET/PUT/PATCH/POST/DELETE) with an automatic `api-version` | every management-plane operation. Writes are gated (see below) |
| `azure_operation_status` | ARM async-operation polling | hand-rolled LRO polling ([#3255](https://github.com/microsoft/mcp/issues/3255)) |
| `azure_monitor_logs_query` | Log Analytics / App Insights KQL | monitor, workbook, and app-insights query tools |
| `azure_monitor_metrics` | Azure Monitor metrics | metrics tools |
| `azure_activity_log` | Activity log | "what changed / who deleted it" |
| `azure_resource_health` | Resource Health | health tools |
| `azure_cost_query` | Cost Management | cost and pricing tools |
| `azure_cli` *(opt-in)* | runs `az` locally with a timeout | anything else, like data-plane or extensions |

Response rules:
- Compact JSON with `structuredContent` and an output schema.
- Paginated with continuation tokens.
- A default cap of about 8 KB per response, with a hint for narrowing the query.
- A short, human-readable summary line first.

Every tool description includes 1–2 concrete examples, such as a sample KQL query. Errors are **actionable**: which RBAC role is missing, which tenant was used, and the exact command that fixes it.

### 3.3 Safety

- **Read-only by default.** Writes need `--allow-writes` (or a config flag), *and* each destructive call (PUT/PATCH/DELETE/POST-action) asks for confirmation. On `2026-07-28` clients that uses MRTR/elicitation. On older clients it's a `confirm: true` argument plus a dry-run preview (ARM what-if where available).
- Secrets redaction: never return Key Vault secret values or connection strings unless the user explicitly enables it.
- Scope allow-lists: restrict to specific subscriptions or resource groups via config.

### 3.4 Zero-friction setup

- One-click install badges for VS Code (`vscode:mcp/install?{json}`) and VS Code Insiders, plus a listing in the GitHub MCP Registry.
- The config in every client is just `"command": "betterazuremcp", "args": ["serve"]`. No `npx`, `node`, `dotnet`, or `uv` needed.
- Install channels: GitHub Releases (all OS/arch), `winget`, Homebrew, `go install`. Optionally a thin npm package that bundles the right binary, so `npx` users are covered **without** runtime downloads.
- Auth is reused: if `az login` or `azd auth login` already works, the server just works.

---

## 4. Choosing the implementation language

### 4.1 Requirements

1. Starts instantly and survives for hours without leaks or hangs.
2. Easy distribution to Windows, macOS, and Linux (x64/arm64) without a runtime.
3. A first-class MCP SDK on the `2026-07-28` spec (Tier 1).
4. A mature Azure SDK: identity, ARM, Resource Graph, Monitor Query.
5. Clean cancellation and timeouts.
6. Easy for contributors.

### 4.2 Comparison

| | **Go** | TypeScript (Node) | C# (.NET 10 AOT) | Python | Rust |
|---|---|---|---|---|---|
| MCP SDK | Official, Tier 1, v1.7 supports `2026-07-28` | Official, Tier 1, the most mature | Official, Tier 1 (what Microsoft uses) | Official, Tier 1 | Official, **beta** support for `2026-07-28` |
| Azure SDK | GA: `azidentity`, `armresources`, `armresourcegraph`, `azquery`/`azmonitor`, ARM clients | GA and very complete (`@azure/identity`, `@azure/arm-*`) | GA and the most complete | GA | Beta / partial |
| Distribution | **One static binary**, trivial cross-compilation | Needs Node, or a heavy bundled SEA binary. `npx` is a source of flakiness | AOT single file, but Azure SDK trimming/AOT is fiddly and there are per-RID builds | Needs Python/uv | Single binary |
| Startup / memory | ~10–30 ms, ~20–40 MB | ~300 ms–1 s+ with `npx` resolution | Fast with AOT, slow on JIT | Slow (~1 s) | Fastest |
| Timeouts / cancellation | `context.Context` everywhere, idiomatic | AbortSignal, uneven support across libraries | CancellationToken, good | asyncio, OK | Good |
| stdout-safety risk | Low (explicit writers) | Medium (a stray `console.log` in any dependency) | Medium | Medium (`print`) | Low |
| Contributor friendliness | High | Highest | Medium | High | Lower |

### 4.3 Recommendation: **Go**

- It removes failure causes **F3–F5** by construction: one pre-built binary, no platform-package download, no `npx @latest`, and nothing writes to stdout except the transport.
- `context.WithTimeout` makes F2 (deadlines on every call) natural rather than something bolted on.
- The official Go MCP SDK (maintained with Google) is Tier 1 and already supports the stateless `2026-07-28` spec. That covers F6.
- The Azure SDK for Go has everything the ~12-tool design needs.
  - Known gap: `azidentity` has **no VS Code credential**. We'd rely on Azure CLI → azd → Azure PowerShell → env/managed identity, plus an explicit login tool with a persistent token cache (`azidentity/cache`).
  - That's arguably *better*, since F8 (the VS Code account overriding the CLI account) is a known source of confusion.
- **Runner-up: TypeScript.** It's the right choice if we want to ship primarily as a VS Code extension, or want to use `@azure/identity`'s VS Code credential. It costs us a Node runtime and the `npx` distribution failure modes.

---

## 5. Client compatibility targets

| Client | Transport | Notes |
|---|---|---|
| VS Code + GitHub Copilot | stdio | 128-tool limit per request, which we're far below. Supports elicitation (1.102+), install links, and the `@mcp` gallery |
| Visual Studio 2026 / 2022 17.14+ | stdio | `.mcp.json` |
| GitHub Copilot CLI | stdio | `/mcp add` |
| Claude Desktop / Claude Code | stdio | Can also ship as a `.mcpb` bundle |
| Cursor, Windsurf, JetBrains, Antigravity | stdio | Standard `mcp.json` |
| Microsoft 365 Copilot / Copilot Studio ("Copilot desktop") | **remote Streamable HTTP only** | Needs a hosted endpoint with Entra OAuth. Plan this as phase 2 (`serve --http`), stateless so it runs on Container Apps or Functions |

---

## 6. Open questions for you

1. **"Copilot Desktop":** do you mean GitHub Copilot in VS Code/Visual Studio, the Copilot CLI, or the Microsoft 365 Copilot app? The last one needs a hosted HTTP server with Entra auth, which is a bigger phase-2 item.
2. **Writes:** should v1 be read-only (inventory, logs, metrics, cost, health) and add gated writes in v2? Or do you need create/update/delete from day one?
3. **Data plane:** which data-plane scenarios matter most, e.g. Storage blobs, Key Vault, Cosmos queries, SQL? These don't fit the generic ARM tool and need dedicated tools.
4. **Accounts:** one tenant or several? Service principals or managed identity in CI?
5. **Go vs TypeScript:** are you OK with Go? It's the recommended choice, and contributors don't need Go installed to *use* the server.

## 7. Proposed next steps

1. Scaffold the Go module:
   - `cmd/betterazuremcp` with the `serve` and `doctor` subcommands
   - an `internal/auth` package with a non-blocking credential resolver
   - `internal/tools`
   - CI with a stdout-cleanliness test and a cross-compile matrix
2. Implement `azure_whoami`, `azure_list_subscriptions`, `azure_resource_graph_query`, and `azure_get_resource`, then test end to end in VS Code Copilot.
3. Add the Monitor logs, metrics, and activity-log tools, then `azure_arm_request` with write gating.
4. Package it: GitHub Releases, winget, Homebrew, and the VS Code install badge.
5. Phase 2: the stateless HTTP transport with Entra OAuth for M365 Copilot / Copilot Studio.

---

## Sources

- Microsoft Azure MCP source: [microsoft/mcp](https://github.com/microsoft/mcp) — `servers/Azure.Mcp.Server/{README,CHANGELOG,KNOWN-ISSUES,TROUBLESHOOTING}.md`, `core/Microsoft.Mcp.Core/src/Services/Azure/Authentication/*`, `servers/Azure.Mcp.Server/vscode/src/extension.ts`, `servers/Azure.Mcp.Server/src/Resources/consolidated-tools.json`
- [Troubleshooting guide](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/TROUBLESHOOTING.md)
- Issues: [#3732](https://github.com/microsoft/mcp/issues/3732), [#3229](https://github.com/microsoft/mcp/issues/3229), [#3255](https://github.com/microsoft/mcp/issues/3255), [#3183](https://github.com/microsoft/mcp/issues/3183), [#2439](https://github.com/microsoft/mcp/issues/2439), [#2983](https://github.com/microsoft/mcp/issues/2983), [#3519](https://github.com/microsoft/mcp/issues/3519), [#2969](https://github.com/microsoft/mcp/issues/2969), [#2970](https://github.com/microsoft/mcp/issues/2970), [Azure/azure-mcp#270](https://github.com/Azure/azure-mcp/issues/270), [Azure/azure-mcp#306](https://github.com/Azure/azure-mcp/issues/306), [github/copilot-cli#4910](https://github.com/github/copilot-cli/issues/4910)
- MCP spec `2026-07-28`: [release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)
- [MCP Go SDK releases](https://github.com/modelcontextprotocol/go-sdk/releases) (v1.7.0: support for `2026-07-28`)
- [Azure SDK for Go – azidentity](https://github.com/Azure/azure-sdk-for-go/blob/main/sdk/azidentity/README.md)
- [VS Code MCP servers docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers) (install links, gallery)
- [Visual Studio MCP docs](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers?view=visualstudio), [Copilot CLI MCP docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers), [MCP in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)

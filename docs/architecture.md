# Architecture

## A tool call, end to end

1. **Transport.** `main.ts` installs the stdout guard, then hands stdin and the real stdout to `serveStdio` from the MCP SDK. The SDK negotiates the protocol era per connection (2025-11-25 or 2026-07-28), so the server itself keeps no session state.
2. **Dispatch.** `server.ts` validates the input against the tool's `zod` schema and calls `runTool`, which:
   - combines the client's cancellation signal with a deadline (`BETTERAZUREMCP_TIMEOUT_SECONDS`);
   - races the tool against that signal, so a stuck dependency cannot hold the call open;
   - turns every failure into an error result with a plain-language fix (`azure/errors.ts`). Tool calls never throw into the SDK.
3. **Tool.** A tool in `tools/` builds a request with `ArmClient` or a helper such as `queryResourceGraph`.
4. **HTTP pipeline** (`http/pipeline.ts`), in order:
   1. egress policy: the host must be on the allowlist;
   2. read-only policy: `GET`/`HEAD`, or an allowlisted query `POST`;
   3. proxy (`HTTPS_PROXY`, `NO_PROXY`), decompression, fixed `User-Agent`;
   4. retry with exponential backoff for throttling and transient errors;
   5. bearer token for the host's scope, from `CredentialManager`.
5. **Result.** `format/result.ts` masks secrets, then renders a summary line and compact JSON. If the result is over the size budget, whole list items are dropped and a note says how many were left out.

## Credentials

`CredentialManager` walks a fixed, non-interactive chain (environment, Azure CLI, azd, Azure PowerShell), remembers the one that worked, caches tokens per scope until five minutes before expiry, and shares a single acquisition between concurrent calls. It starts in the background when the server starts, so the first tool call does not wait for it. If no credential works, the call fails at once with instructions. A later `az login` is picked up without restarting the server.

## Why a single bundle

`npm run build` produces one ESM file with every dependency inlined. Installing it pulls nothing else from the registry, there are no native modules or platform packages, and startup takes about a quarter of a second.

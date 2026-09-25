# Contributing

Thanks for helping. This project values stability and privacy over feature count, so please read the ground rules before starting on a change.

## Development setup

Requires Node.js 22 or later.

```sh
npm ci
npm run check     # typecheck, lint, format check and tests
npm run build     # bundles to dist/betterazuremcp.mjs
```

| Script              | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `npm run typecheck` | TypeScript, strict mode                                                   |
| `npm run lint`      | ESLint with type-aware rules                                              |
| `npm run format`    | Prettier, writes changes                                                  |
| `npm test`          | Unit tests and stdio integration tests (Vitest). Builds the bundle first. |
| `npm run build`     | Single-file ESM bundle with no runtime dependencies                       |

To try a local build in a client, point the client at `node /path/to/BetterAzureMCP/dist/betterazuremcp.mjs`, or run `npm link` once and use `betterazuremcp`.

## Project layout

```
src/
  main.ts              command line entry: serve (default), doctor, --version
  server.ts            MCP server, tool registration, deadlines and error handling
  services.ts          wires credentials, HTTP stack and Azure clients together
  config.ts            BETTERAZUREMCP_* environment variables
  auth/                non-interactive credential chain and token cache
  http/                egress allowlist, read-only policy, HTTP pipeline
  azure/               ARM client, Resource Graph, API version resolution, errors
  format/              secret masking and result rendering
  runtime/             stdout guard
  tools/               one file per MCP tool
test/
  unit/                fast tests with a fake HTTP client
  integration/         starts the built server over stdio, both protocol eras
docs/                  design notes and client setup
```

See [docs/architecture.md](docs/architecture.md) for how a tool call flows through the code.

## Ground rules

1. **Nothing writes to stdout except the MCP transport.** Use the logger (stderr). `no-console` is enforced by ESLint, and an integration test checks stdout.
2. **All Azure traffic goes through `ArmClient` and the HTTP stack.** Do not use `fetch` or other HTTP clients directly.
3. **Read-only, always.** A new `POST` endpoint may only be added to `READ_ONLY_POST_PATHS` if it cannot change state or return secrets.
4. **The host allowlist is a privacy promise.** Adding a host requires updating `SECURITY.md` and `test/unit/endpoints.test.ts` in the same pull request.
5. **Never block on user interaction.** No browser or device-code login inside a tool call.
6. **Tool names are a public API.** Renaming or removing a tool is a breaking change.
7. **Keep results small and actionable.** Start with a one-line summary. Return error messages that tell the user what to do.

## Adding a tool

1. Create `src/tools/<name>.ts` with `defineTool({...})`: a `zod` input schema with `.describe()` on every field, and a description that includes a concrete example.
2. Register it in `src/tools/index.ts`.
3. Add unit tests with `servicesWith(...)` from `test/helpers.ts`, covering the requests it makes and the summary it returns.
4. Update the tool table in `README.md` and the entry in `CHANGELOG.md`.

## Pull requests

- Keep changes focused. One feature or fix per pull request.
- `npm run check` must pass. CI runs it on Linux, macOS and Windows.
- Write commit messages in the imperative mood ("Add metrics tool"), with a body that explains why when it is not obvious.

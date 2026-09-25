# Contributing

Thanks for helping. This project values stability and privacy over feature count, so please read the ground rules before starting on a change.

## Development setup

Requires Node.js 22 or later.

```sh
npm ci
npm run check     # typecheck, lint, format check and tests
npm run build     # bundles to dist/betterazuremcp.mjs
```

| Script               | Purpose                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`  | TypeScript, strict mode                                                                                                                                          |
| `npm run lint`       | ESLint with type-aware rules                                                                                                                                     |
| `npm run format`     | Prettier, writes changes                                                                                                                                         |
| `npm test`           | Unit tests and stdio integration tests (Vitest). Builds the bundle first.                                                                                        |
| `npm run build`      | Single-file ESM bundle with no runtime dependencies                                                                                                              |
| `npm run soak`       | Soak test: thousands of calls against the built server with a capped heap; fails on memory growth                                                                |
| `npm run live-check` | Runs every tool against your own Azure tenant (after `az login`) and prints a pass/fail table                                                                    |
| `npm run eval:tools` | Tool-selection eval: asks Claude which tool it would call for each prompt in `eval/tool-selection.json`. Needs Anthropic API credentials and costs money per run |

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

## Tool-selection eval

`eval/tool-selection.json` holds realistic debugging prompts and the tool a model should call first. Two checks use it:

- `test/unit/toolSelection.test.ts` runs in CI for free. It checks that every tool is covered by at least two prompts, and that no two tool descriptions share too many distinctive words. Overlapping descriptions are the main cause of wrong tool choices.
- `npm run eval:tools` sends the tool definitions and prompts to the Claude API and reports how often the first tool call is right. It fails below 95%. Run it when you add a tool or change a description; it can also be started from the Actions tab (**Tool-selection eval**). It sends only the tool definitions and the synthetic prompts, never data from an Azure tenant.

## Adding a tool

1. Create `src/tools/<name>.ts` with `defineTool({...})`: a `zod` input schema with `.describe()` on every field, and a description that includes a concrete example.
2. Register it in `src/tools/index.ts`.
3. Add unit tests with `servicesWith(...)` from `test/helpers.ts`, covering the requests it makes and the summary it returns. Set `untrusted: true` on the result if it carries free text such as log lines or messages.
4. Add at least two prompts for it to `eval/tool-selection.json`, and run `npm run eval:tools`.
5. Update the tool table in `README.md` and the entry in `CHANGELOG.md`.

## Releasing

One-time setup: create an npm access token that can publish `betterazuremcp` (on npmjs.com: **Access Tokens** → **Generate New Token** → **Granular Access Token**, with read and write permission for packages). Add it as the `NPM_TOKEN` repository secret under **Settings** → **Secrets and variables** → **Actions**.

For each release:

1. Update `version` in `package.json` (and run `npm install --package-lock-only`), and move the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. Merge to `main`.
3. Tag the merge commit and push the tag: `git tag v1.2.3 && git push origin v1.2.3`.

The [release workflow](.github/workflows/release.yml) then:

- checks that the tag matches `package.json`, that `NPM_TOKEN` is set, and that the version is not already on npm;
- runs the full check;
- publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements);
- creates a GitHub release with the changelog entry and the bundle attached.

If a run fails, fix the cause and re-run it from the **Actions** tab, choosing the tag under **Use workflow from**.

## Pull requests

- Keep changes focused. One feature or fix per pull request.
- `npm run check` must pass. CI runs it on Linux, macOS and Windows.
- Write commit messages in the imperative mood ("Add metrics tool"), with a body that explains why when it is not obvious.

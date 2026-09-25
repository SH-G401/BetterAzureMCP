# Client setup

BetterAzureMCP runs as a local process that the client starts over stdio. In every client the entry is the command `betterazuremcp` with no arguments.

If a client reports that it cannot find the command, use the full path instead:

- macOS / Linux: `which betterazuremcp`
- Windows: `where betterazuremcp`. On Windows, some clients cannot start `.cmd` shims directly. Use `"command": "cmd"` with `"args": ["/c", "betterazuremcp"]`.

Environment variables from the [configuration table](../README.md#configuration) can be added to any entry with an `env` object.

## VS Code

Workspace: `.vscode/mcp.json`. User-wide: run **MCP: Open User Configuration**.

```json
{
  "servers": {
    "azure": {
      "type": "stdio",
      "command": "betterazuremcp",
      "env": { "BETTERAZUREMCP_TENANT_ID": "contoso.onmicrosoft.com" }
    }
  }
}
```

Use Copilot Chat in **Agent** mode. **MCP: List Servers** → `azure` shows the server's status and output.

## GitHub Copilot Desktop

**Settings** → **MCP Servers** → **Add custom server**:

| Field       | Value                                            |
| ----------- | ------------------------------------------------ |
| Name        | `azure`                                          |
| Transport   | `stdio`                                          |
| Command     | `betterazuremcp`                                 |
| Environment | optional, for example `BETTERAZUREMCP_TENANT_ID` |

## GitHub Copilot CLI

Run `/mcp add` inside `copilot` and enter the same values, or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "azure": {
      "type": "local",
      "command": "betterazuremcp",
      "args": [],
      "tools": ["*"]
    }
  }
}
```

## Visual Studio 2022 (17.14+) and 2026

Add `.mcp.json` to your solution directory:

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

## Claude Desktop

Edit `claude_desktop_config.json` (**Settings** → **Developer** → **Edit Config**):

```json
{
  "mcpServers": {
    "azure": {
      "command": "betterazuremcp"
    }
  }
}
```

## Cursor, Windsurf and others

Any client that supports stdio MCP servers works. Use the command `betterazuremcp` and follow the client's documentation for where the configuration file lives.

## Checking a client

Automated tests cover the MCP protocol itself, in both protocol revisions, on Linux, macOS and Windows. They cannot drive the clients' user interfaces, so each client needs a short manual check after setup or an update. It takes about five minutes:

1. **Tools appear.** The client lists 20 tools whose names start with `azure_`.
2. **Sign-in works.** Ask _"Which Azure account am I signed in with?"_. The assistant calls `azure_context` and shows your account, tenant and subscriptions.
3. **A missing login fails fast.** Run `az logout`, then ask the same question. Within a second, the answer should tell you to run `az login`, with no browser window and no hang.
4. **Login is picked up without a restart.** Run `az login`, then ask again without restarting the client. It works.
5. **Real debugging.** Ask _"Find my App Service apps and tell me whether Azure reports any of them as unhealthy."_ The assistant calls `azure_find_resources`, then `azure_resource_health`.
6. **Logs are visible.** Open the client's MCP output (in VS Code: **MCP: List Servers** → `azure` → **Show Output**). You should see `betterazuremcp <version> ready (read-only, stdio).`

| Client                      | Manually checked |
| --------------------------- | ---------------- |
| VS Code with GitHub Copilot | Not yet          |
| GitHub Copilot Desktop      | Not yet          |
| Visual Studio 2026          | Not yet          |
| GitHub Copilot CLI          | Not yet          |
| Claude Desktop              | Not yet          |

Please report the result of a check, including a failed one, in an issue so this table stays accurate.

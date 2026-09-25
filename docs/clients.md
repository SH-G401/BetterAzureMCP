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

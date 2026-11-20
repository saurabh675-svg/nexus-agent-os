# Connect Nexus to VS Code

Nexus includes a read-only MCP bridge in `scripts/mcp-server.mjs`. It exposes Nexus web search,
page reading, PC file search, workspace file reading, brain search, background job status, and file
preview. It intentionally does not expose shell execution, file writes, or browser clicks.

## Setup

1. Start Nexus and confirm `http://127.0.0.1:8787` opens.
2. In VS Code, run **MCP: Add Server** from the Command Palette and choose **Command (stdio)**.
3. Use `node` as the command and the absolute path to `scripts/mcp-server.mjs` as its argument.
4. Review the server tools and trust prompt before enabling them.

For a workspace configuration, create `.vscode/mcp.json` with the following shape and replace the
path with the folder where Nexus is installed:

```json
{
  "servers": {
    "nexus": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Nexus\\scripts\\mcp-server.mjs"
      ],
      "env": {
        "NEXUS_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

VS Code's MCP configuration is documented at
https://code.visualstudio.com/docs/agent-customization/mcp-servers.
MCP processes execute locally, so only configure servers you trust. Nexus must be running for its
bridge to answer requests.

## MCP servers inside Nexus

Nexus also has a local **MCP Servers** panel for optional stdio servers. It includes the official
[GitHub MCP server](https://github.com/github/github-mcp-server) using Docker and browser-based OAuth,
and [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp), configured to attach to
Nexus's running Chrome CDP endpoint so it can use the dedicated persistent browser profile. Launch
the Browser app first for that profile to be available. Neither integration requires copying source
code into Nexus; review permissions and approve tool calls in Nexus as usual.

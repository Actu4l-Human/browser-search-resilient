# Client configuration

The Compose stack publishes Streamable HTTP MCP at `http://127.0.0.1:8088/mcp`.

## Kilo

```jsonc
{
  "mcp": {
    "resilient-browser-search": {
      "type": "remote",
      "url": "http://127.0.0.1:8088/mcp",
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

When `BROWSER_SEARCH_API_KEY` is configured, add the corresponding authorization header using the secret/header mechanism supported by the installed Kilo release.

## OpenCode

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "resilient-browser-search": {
      "type": "remote",
      "url": "http://127.0.0.1:8088/mcp",
      "enabled": true
    }
  }
}
```

## Pydantic Deep

```python
from pydantic_deep import MCPServerConfig, build_mcp_server, create_deep_agent

web = build_mcp_server(
    MCPServerConfig(
        name="resilient-browser-search",
        transport="http",
        url="http://127.0.0.1:8088/mcp",
    )
)

agent = create_deep_agent(mcp_servers=[web], web_search=False)
```

Disable the framework's separate built-in search tool so the model does not bypass the deterministic fallback and audit trail.

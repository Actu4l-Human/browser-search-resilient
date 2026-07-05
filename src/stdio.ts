import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './mcp.js';

const handle = serveStdio(() => createServer());
console.error('resilient-browser-search MCP server listening on stdio');
process.on('SIGINT', () => void handle.close());
process.on('SIGTERM', () => void handle.close());

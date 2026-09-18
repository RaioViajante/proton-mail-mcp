#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch(() => {
  // stdout is reserved for the MCP protocol stream; all diagnostics go to stderr.
  console.error('Fatal error starting proton-mail-mcp.');
  process.exitCode = 1;
});

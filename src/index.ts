#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch((error: unknown) => {
  // stdout is reserved for the MCP protocol stream; all diagnostics go to stderr.
  console.error(
    'Fatal error starting proton-mail-mcp:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerGetMessageTool } from './tools/get-message.js';
import { registerListFoldersTool } from './tools/list-folders.js';
import { registerListMessagesTool } from './tools/list-messages.js';
import { registerSearchMailTool } from './tools/search-mail.js';

const SERVER_NAME = 'proton-mail-mcp';
const SERVER_VERSION = '0.1.0';

/**
 * Builds the MCP server and registers every V1 tool. V1 is strictly
 * read-only: only these four tools exist, and none of them can mutate a
 * mailbox (no mark-as-read, move, delete, send, or SMTP). Do not add a
 * mutating tool here without updating README.md's "V1 read-only
 * limitations" and SECURITY.md.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  registerListFoldersTool(server);
  registerListMessagesTool(server);
  registerSearchMailTool(server);
  registerGetMessageTool(server);

  return server;
}

/** Starts the server over stdio, the only transport V1 supports. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

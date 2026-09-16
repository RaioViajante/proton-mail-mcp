import type { McpServer } from '@modelcontextprotocol/server';
import { withBridgeConnection } from '../bridge/client.js';
import { listFolders } from '../mail/folders.js';

export function registerListFoldersTool(server: McpServer): void {
  server.registerTool(
    'mail_list_folders',
    {
      title: 'List mail folders',
      description: 'Lists the folders/mailboxes available in the Proton Mail account. Read-only.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const folders = await withBridgeConnection((client) => listFolders(client));
      return {
        content: [{ type: 'text', text: JSON.stringify({ folders }, null, 2) }],
      };
    },
  );
}

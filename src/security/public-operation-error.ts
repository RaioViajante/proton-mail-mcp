import { PublicMcpError } from './mcp-tool-error.js';

/**
 * Classifies errors thrown by Bridge callbacks into fixed public categories.
 * The shared MCP tool boundary still handles anything this classifier misses.
 */
export function publicOperationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (/confirm=|acknowledge|confirmationPhrase|dryRun/i.test(message)) {
    return new PublicMcpError('Operation requires explicit confirmation.');
  }
  if (/no such|not found|does not exist|could not find/i.test(message)) {
    return new PublicMcpError('Source or destination unavailable.');
  }
  if (
    /not permitted|cannot|must |only operates|reserved|label mailbox|namespace|already/i.test(
      message,
    )
  ) {
    return new PublicMcpError('Operation rejected by mailbox policy.');
  }
  return new PublicMcpError('Mailbox operation failed.');
}

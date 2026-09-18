/**
 * Last-resort MCP boundary for errors thrown by Bridge callbacks. Only fixed
 * categories leave this function; no library or server error text is copied.
 */
export function publicOperationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (/confirm=|acknowledge|confirmationPhrase|dryRun/i.test(message)) {
    return new Error('Operation requires explicit confirmation.');
  }
  if (/no such|not found|does not exist|could not find/i.test(message)) {
    return new Error('Source or destination unavailable.');
  }
  if (
    /not permitted|cannot|must |only operates|reserved|label mailbox|namespace|already/i.test(
      message,
    )
  ) {
    return new Error('Operation rejected by mailbox policy.');
  }
  return new Error('Mailbox operation failed.');
}

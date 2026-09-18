/** Fixed MCP-facing categories for failures originating in IMAP or other libraries. */
export type MutationFailureCategory =
  'mailboxOperationFailed' | 'flagRepairFailed' | 'labelRepairFailed' | 'postMoveRepairFailed';

const MESSAGES: Record<MutationFailureCategory, string> = {
  mailboxOperationFailed: 'Mailbox operation failed.',
  flagRepairFailed: 'Flag repair failed.',
  labelRepairFailed: 'Label repair failed.',
  postMoveRepairFailed: 'Post-move verification or repair failed; refresh mailbox state.',
};

/** Never inspect or include the caught exception: protocol responses can contain private mail data. */
export function mutationFailureMessage(category: MutationFailureCategory): string {
  return MESSAGES[category];
}

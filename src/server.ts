import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerApplyLabelTool } from './tools/apply-label.js';
import { registerArchiveTool } from './tools/archive.js';
import { registerCreateFolderTool } from './tools/create-folder.js';
import { registerCreateLabelTool } from './tools/create-label.js';
import { registerDeletePermanentlyTool } from './tools/delete-permanently.js';
import { registerGetMessageTool } from './tools/get-message.js';
import { registerListFoldersTool } from './tools/list-folders.js';
import { registerListMessagesTool } from './tools/list-messages.js';
import { registerMarkReadTool } from './tools/mark-read.js';
import { registerMarkSpamTool } from './tools/mark-spam.js';
import { registerMarkUnreadTool } from './tools/mark-unread.js';
import { registerMoveTool } from './tools/move.js';
import { registerRemoveLabelTool } from './tools/remove-label.js';
import { registerRestoreFromTrashTool } from './tools/restore-from-trash.js';
import { registerSearchMailTool } from './tools/search-mail.js';
import { registerSendPreviewTool } from './tools/send-preview.js';
import { registerSendTool } from './tools/send.js';
import { registerTrashTool } from './tools/trash.js';
import { registerTriageIntelligenceTools } from './tools/triage-intelligence.js';
import { registerUnsubscribePreviewTool } from './tools/unsubscribe-preview.js';
import { registerUnsubscribeTool } from './tools/unsubscribe.js';

const SERVER_NAME = 'proton-mail-mcp';
const SERVER_VERSION = '0.5.0';

/**
 * Builds the MCP server and registers every tool.
 *
 * V1 (read-only, readOnlyHint: true): mail_list_folders, mail_list_messages,
 * mail_search, mail_get_message. None of these can mutate a mailbox.
 *
 * V2 (mutation, readOnlyHint: false): mail_mark_read,
 * mail_mark_unread, mail_archive, mail_move, mail_mark_spam,
 * mail_apply_label, mail_remove_label, mail_create_folder, mail_create_label. Message mutations
 * use explicit caller-supplied UIDs (max 25 per call — see mutations/batch.ts);
 * folder/label creation uses an explicit name. All default to dryRun: true and never delete,
 * expunges, sends, or touches SMTP. mail_mark_spam alone has destructiveHint:
 * true because Proton may persistently filter future messages from its sender.
 * V2.5 adds five read-only metadata analysis tools; none calls a mutation.
 * V3 (0.3.0, "Controlled Unsubscribe") adds mail_unsubscribe_preview
 * (readOnlyHint: true, zero network requests) and mail_unsubscribe
 * (readOnlyHint: false), which executes ONLY the RFC 8058 HTTPS one-click
 * mechanism for one explicit UID at a time — never mailto, never a body
 * link, never browser automation. See src/unsubscribe/ and SECURITY.md
 * ("External HTTP side effect").
 * V4 (0.4.0, "Safe Trash Lifecycle") adds mail_trash (readOnlyHint: false,
 * destructiveHint: true — recoverable but a real mailbox-state change with
 * an observed label-loss side effect), mail_restore_from_trash
 * (readOnlyHint: false, destructiveHint: false), and mail_delete_permanently
 * (readOnlyHint: false, destructiveHint: true). mail_delete_permanently is
 * implemented and fully unit-tested — dry-run, batch limits, the
 * confirm/acknowledge/confirmationPhrase gate — but live execution
 * (dryRun: false) is unconditionally refused by a hard feature gate
 * (blocked: true, blockReason: "livePermanentDeleteDisabled") before any
 * IMAP mutating command runs; see src/mutations/permanent-delete.ts and
 * SECURITY.md ("Permanent delete is feature-gated off"). This gate is
 * unchanged as of 0.4.2 — see below.
 * 0.4.1 ("State-Preserving Restore") hardened mail_restore_from_trash to
 * snapshot and repair flags/labels around a live move, using Trash's own
 * state as the "before" baseline.
 * 0.4.2 ("Durable Restore Snapshot") found that baseline insufficient: a
 * live finding showed Proton Bridge can drop a message's labels
 * *asynchronously*, after mail_trash's own immediate post-move check
 * already reported them intact — so by the time a later
 * mail_restore_from_trash call measured Trash, the labels were already
 * gone. mail_trash now optionally issues a signed `restoreReceipts` entry
 * per identity-confirmed live-moved UID (see
 * src/security/restore-receipt.ts), captured BEFORE the move; passing it
 * back via mail_restore_from_trash's `restoreReceipts` input makes that
 * pre-Trash snapshot the authoritative baseline instead
 * (`preservationSource: "restoreReceipt"`), immune to Trash's later decay.
 * A UID with no receipt keeps the 0.4.1 `trashSnapshot` fallback; a UID
 * whose supplied receipt fails verification fails closed
 * (`preservationSource: "unavailable"` — see `receiptRejections`), never
 * silently downgrading. This is fully additive: an install with no
 * receipt-signing secret provisioned (scripts/configure-receipt-signing.sh)
 * behaves exactly as 0.4.1 did. See SECURITY.md ("Restore receipts").
 * V5 (0.5.0, "SMTP Send Foundation") adds mail_send_preview (readOnlyHint:
 * true, zero SMTP connections) and mail_send (readOnlyHint: false,
 * destructiveHint: false), the first SMTP capability this project has ever
 * had — see src/smtp/ and SECURITY.md ("No SMTP, ever" is retired; see "SMTP
 * host is loopback-only" instead). Scope is deliberately minimal: plain-text
 * only (no HTML/attachments/inline images/raw MIME/custom headers), no
 * reply/forward (0.5.1), no Bcc, From locked to the configured Bridge
 * account identity, recipients capped at 5 total. The SMTP host is
 * validated loopback-only (127.0.0.0/8, ::1, or "localhost" re-resolved and
 * re-checked) — this project is a Bridge-only SMTP client, never a
 * general-purpose one. mail_send_preview issues a signed sendIntentReceipt
 * (src/security/send-intent-receipt.ts) binding the exact validated intent;
 * live mail_send requires dryRun=false, confirm=true,
 * acknowledgeExternalSend=true, AND that receipt matching the payload
 * exactly — but even fully confirmed, live submission is unconditionally
 * refused by a hard feature gate (blocked: true, blockReason:
 * "liveSendDisabled") before any SMTP connection is attempted, mirroring
 * mail_delete_permanently's gate. See src/smtp/send.ts and SECURITY.md
 * ("Live SMTP submission is feature-gated off").
 * Do not add a tool here without updating README.md's "V2 mutation limitations"
 * and SECURITY.md.
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

  registerMarkReadTool(server);
  registerMarkUnreadTool(server);
  registerArchiveTool(server);
  registerMoveTool(server);
  registerMarkSpamTool(server);
  registerApplyLabelTool(server);
  registerRemoveLabelTool(server);
  registerCreateFolderTool(server);
  registerCreateLabelTool(server);

  registerTriageIntelligenceTools(server);

  registerUnsubscribePreviewTool(server);
  registerUnsubscribeTool(server);

  registerTrashTool(server);
  registerRestoreFromTrashTool(server);
  registerDeletePermanentlyTool(server);

  registerSendPreviewTool(server);
  registerSendTool(server);

  return server;
}

/** Starts the server over stdio, the only transport this project supports. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

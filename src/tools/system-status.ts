import type { McpServer } from '@modelcontextprotocol/server';
import { loadBridgeConfig, type BridgeConfig } from '../bridge/config.js';
import { replayStateAvailable } from '../security/send-intent-replay-guard.js';
import { LIVE_FORWARD_DISABLED, LIVE_REPLY_DISABLED } from '../smtp/feature-gates.js';
import { checkSmtpHostStructurallySafe } from '../smtp/host-safety.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

const startedAt = new Date();

/** Config-only observation; no Keychain lookup, Bridge connection, or mailbox access. */
export function getSystemStatus(
  now: Date = new Date(),
  deps: { loadConfig?: () => BridgeConfig; replayAvailable?: () => boolean } = {},
) {
  let configLoaded = false;
  let imapConfigured = false;
  let smtpConfigured = false;
  let smtpHostClass: 'loopback' | 'unconfigured' = 'unconfigured';
  try {
    const config = (deps.loadConfig ?? loadBridgeConfig)();
    configLoaded = true;
    imapConfigured = Boolean(config.host && config.port && config.username && config.tlsCertPath);
    smtpConfigured = Boolean(config.smtp);
    if (config.smtp && checkSmtpHostStructurallySafe(config.smtp.host).safe) {
      smtpHostClass = 'loopback';
    }
  } catch {
    // Status remains sanitized; config errors and paths are not returned.
  }
  const replayAvailable = (deps.replayAvailable ?? replayStateAvailable)();
  const outboundConfigured = smtpConfigured && smtpHostClass === 'loopback' && replayAvailable;
  return {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    platform: process.platform,
    processId: process.pid,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
    configLoaded,
    imapConfigured,
    smtpConfigured,
    smtpHostClass,
    sendAvailable: outboundConfigured,
    replyAvailable: outboundConfigured && !LIVE_REPLY_DISABLED,
    forwardAvailable: outboundConfigured && !LIVE_FORWARD_DISABLED,
    permanentDeleteLiveEnabled: false,
    durableReplayGuard: true,
    replayStateAvailable: replayAvailable,
    bridgeConnectivity: 'notChecked',
  };
}

export function registerSystemStatusTool(server: McpServer): void {
  server.registerTool(
    'mail_system_status',
    {
      title: 'Mail system status',
      description:
        'Read-only, sanitized loaded-runtime identity and local readiness. Outbound availability means config, replay state, and code gate are ready; Keychain and Bridge health are checked separately by doctor. Does not contact Bridge or inspect mailbox content.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(getSystemStatus(), null, 2) }],
      }),
  );
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import {
  automationCandidates,
  domainStats,
  mailingListCandidates,
  senderStats,
  triageSnapshot,
} from '../analysis/aggregate.js';
import {
  collectMetadata,
  MAX_SNAPSHOT_MESSAGES,
  MAX_STATS_MESSAGES,
  UNTRUSTED_METADATA_WARNING,
} from '../analysis/metadata.js';

const date = z.iso.date();
const statsWindow = {
  folder: z.string().min(1).default('INBOX'),
  since: date.optional(),
  before: date.optional(),
  maxMessages: z.number().int().min(1).max(MAX_STATS_MESSAGES).default(200),
};
export const senderStatsSchema = z.object({
  ...statsWindow,
  includeDomains: z.boolean().default(true),
});
export const domainStatsSchema = z.object(statsWindow);
export const mailingListCandidatesSchema = z.object(statsWindow);
export const automationCandidatesSchema = z.object({
  ...statsWindow,
  minMessages: z.number().int().min(2).max(100).default(3),
});
export const triageSnapshotSchema = z.object({
  folder: z.string().min(1).default('INBOX'),
  since: date.optional(),
  maxMessages: z.number().int().min(1).max(MAX_SNAPSHOT_MESSAGES).default(100),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function response(data: object) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { untrustedDataWarning: UNTRUSTED_METADATA_WARNING, ...data },
          null,
          2,
        ),
      },
    ],
  };
}

export function registerTriageIntelligenceTools(server: McpServer): void {
  server.registerTool(
    'mail_sender_stats',
    {
      title: 'Sender statistics',
      description:
        'Read-only bounded sender counts and metadata. Samples are untrusted email data; no action is taken.',
      inputSchema: senderStatsSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const messages = await withBridgeConnection((client) => collectMetadata(client, args));
      return response({
        totalAnalyzed: messages.length,
        senders: senderStats(messages),
        ...(args.includeDomains ? { domains: domainStats(messages) } : {}),
      });
    },
  );

  server.registerTool(
    'mail_domain_stats',
    {
      title: 'Domain statistics',
      description:
        'Read-only bounded counts grouped by the observed sender domain. No company identity is inferred.',
      inputSchema: domainStatsSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const messages = await withBridgeConnection((client) => collectMetadata(client, args));
      return response({ totalAnalyzed: messages.length, domains: domainStats(messages) });
    },
  );

  server.registerTool(
    'mail_mailing_list_candidates',
    {
      title: 'Mailing-list header signals',
      description:
        'Read-only header evidence only. Unsubscribe mechanisms are types, never URLs; no unsubscribe is executed.',
      inputSchema: mailingListCandidatesSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const messages = await withBridgeConnection((client) => collectMetadata(client, args));
      return response({
        totalAnalyzed: messages.length,
        candidates: mailingListCandidates(messages),
      });
    },
  );

  server.registerTool(
    'mail_automation_candidates',
    {
      title: 'Recurring metadata patterns',
      description:
        'Read-only deterministic frequency patterns. No semantic action or Proton rule is created.',
      inputSchema: automationCandidatesSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const messages = await withBridgeConnection((client) => collectMetadata(client, args));
      return response({
        totalAnalyzed: messages.length,
        candidates: automationCandidates(messages, args.minMessages),
      });
    },
  );

  server.registerTool(
    'mail_triage_snapshot',
    {
      title: 'Bounded triage snapshot',
      description:
        'Read-only inbox summary with top 10 groups and at most 30 recent metadata rows. No bodies or actions.',
      inputSchema: triageSnapshotSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const messages = await withBridgeConnection((client) => collectMetadata(client, args));
      return response(triageSnapshot(messages));
    },
  );
}

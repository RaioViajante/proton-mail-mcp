import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { getSystemStatus, registerSystemStatusTool } from '../src/tools/system-status.js';

describe('mail_system_status', () => {
  it('reports the loaded 0.6.0 capability gates with no mailbox access or secrets', () => {
    const status = getSystemStatus(new Date(), {
      loadConfig: () => ({
        host: '127.0.0.1',
        port: 1143,
        username: 'private@example.test',
        tlsCertPath: '/private/cert.pem',
        secure: false,
        smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
      }),
      replayAvailable: () => true,
    });
    expect(status.serverVersion).toBe('0.6.0');
    expect(status.platform).toBe(process.platform);
    expect(status.processId).toBe(process.pid);
    expect(status.startedAt).toMatch(/^\d{4}-/);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.sendAvailable).toBe(true);
    expect(status.replyAvailable).toBe(true);
    expect(status.forwardAvailable).toBe(true);
    expect(status.permanentDeleteLiveEnabled).toBe(false);
    expect(status.durableReplayGuard).toBe(true);
    expect(status.replayStateAvailable).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/private@example|private\/cert|password|secret/i);
  });

  it('does not report outbound availability when config or replay state is unavailable', () => {
    const status = getSystemStatus(new Date(), {
      loadConfig: () => {
        throw new Error('private config path');
      },
      replayAvailable: () => false,
    });
    expect(status.configLoaded).toBe(false);
    expect(status.sendAvailable).toBe(false);
    expect(status.replyAvailable).toBe(false);
    expect(status.forwardAvailable).toBe(false);
    expect(JSON.stringify(status)).not.toContain('private config path');
  });

  it('registers a read-only tool and returns sanitized status', async () => {
    let handler: (() => Promise<{ content: { text: string }[] }>) | undefined;
    let annotations: Record<string, unknown> | undefined;
    const server = {
      registerTool: vi.fn(
        (
          _name: string,
          config: { annotations?: Record<string, unknown> },
          fn: () => Promise<{ content: { text: string }[] }>,
        ) => {
          annotations = config.annotations;
          handler = fn;
        },
      ),
    };
    registerSystemStatusTool(server as unknown as McpServer);
    expect(server.registerTool.mock.calls[0]?.[0]).toBe('mail_system_status');
    expect(annotations?.readOnlyHint).toBe(true);
    expect(annotations?.destructiveHint).toBe(false);
    const result = await handler!();
    const parsed = JSON.parse(result.content[0]!.text) as { serverVersion: string };
    expect(parsed.serverVersion).toBe('0.6.0');
  });
});

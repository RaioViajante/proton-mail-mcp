import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForwardSourceContent, ReplySourceHeaders } from '../src/mail/source-message.js';
import { previewForward } from '../src/smtp/forward-preview.js';
import { sendForward } from '../src/smtp/forward-send.js';
import { previewReply } from '../src/smtp/reply-preview.js';
import { sendReply } from '../src/smtp/reply-send.js';
import { previewSend } from '../src/smtp/preview.js';
import { sendMail } from '../src/smtp/send.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');
const config = {
  host: '127.0.0.1',
  port: 1025,
  security: 'starttls' as const,
  username: 'user@proton.me',
  tlsCertPath: '/nonexistent/test-cert.pem',
};
const replySource: ReplySourceHeaders = {
  folder: 'INBOX',
  uid: 1,
  uidValidity: '111',
  from: 'sender@example.test',
  messageId: '<fake@example.test>',
  subject: 'Hello',
  date: '2026-01-01T00:00:00.000Z',
  replyTo: { headerPresent: false, malformed: false, addresses: [] },
  references: { headerPresent: false, malformed: false, raw: null },
};
const forwardSource: ForwardSourceContent = {
  folder: 'INBOX',
  uid: 2,
  uidValidity: '111',
  from: 'sender@example.test',
  to: ['user@proton.me'],
  messageId: '<fake@example.test>',
  subject: 'Hello',
  date: '2026-01-01T00:00:00.000Z',
  hasAttachments: false,
  sourceContentComplete: true,
  plainText: 'Fake test content.',
};

describe('outbound receipt persistence across independent processes', () => {
  let root: string;
  beforeAll(() => {
    execFileSync('pnpm', ['build'], { stdio: 'ignore' });
    root = mkdtempSync(join(tmpdir(), 'mcp-outbound-replay-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each(['send', 'reply', 'forward'] as const)(
    '%s: process B rejects the receipt consumed by process A before credential/SMTP',
    (kind) => {
      const stateDir = join(root, kind, 'replay');
      mkdirSync(join(root, kind), { mode: 0o700 });
      const receipt =
        kind === 'send'
          ? previewSend(
              { to: ['recipient@example.test'], subject: 'Hello', text: 'Fake text' },
              config,
              SECRET,
            ).sendIntentReceipt
          : kind === 'reply'
            ? previewReply(replySource, { text: 'Fake reply' }, config.username, SECRET)
                .replyIntentReceipt
            : previewForward(
                forwardSource,
                { to: ['recipient@example.test'], text: 'Fake intro' },
                config.username,
                SECRET,
              ).forwardIntentReceipt;
      expect(receipt).toBeDefined();
      const fixture = join(root, kind, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({ config, replySource, forwardSource, receipt }), {
        mode: 0o600,
      });
      const dist = (name: string) => pathToFileURL(join(process.cwd(), 'dist/smtp', name)).href;
      const code = `
        import { readFileSync } from 'node:fs';
        import { sendMail } from ${JSON.stringify(dist('send.js'))};
        import { sendReply } from ${JSON.stringify(dist('reply-send.js'))};
        import { sendForward } from ${JSON.stringify(dist('forward-send.js'))};
        const f=JSON.parse(readFileSync(process.argv[1],'utf8'));
        const kind=process.argv[3];
        const deps={replayStateDir:process.argv[2],getPassword:()=>Promise.reject(new Error('fake credential failure'))};
        const secret=Buffer.from('c'.repeat(64),'hex');
        let result;
        if(kind==='send') result=await sendMail({to:['recipient@example.test'],subject:'Hello',text:'Fake text',
          sendIntentReceipt:f.receipt,dryRun:false,confirm:true,acknowledgeExternalSend:true},f.config,secret,deps);
        if(kind==='reply') result=await sendReply(f.replySource,{sourceFolder:'INBOX',uid:1,text:'Fake reply',
          replyIntentReceipt:f.receipt,dryRun:false,confirm:true,acknowledgeExternalReply:true},f.config,secret,deps);
        if(kind==='forward') result=await sendForward(f.forwardSource,{sourceFolder:'INBOX',uid:2,to:['recipient@example.test'],
          text:'Fake intro',forwardIntentReceipt:f.receipt,dryRun:false,confirm:true,
          acknowledgeExternalForward:true,acknowledgeAttachmentsWillBeOmitted:false},f.config,secret,deps);
        process.stdout.write(JSON.stringify({replayRejected:result.reasons.some(x=>x.includes('already been used')),
          submissionAttempted:result.submissionAttempted,outcome:result.outcome}));`;
      const run = () => {
        const child = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', code, fixture, stateDir, kind],
          {
            encoding: 'utf8',
            timeout: 10000,
          },
        );
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout) as {
          replayRejected: boolean;
          submissionAttempted: boolean;
          outcome: string;
        };
      };
      const first = run();
      const second = run();
      expect(first.replayRejected).toBe(false);
      expect(first.outcome).toBe('failed');
      expect(first.submissionAttempted).toBe(false);
      expect(second.replayRejected).toBe(true);
      expect(second.submissionAttempted).toBe(false);
      expect(readdirSync(stateDir)).toHaveLength(1);
    },
  );

  it.each(['send', 'reply', 'forward'] as const)(
    '%s: dry-run, invalid receipt, and missing consent create no marker',
    async (kind) => {
      const stateDir = join(root, `no-marker-${kind}`, 'replay');
      mkdirSync(join(root, `no-marker-${kind}`), { mode: 0o700 });
      const deps = {
        replayStateDir: stateDir,
        getPassword: () => Promise.reject(new Error('fake credential failure')),
      };
      if (kind === 'send') {
        const receipt = previewSend(
          { to: ['recipient@example.test'], subject: 'Hello', text: 'Fake text' },
          config,
          SECRET,
        ).sendIntentReceipt;
        const base = { to: ['recipient@example.test'], subject: 'Hello', text: 'Fake text' };
        const dry = await sendMail(
          {
            ...base,
            sendIntentReceipt: receipt,
            dryRun: true,
            confirm: false,
            acknowledgeExternalSend: false,
          },
          config,
          SECRET,
          deps,
        );
        expect(dry.receiptValid).toBe(true);
        await sendMail(
          {
            ...base,
            sendIntentReceipt: {},
            dryRun: false,
            confirm: true,
            acknowledgeExternalSend: true,
          },
          config,
          SECRET,
          deps,
        );
        await expect(
          sendMail(
            {
              ...base,
              sendIntentReceipt: receipt,
              dryRun: false,
              confirm: false,
              acknowledgeExternalSend: true,
            },
            config,
            SECRET,
            deps,
          ),
        ).rejects.toThrow();
      } else if (kind === 'reply') {
        const receipt = previewReply(
          replySource,
          { text: 'Fake reply' },
          config.username,
          SECRET,
        ).replyIntentReceipt;
        const base = { sourceFolder: 'INBOX', uid: 1, text: 'Fake reply' };
        const dry = await sendReply(
          replySource,
          {
            ...base,
            replyIntentReceipt: receipt,
            dryRun: true,
            confirm: false,
            acknowledgeExternalReply: false,
          },
          config,
          SECRET,
          deps,
        );
        expect(dry.receiptValid).toBe(true);
        await sendReply(
          replySource,
          {
            ...base,
            replyIntentReceipt: {},
            dryRun: false,
            confirm: true,
            acknowledgeExternalReply: true,
          },
          config,
          SECRET,
          deps,
        );
        await expect(
          sendReply(
            replySource,
            {
              ...base,
              replyIntentReceipt: receipt,
              dryRun: false,
              confirm: false,
              acknowledgeExternalReply: true,
            },
            config,
            SECRET,
            deps,
          ),
        ).rejects.toThrow();
      } else {
        const receipt = previewForward(
          forwardSource,
          { to: ['recipient@example.test'], text: 'Fake intro' },
          config.username,
          SECRET,
        ).forwardIntentReceipt;
        const base = {
          sourceFolder: 'INBOX',
          uid: 2,
          to: ['recipient@example.test'],
          text: 'Fake intro',
        };
        const dry = await sendForward(
          forwardSource,
          {
            ...base,
            forwardIntentReceipt: receipt,
            dryRun: true,
            confirm: false,
            acknowledgeExternalForward: false,
            acknowledgeAttachmentsWillBeOmitted: false,
          },
          config,
          SECRET,
          deps,
        );
        expect(dry.receiptValid).toBe(true);
        await sendForward(
          forwardSource,
          {
            ...base,
            forwardIntentReceipt: {},
            dryRun: false,
            confirm: true,
            acknowledgeExternalForward: true,
            acknowledgeAttachmentsWillBeOmitted: false,
          },
          config,
          SECRET,
          deps,
        );
        await expect(
          sendForward(
            forwardSource,
            {
              ...base,
              forwardIntentReceipt: receipt,
              dryRun: false,
              confirm: false,
              acknowledgeExternalForward: true,
              acknowledgeAttachmentsWillBeOmitted: false,
            },
            config,
            SECRET,
            deps,
          ),
        ).rejects.toThrow();
      }
      expect(existsSync(stateDir)).toBe(false);
    },
  );
});

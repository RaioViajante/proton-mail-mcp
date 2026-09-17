import { z } from 'zod';
import { checkSmtpHostStructurallySafe } from './host-safety.js';

/**
 * Non-secret SMTP connection settings (0.5.0). Deliberately its own schema,
 * imported into `BridgeConfigSchema` (`src/bridge/config.ts`) as an optional
 * `smtp` field rather than merged in inline — this project's IMAP config has
 * existed since 0.1.0 and every install's `config.json` on disk predates
 * this field, so it MUST stay optional for `loadBridgeConfig` to remain
 * backward compatible with a pre-0.5.0 file. Bridge's own SMTP and IMAP
 * servers share one account/credential; only the port and connection mode
 * differ, which is why this schema does not repeat `host`/`username` —
 * `resolveSmtpConfig` below combines this with the existing `BridgeConfig`
 * fields.
 */
export const SmtpSecuritySchema = z.enum(['starttls', 'tls']);
export type SmtpSecurity = z.infer<typeof SmtpSecuritySchema>;

/** Proton Mail Bridge's own documented SMTP default (STARTTLS on 1025) — mirrors `DEFAULT_PORT` conventions already used for IMAP in `scripts/configure-bridge.sh`. */
export const DEFAULT_SMTP_PORT = 1025;
export const DEFAULT_SMTP_SECURITY: SmtpSecurity = 'starttls';

export const SmtpConfigSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .default('127.0.0.1')
      .refine((host) => checkSmtpHostStructurallySafe(host).safe, {
        message:
          'SMTP host must be a loopback address (127.0.0.0/8, ::1) or "localhost" — see ' +
          'SECURITY.md ("SMTP host is loopback-only").',
      }),
    port: z.number().int().positive(),
    // No silent downgrade: there is no "plaintext" member of this enum at
    // all, so a config that omits security (or sets an unrecognized value)
    // fails validation rather than falling back to an insecure default.
    security: SmtpSecuritySchema,
  })
  .strict();

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

/** Fully resolved SMTP connection parameters — the union of the `smtp` sub-config and the fields it shares with the existing Bridge IMAP config. */
export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Same Bridge account username IMAP uses — Bridge issues one credential pair per account, shared across protocols. */
  username: string;
  tlsCertPath: string;
}

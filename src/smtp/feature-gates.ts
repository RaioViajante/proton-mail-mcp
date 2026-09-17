/**
 * Live feature gates for reply/forward (0.5.2, "Controlled Reply & Forward").
 *
 * Mirrors `mutations/permanent-delete.ts`'s hard, hardcoded gate (not
 * env/config-driven): `mail_reply_preview`/`mail_forward_preview` and the
 * dry-run path of `mail_reply`/`mail_forward` all work fully in this version
 * — only a live (`dryRun: false`) submission is refused, unconditionally,
 * before it can reach `getPassword`/SMTP. A future task will flip these to
 * `false` only after live-validating each path against the real Bridge,
 * exactly as 0.5.1 did for `mail_send`.
 *
 * See `src/smtp/reply-send.ts`/`forward-send.ts` for exactly where this is
 * checked (before the replay-guard nonce is consumed, so a gate-blocked call
 * never burns an otherwise-valid receipt) and `deps.liveDisabled` for how
 * tests exercise the post-gate path without flipping these constants.
 */
export const LIVE_REPLY_DISABLED = true;
export const LIVE_FORWARD_DISABLED = true;

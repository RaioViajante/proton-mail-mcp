/**
 * Live feature gates for reply/forward (introduced 0.5.2, "Controlled Reply
 * & Forward"). Mirrors `mutations/permanent-delete.ts`'s hard, hardcoded
 * gate (not env/config-driven) and exactly how 0.5.0 shipped `mail_send`
 * gated off before 0.5.1 live-validated and lifted it.
 *
 * 0.5.3 ("Controlled Live Reply") lifts `LIVE_REPLY_DISABLED` in code.
 * Real Bridge validation is still pending and is performed separately after
 * a full MCP process restart; this implementation sends no real reply.
 * Every other 0.5.2 protection is unchanged: consent gate,
 * receipt verification, source revalidation immediately before SMTP, and
 * the replay guard consuming the nonce right before submission.
 *
 * `LIVE_FORWARD_DISABLED` stays `true` — forward is not part of this
 * version's live validation and remains preview/dry-run-only until its own
 * separate live-validation task.
 *
 * See `src/smtp/reply-send.ts`/`forward-send.ts` for exactly where each gate
 * is checked (before the replay-guard nonce is consumed, so a gate-blocked
 * call never burns an otherwise-valid receipt) and `deps.liveDisabled` for
 * how tests exercise the post-gate path without flipping these constants.
 */
export const LIVE_REPLY_DISABLED = false;
export const LIVE_FORWARD_DISABLED = true;

/**
 * Shared "add this prefix exactly once" logic for reply (`Re:`) and forward
 * (`Fwd:`/`Fw:`) subjects (0.5.2). Neither `mail_reply` nor `mail_forward`
 * accepts a caller-supplied subject — it is always derived from the source
 * message this way, which is what keeps a reply/forward's stated subject
 * from ever diverging from its actual intent.
 */

/** Case-insensitive; tolerates surrounding whitespace but not embedded control characters (the source subject is untrusted). */
export function applyPrefixOnce(
  originalSubject: string | null,
  prefixTestPattern: RegExp,
  prefixToAdd: string,
): string {
  const trimmed = (originalSubject ?? '').trim();
  if (trimmed.length === 0) {
    return prefixToAdd.trim();
  }
  if (prefixTestPattern.test(trimmed)) {
    return trimmed;
  }
  return `${prefixToAdd}${trimmed}`;
}

export const RE_PREFIX_PATTERN = /^re\s*:/i;
export const FWD_PREFIX_PATTERN = /^f(?:wd|w)\s*:/i;

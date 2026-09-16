import type { AnalyzedMessage } from './metadata.js';

function samples<T>(values: readonly T[], max: number): T[] {
  return [...new Set(values)].slice(0, max);
}

function seenDates(messages: readonly AnalyzedMessage[]): {
  firstSeenInWindow: string | null;
  lastSeenInWindow: string | null;
} {
  const dates = messages.flatMap((message) => (message.date ? [message.date] : [])).sort();
  return { firstSeenInWindow: dates[0] ?? null, lastSeenInWindow: dates.at(-1) ?? null };
}

function grouped(
  messages: readonly AnalyzedMessage[],
  key: (message: AnalyzedMessage) => string | null,
): Map<string, AnalyzedMessage[]> {
  const groups = new Map<string, AnalyzedMessage[]>();
  for (const message of messages) {
    const value = key(message);
    if (!value) continue;
    const group = groups.get(value) ?? [];
    group.push(message);
    groups.set(value, group);
  }
  return groups;
}

function byFrequency<T extends { messageCount: number }>(items: T[]): T[] {
  return items.sort((a, b) => b.messageCount - a.messageCount);
}

export function senderStats(messages: readonly AnalyzedMessage[]) {
  return byFrequency(
    [...grouped(messages, (message) => message.sender)].map(([sender, group]) => ({
      sender,
      senderName: group.find((message) => message.senderName)?.senderName ?? null,
      domain: group[0]?.domain ?? null,
      messageCount: group.length,
      unreadCount: group.filter((message) => message.unread).length,
      readCount: group.filter((message) => !message.unread).length,
      ...seenDates(group),
      hasListIdCount: group.filter((message) => message.listId).length,
      hasListUnsubscribeCount: group.filter((message) => message.listUnsubscribePresent).length,
      attachmentCount: group.filter((message) => message.hasAttachments).length,
      sampleSubjects: samples(
        group.flatMap((message) => (message.subject ? [message.subject] : [])),
        3,
      ),
      sampleUids: group.slice(0, 5).map((message) => message.uid),
    })),
  );
}

export function domainStats(messages: readonly AnalyzedMessage[]) {
  return byFrequency(
    [...grouped(messages, (message) => message.domain)].map(([domain, group]) => ({
      domain,
      messageCount: group.length,
      uniqueSenders: new Set(group.map((message) => message.sender)).size,
      unreadCount: group.filter((message) => message.unread).length,
      ...seenDates(group),
      listMessageCount: group.filter((message) => message.listId).length,
      unsubscribeHeaderCount: group.filter((message) => message.listUnsubscribePresent).length,
      sampleSenderNames: samples(
        group.flatMap((message) => (message.senderName ? [message.senderName] : [])),
        3,
      ),
      sampleSubjects: samples(
        group.flatMap((message) => (message.subject ? [message.subject] : [])),
        3,
      ),
      sampleUids: group.slice(0, 5).map((message) => message.uid),
    })),
  );
}

export function mailingListCandidates(messages: readonly AnalyzedMessage[]) {
  return byFrequency(
    [...grouped(messages, (message) => message.sender)].flatMap(([sender, group]) => {
      const evidence = group.filter(
        (message) =>
          message.listId ||
          message.listUnsubscribePresent ||
          message.oneClickUnsubscribeAdvertised ||
          /^(bulk|list)$/i.test(message.precedence ?? ''),
      );
      // Repetition alone is weak evidence, but still a useful candidate for
      // Claude to inspect. Header booleans remain false in that case.
      if (evidence.length === 0 && group.length < 3) return [];
      return [
        {
          sender,
          domain: group[0]?.domain ?? null,
          messageCount: group.length,
          listIdPresent: evidence.some((message) => Boolean(message.listId)),
          listUnsubscribePresent: evidence.some((message) => message.listUnsubscribePresent),
          oneClickUnsubscribeAdvertised: evidence.some(
            (message) => message.oneClickUnsubscribeAdvertised,
          ),
          unsubscribeMechanisms: samples(
            evidence.flatMap((message) => message.unsubscribeMechanisms),
            3,
          ),
          sampleSubjects: samples(
            group.flatMap((message) => (message.subject ? [message.subject] : [])),
            3,
          ),
          sampleUids: group.slice(0, 5).map((message) => message.uid),
          lastSeenInWindow: seenDates(group).lastSeenInWindow,
        },
      ];
    }),
  );
}

/** Only observed syntax: [tag] or the first two words. No semantic classification. */
export function subjectPrefix(subject: string | null): string | null {
  if (!subject) return null;
  const bracket = /^\[[^\]\r\n]{2,40}\]/.exec(subject);
  if (bracket) return bracket[0];
  const words = /^([\p{L}\p{N}][\p{L}\p{N}'-]*\s+[\p{L}\p{N}][\p{L}\p{N}'-]*)/u.exec(subject);
  return words?.[1]?.slice(0, 40).toLowerCase() ?? null;
}

export interface AutomationCandidate {
  basis: 'sender' | 'domain' | 'list-id' | 'subject-prefix';
  value: string;
  messageCount: number;
  sampleUids: number[];
  availableSignals: { listId: boolean; unsubscribe: boolean };
  candidateForRecurringRule: true;
}

export function automationCandidates(
  messages: readonly AnalyzedMessage[],
  minMessages: number,
): AutomationCandidate[] {
  const bases: AutomationCandidate['basis'][] = ['sender', 'domain', 'list-id', 'subject-prefix'];
  const key = (basis: AutomationCandidate['basis'], message: AnalyzedMessage): string | null => {
    switch (basis) {
      case 'sender':
        return message.sender;
      case 'domain':
        return message.domain;
      case 'list-id':
        return message.listId;
      case 'subject-prefix':
        return subjectPrefix(message.subject);
    }
  };
  return bases
    .flatMap((basis) =>
      [...grouped(messages, (message) => key(basis, message))]
        .filter(([, group]) => group.length >= minMessages)
        .map(([value, group]) => ({
          basis,
          value,
          messageCount: group.length,
          sampleUids: group.slice(0, 5).map((message) => message.uid),
          availableSignals: {
            listId: group.some((message) => Boolean(message.listId)),
            unsubscribe: group.some((message) => message.listUnsubscribePresent),
          },
          candidateForRecurringRule: true as const,
        })),
    )
    .sort((a, b) => b.messageCount - a.messageCount);
}

export function triageSnapshot(messages: readonly AnalyzedMessage[]) {
  return {
    summary: {
      totalAnalyzed: messages.length,
      unread: messages.filter((message) => message.unread).length,
      read: messages.filter((message) => !message.unread).length,
      uniqueSenders: new Set(
        messages.flatMap((message) => (message.sender ? [message.sender] : [])),
      ).size,
      uniqueDomains: new Set(
        messages.flatMap((message) => (message.domain ? [message.domain] : [])),
      ).size,
      mailingListMessages: messages.filter(
        (message) => message.listId || message.listUnsubscribePresent,
      ).length,
      messagesWithAttachments: messages.filter((message) => message.hasAttachments).length,
    },
    topSenders: senderStats(messages).slice(0, 10),
    topDomains: domainStats(messages).slice(0, 10),
    recentMessages: messages.slice(0, 30).map((message) => ({
      uid: message.uid,
      from: message.sender,
      senderName: message.senderName,
      subject: message.subject,
      date: message.date,
      unread: message.unread,
      hasAttachments: message.hasAttachments,
      listIdPresent: Boolean(message.listId),
      listUnsubscribePresent: message.listUnsubscribePresent,
      oneClickUnsubscribeAdvertised: message.oneClickUnsubscribeAdvertised,
    })),
  };
}

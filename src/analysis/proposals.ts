/** A future human-reviewed proposal contract. No execution path exists in V2.5. */
export type ProposedAction =
  | 'keep'
  | 'archive'
  | 'move'
  | 'label'
  | 'unsubscribe-candidate'
  | 'spam-candidate'
  | 'block-candidate';

export interface RuleProposal {
  match:
    | { type: 'sender'; value: string }
    | { type: 'domain'; value: string }
    | { type: 'list-id'; value: string }
    | { type: 'subject-prefix'; value: string };
  proposedAction: ProposedAction;
  destination?: string;
  evidence: { messageCount: number; sampleUids: number[] };
}

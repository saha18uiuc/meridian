import type { PrimitiveType } from './schemas/primitives.js';

/**
 * The words the product says out loud.
 *
 * The brief's test for the primitive set is that you can explain each one to a non-engineer in a
 * single sentence. Those sentences existed — in a developer comment at the top of each card
 * component and in the PRD's Section 2 table — and a user of the product could see neither. Copy
 * that only reviewers read is not an explanation.
 *
 * They live in `@meridian/core` rather than beside the components because three places need to
 * agree on them: the authoring UI, the written deliverable that quotes them, and the test that
 * checks the two have not drifted. A sentence duplicated into a React component is a sentence that
 * will say something different from the PRD within a month.
 *
 * The enum labels are here for the same reason and a blunter one. A `<select>` offering
 * `needs_information` is asking a warehouse manager to read an identifier, and the identifier is
 * the database's business, not theirs.
 */

export interface PrimitiveGuide {
  /** What the card is called in the interface. */
  readonly label: string;
  /** The PRD's "what it combines" column, which is why there are four and not seven. */
  readonly combines: string;
  /** The one-sentence explanation, aimed at somebody who has never seen the tool. */
  readonly sentence: string;
  /** Toolbar wording, phrased as the thing the process owner is adding rather than a type name. */
  readonly addLabel: string;
}

export const PRIMITIVE_GUIDE: Readonly<Record<PrimitiveType, PrimitiveGuide>> = {
  input: {
    label: 'Input',
    combines: 'Event + Information',
    sentence:
      'Something that arrives from outside and starts or feeds the process — an email, a document, a set of values — together with the identifiers that say which shipment it belongs to.',
    addLabel: 'Something arrives',
  },
  action: {
    label: 'Action',
    combines: 'Task + System + Human Handoff',
    sentence:
      'A piece of work somebody or something does: the agent, a person, or another system. It names who does it, what they do it in, and what they need to start.',
    addLabel: 'Do some work',
  },
  rule: {
    label: 'Rule',
    combines: 'Decision + Wait + retry/exception',
    sentence:
      'A point where the process can go more than one way — a choice, a wait for something to turn up, a retry after a failure, or an escape route when something goes wrong.',
    addLabel: 'Decide or wait',
  },
  outcome: {
    label: 'Outcome',
    combines: 'The meaningful result',
    sentence:
      'A state the process can end in that somebody would recognise as a result: cleared to receive, waiting on missing paperwork, sent to a person to look at.',
    addLabel: 'Reach a result',
  },
};

/** Human wording for the enumerated values a card can hold. */
export const ENUM_LABELS = {
  inputKind: {
    event: 'An event that happens',
    document: 'A document that arrives',
    data: 'A set of data values',
  },
  actor: {
    agent: 'The agent',
    human: 'A person',
    system: 'Another system',
  },
  ruleKind: {
    decision: 'Choose between branches',
    wait: 'Wait for something',
    retry: 'Retry after a failure',
    exception: 'Handle something going wrong',
  },
  resultKind: {
    ready: 'Ready to proceed',
    needs_information: 'Waiting on missing information',
    manual_review: 'Sent to a person to review',
    rejected: 'Rejected',
    completed: 'Completed',
  },
  fieldType: {
    string: 'Text',
    number: 'Number',
    date: 'Date',
    boolean: 'Yes or no',
    enum: 'One of a fixed list',
  },
} as const satisfies Record<string, Record<string, string>>;

/** Fall back to the raw value rather than showing nothing when a board holds an older enum. */
export function labelFor<Group extends keyof typeof ENUM_LABELS>(
  group: Group,
  value: string,
): string {
  return (ENUM_LABELS[group] as Record<string, string | undefined>)[value] ?? value;
}

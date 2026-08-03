import { main as boards } from './boards.js';
import { main as documents } from './documents.js';
import { main as evalCases } from './eval-cases.js';
import { main as specSnapshot } from './spec-snapshot.js';

/**
 * Regenerate every checked-in example artifact: the two boards, the message and attachment
 * fixtures, the fifteen eval cases with their expected documents, and the spec snapshot and
 * manifest that pin the generated agent to the contract it was built from.
 *
 * The artifacts are committed, not built on demand. A fixture regenerated on every run cannot
 * catch an accidental change to the compiler, the canonicalizer, or the agent's policy, because it
 * would simply move along with the change. This script exists so the committed files can be
 * reproduced and reviewed as a diff.
 */
export async function main(_argv: readonly string[] = []): Promise<void> {
  await boards();
  await documents();
  await evalCases();
  // Last, and dependent on the first: the snapshot is compiled from the board written above, so
  // regenerating in the other order would pin the agent to the previous revision of the fixture.
  await specSnapshot();
}

export * from './boards.js';
export * from './documents.js';
export * from './eval-cases.js';
export * from './spec-snapshot.js';

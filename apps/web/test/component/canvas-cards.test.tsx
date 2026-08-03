import type { WhiteboardNode } from '@meridian/core/schemas';
import { render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionCard } from '@/features/whiteboard/nodes/ActionCard';
import { InputCard } from '@/features/whiteboard/nodes/InputCard';
import { OutcomeCard } from '@/features/whiteboard/nodes/OutcomeCard';
import { RuleCard } from '@/features/whiteboard/nodes/RuleCard';
import type { MeridianFlowNode } from '@/features/whiteboard/Canvas';

/**
 * The four primitive cards.
 *
 * There are exactly four, and the assignment says so; the cards are the place a fifth would first
 * appear, so these tests pin what each one renders and, just as importantly, that a card with
 * unreadable data says it is unreadable instead of rendering a plausible-looking blank. A card that
 * silently omitted a field it could not parse would let a broken board pass a visual review.
 *
 * `@xyflow/react`'s `Handle` needs a flow provider that a unit render has no business standing up,
 * so it is replaced with an inert element. Nothing under test depends on its behaviour.
 */

vi.mock('@xyflow/react', () => ({
  Handle: ({ type }: { type: string }) => <span data-testid={`handle-${type}`} />,
  Position: { Left: 'left', Right: 'right' },
}));

function props(node: Partial<WhiteboardNode> & Pick<WhiteboardNode, 'primitiveType' | 'data'>) {
  const full: WhiteboardNode = {
    nodeId: '11111111-1111-4111-8111-111111111111',
    primitiveType: node.primitiveType,
    title: node.title ?? 'Card',
    data: node.data,
    position: { x: 0, y: 0 },
    rowVersion: 1,
  };
  return { data: { node: full }, selected: false } as unknown as NodeProps<MeridianFlowNode>;
}

describe('the Input card', () => {
  it('shows what arrives and what correlates it', () => {
    render(
      <InputCard
        {...props({
          primitiveType: 'input',
          title: 'Arrival notice email',
          data: {
            inputKind: 'event',
            sourceSystem: 'gmail',
            required: true,
            fields: [
              { name: 'containerNumber', type: 'string', required: true },
              { name: 'eta', type: 'date', required: false },
            ],
            correlationKeys: ['containerNumber'],
          },
        })}
      />,
    );

    expect(screen.getByLabelText('Input card Arrival notice email')).toBeInTheDocument();
    expect(screen.getByText('gmail')).toBeInTheDocument();
    // Field order is preserved, because it is part of the canonical hash.
    expect(screen.getByText('containerNumber, eta')).toBeInTheDocument();
    expect(screen.getByText('Correlates on').nextSibling).toHaveTextContent('containerNumber');
  });

  it('renders an em dash for an empty list rather than nothing at all', () => {
    render(
      <InputCard
        {...props({
          primitiveType: 'input',
          data: {
            inputKind: 'data',
            sourceSystem: '',
            required: false,
            fields: [],
            correlationKeys: [],
          },
        })}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });
});

describe('the Action card', () => {
  it('leads with the actor, then the operation and its flow', () => {
    render(
      <ActionCard
        {...props({
          primitiveType: 'action',
          title: 'Extract fields',
          data: {
            actor: 'agent',
            operation: 'document.extract',
            instructions: 'Read every attachment.',
            system: 'documents',
            inputs: ['attachments'],
            outputs: ['goods', 'weights'],
          },
        })}
      />,
    );

    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('document.extract')).toBeInTheDocument();
    expect(screen.getByText(/attachments/)).toHaveTextContent('attachments → goods, weights');
  });

  it('distinguishes a human handoff from agent work at a glance', () => {
    render(
      <ActionCard
        {...props({
          primitiveType: 'action',
          title: 'Confirm HS code',
          data: {
            actor: 'human',
            operation: 'confirm.hs_code',
            instructions: 'Ask the broker.',
            system: 'email',
            inputs: [],
            outputs: [],
          },
        })}
      />,
    );
    expect(screen.getByText('human')).toBeInTheDocument();
  });
});

describe('the Rule card', () => {
  it('lists branches in the author’s order and names its bound', () => {
    render(
      <RuleCard
        {...props({
          primitiveType: 'rule',
          title: 'Retry the extraction',
          data: {
            ruleKind: 'retry',
            condition: 'extraction failed',
            branches: [
              { label: 'zebra', condition: 'a', targetNodeId: null },
              { label: 'apple', condition: 'b', targetNodeId: null },
            ],
            maxAttempts: 3,
            fallbackNodeId: null,
          },
        })}
      />,
    );

    // Not sorted. `apple | zebra` would misrepresent which branch is evaluated first.
    expect(screen.getByText('zebra | apple')).toBeInTheDocument();
    expect(screen.getByText('3 attempts')).toBeInTheDocument();
  });

  it('shows a wait rule its timeout instead', () => {
    render(
      <RuleCard
        {...props({
          primitiveType: 'rule',
          data: {
            ruleKind: 'wait',
            condition: 'awaiting customs release',
            branches: [],
            timeoutMinutes: 240,
            fallbackNodeId: null,
          },
        })}
      />,
    );
    expect(screen.getByText('240 min')).toBeInTheDocument();
  });
});

describe('the Outcome card', () => {
  it('shows the result, whether it is terminal, and what it still requires', () => {
    render(
      <OutcomeCard
        {...props({
          primitiveType: 'outcome',
          title: 'Missing information',
          data: {
            resultKind: 'needs_information',
            terminal: false,
            requiredAction: {
              actionType: 'send_email',
              description: 'Ask the forwarder for the packing list.',
              capability: 'mail.send',
            },
          },
        })}
      />,
    );

    expect(screen.getByText('needs_information')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
    expect(screen.getByText('send_email')).toBeInTheDocument();
    // The capability is shown because it is what the outcome will be allowed to do.
    expect(screen.getByText('mail.send')).toBeInTheDocument();
  });

  it('marks a terminal outcome as terminal', () => {
    render(
      <OutcomeCard
        {...props({
          primitiveType: 'outcome',
          data: { resultKind: 'ready', terminal: true },
        })}
      />,
    );
    expect(screen.getByText('yes')).toBeInTheDocument();
  });
});

describe('a card whose data does not parse', () => {
  it('says so rather than rendering a convincing blank', () => {
    // This is the case that matters. A card that dropped the fields it could not read would look
    // like a card with nothing configured, and an operator would review it as if it were fine.
    for (const [Card, primitiveType] of [
      [InputCard, 'input'],
      [ActionCard, 'action'],
      [RuleCard, 'rule'],
      [OutcomeCard, 'outcome'],
    ] as const) {
      const { unmount } = render(<Card {...props({ primitiveType, data: { nonsense: true } })} />);
      expect(
        screen.getByText(new RegExp(`invalid ${primitiveType} data`, 'i')),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe('every card', () => {
  it('exposes an accessible name and its primitive type', () => {
    render(
      <ActionCard
        {...props({
          primitiveType: 'action',
          title: 'Extract fields',
          data: {
            actor: 'agent',
            operation: 'document.extract',
            instructions: '',
            system: 'documents',
            inputs: [],
            outputs: [],
          },
        })}
      />,
    );
    const card = screen.getByLabelText('Action card Extract fields');
    expect(card).toHaveAttribute('data-primitive', 'action');
    expect(screen.getByTestId('handle-target')).toBeInTheDocument();
    expect(screen.getByTestId('handle-source')).toBeInTheDocument();
  });
});

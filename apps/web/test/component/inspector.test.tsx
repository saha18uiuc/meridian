import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Inspector } from '@/features/whiteboard/Inspector';
import {
  createGraphStore,
  emptyNodeData,
  type GraphStore,
} from '@/features/whiteboard/useGraphStore';

/**
 * The inspector, which is where a board stops being boxes and becomes a specification.
 *
 * The property these tests protect is array order. A Rule's branches and an Input's fields are
 * evaluated in the order the author wrote them, that order is part of the canonical hash, and the
 * editor therefore offers explicit move controls and never sorts anything on the author's behalf.
 * A control that quietly reordered would change what the process means and invalidate a review.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const EDGE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_NODE_ID = '33333333-3333-4333-8333-333333333333';

function storeWith(
  primitiveType: 'input' | 'action' | 'rule' | 'outcome',
  data: Record<string, unknown> = {},
): GraphStore {
  return createGraphStore({
    metadata: {
      whiteboardId: '44444444-4444-4444-8444-444444444444',
      title: 'Inbound import receiving',
      status: 'draft',
      revisionNo: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    nodes: [
      {
        nodeId: NODE_ID,
        primitiveType,
        title: 'Card under edit',
        data: { ...emptyNodeData(primitiveType), ...data },
        position: { x: 0, y: 0 },
        rowVersion: 1,
      },
      {
        nodeId: OTHER_NODE_ID,
        primitiveType: 'outcome',
        title: 'Ready to receive',
        data: emptyNodeData('outcome'),
        position: { x: 300, y: 0 },
        rowVersion: 1,
      },
    ],
    edges: [
      {
        edgeId: EDGE_ID,
        sourceNodeId: NODE_ID,
        targetNodeId: OTHER_NODE_ID,
        label: 'all fields present',
        condition: null,
        priority: 1,
        rowVersion: 1,
      },
    ],
  });
}

function renderInspector(
  store: GraphStore,
  selection: { kind: 'node' | 'edge'; id: string } | null,
) {
  return render(<Inspector store={store} selection={selection} onSelect={() => undefined} />);
}

describe('with nothing selected', () => {
  it('says so instead of rendering an empty form', () => {
    renderInspector(storeWith('input'), null);
    expect(screen.getByText(/select a card or a connection/i)).toBeInTheDocument();
  });

  it('says so when the selected card has been deleted underneath it', () => {
    renderInspector(storeWith('input'), { kind: 'node', id: 'not-a-node' });
    expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
  });
});

describe('editing a card', () => {
  it('writes the title through to the store as it is typed', async () => {
    const user = userEvent.setup();
    const store = storeWith('action');
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.clear(screen.getByTestId('node-title'));
    await user.type(screen.getByTestId('node-title'), 'Extract fields');

    expect(store.getState().nodes[0]?.title).toBe('Extract fields');
    expect(store.getState().dirtyNodeIds.has(NODE_ID)).toBe(true);
  });

  it('reports invalid card data without discarding what was typed', async () => {
    const user = userEvent.setup();
    const store = storeWith('action', { operation: '' });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    // An empty operation is invalid. The editor says so and keeps the value, because throwing away
    // a half-finished edit is a worse answer than showing a warning.
    expect(screen.getByTestId('inspector-validation')).toHaveTextContent(/invalid/i);
    await user.type(screen.getByTestId('action-operation'), 'document.extract');
    expect(screen.getByTestId('inspector-validation')).toHaveTextContent(/valid/i);
  });

  it('offers only the primitive fields that belong to the selected kind', () => {
    renderInspector(storeWith('outcome'), { kind: 'node', id: NODE_ID });
    expect(screen.getByTestId('outcome-result-kind')).toBeInTheDocument();
    expect(screen.queryByTestId('action-operation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('input-kind')).not.toBeInTheDocument();
  });

  it('shows a retry rule its attempt limit and a wait rule its timeout, never both', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule', { ruleKind: 'retry', maxAttempts: 3 });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    expect(screen.getByTestId('rule-max-attempts')).toBeInTheDocument();
    expect(screen.queryByTestId('rule-timeout')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('rule-kind'), 'wait');
    expect(screen.getByTestId('rule-timeout')).toBeInTheDocument();
    expect(screen.queryByTestId('rule-max-attempts')).not.toBeInTheDocument();
  });
});

describe('array order', () => {
  it('moves a branch without sorting the rest', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule', {
      ruleKind: 'decision',
      condition: 'documents complete',
      branches: [
        { label: 'zebra', condition: 'a', targetNodeId: null },
        { label: 'apple', condition: 'b', targetNodeId: null },
        { label: 'mango', condition: 'c', targetNodeId: null },
      ],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.click(screen.getByLabelText('Move branch item 3 up'));

    const labels = (store.getState().nodes[0]?.data['branches'] as { label: string }[]).map(
      (branch) => branch.label,
    );
    // Exactly one swap. Alphabetical order would be `apple, mango, zebra`, and a component that
    // produced that would silently rewrite which branch is evaluated first.
    expect(labels).toEqual(['zebra', 'mango', 'apple']);
  });

  it('refuses to move the first item up or the last item down', async () => {
    const user = userEvent.setup();
    const store = storeWith('input', {
      fields: [
        { name: 'containerNumber', type: 'string', required: true },
        { name: 'eta', type: 'date', required: false },
      ],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.click(screen.getByLabelText('Move field item 1 up'));
    await user.click(screen.getByLabelText('Move field item 2 down'));

    const names = (store.getState().nodes[0]?.data['fields'] as { name: string }[]).map(
      (field) => field.name,
    );
    expect(names).toEqual(['containerNumber', 'eta']);
  });

  it('appends new items at the end rather than at the top', async () => {
    const user = userEvent.setup();
    const store = storeWith('action', { inputs: ['attachments'] });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.click(screen.getByTestId('action-inputs-add'));

    expect(store.getState().nodes[0]?.data['inputs']).toEqual(['attachments', 'new_input']);
  });

  it('removes the item that was asked for and no other', async () => {
    const user = userEvent.setup();
    const store = storeWith('input', {
      correlationKeys: ['containerNumber', 'bookingNumber', 'mawb'],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.click(screen.getByLabelText('Remove correlation key item 2'));

    expect(store.getState().nodes[0]?.data['correlationKeys']).toEqual(['containerNumber', 'mawb']);
  });
});

/**
 * Every field the compiler reads has to be reachable from the interface.
 *
 * Five were not: a Rule's fallback target and each branch's target, a field's `required` flag and
 * its description, and an Outcome's required-action description. All five are named in the PRD's
 * card-data column and all five are compiled, so a board could not express them and a spec frozen
 * from it silently under-specified the process.
 */
describe('the fields that had no control', () => {
  it('picks a rule fallback from the board rather than asking for a UUID', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule');
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.selectOptions(screen.getByTestId('rule-fallback'), OTHER_NODE_ID);

    expect(store.getState().nodes[0]?.data['fallbackNodeId']).toBe(OTHER_NODE_ID);
  });

  it('never offers the card itself as its own fallback', () => {
    const store = storeWith('rule');
    renderInspector(store, { kind: 'node', id: NODE_ID });

    const options = [...screen.getByTestId('rule-fallback').querySelectorAll('option')];
    expect(options.map((option) => option.value)).toEqual(['', OTHER_NODE_ID]);
  });

  it('picks a branch target from the board', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule', {
      branches: [{ label: 'documents complete', condition: '', targetNodeId: null }],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.selectOptions(screen.getByTestId('rule-branch-target-0'), OTHER_NODE_ID);

    const branches = store.getState().nodes[0]?.data['branches'] as { targetNodeId: string }[];
    expect(branches[0]?.targetNodeId).toBe(OTHER_NODE_ID);
  });

  it('lets a field be optional, instead of hardcoding every field as required', async () => {
    const user = userEvent.setup();
    const store = storeWith('input', {
      fields: [{ name: 'registrationNumber', type: 'string', required: true }],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.click(screen.getByTestId('input-field-required-0'));

    const fields = store.getState().nodes[0]?.data['fields'] as { required: boolean }[];
    expect(fields[0]?.required).toBe(false);
  });

  it('describes a field, which is what the extraction prompt is built from', async () => {
    const user = userEvent.setup();
    const store = storeWith('input', {
      fields: [{ name: 'htsCode', type: 'string', required: true }],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.type(screen.getByTestId('input-field-description-0'), 'Harmonized tariff code.');

    const fields = store.getState().nodes[0]?.data['fields'] as { description?: string }[];
    expect(fields[0]?.description).toBe('Harmonized tariff code.');
  });

  it('describes what a required action should do', async () => {
    const user = userEvent.setup();
    const store = storeWith('outcome', {
      requiredAction: { actionType: 'send_email', description: '' },
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.type(screen.getByTestId('outcome-action-description'), 'Ask for the packing list.');

    const action = store.getState().nodes[0]?.data['requiredAction'] as { description: string };
    expect(action.description).toBe('Ask for the packing list.');
  });

  it('keeps the description when the capability is set afterwards', async () => {
    // Both edit one nested object. An earlier version rebuilt it from the action type alone, so
    // typing in the second field erased the first.
    const user = userEvent.setup();
    const store = storeWith('outcome', {
      requiredAction: { actionType: 'send_email', description: 'Ask for the packing list.' },
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    await user.type(screen.getByTestId('outcome-capability'), 'mail.send');

    const action = store.getState().nodes[0]?.data['requiredAction'] as {
      description: string;
      capability: string;
    };
    expect(action).toMatchObject({
      description: 'Ask for the packing list.',
      capability: 'mail.send',
    });
  });

  it('no longer offers the node-level Input "required" flag', () => {
    // It claimed the process could not run without the input, was read by nothing, and was `true`
    // even on the certificate of analysis whose absence the board explicitly routes around.
    renderInspector(storeWith('input'), { kind: 'node', id: NODE_ID });
    expect(screen.queryByTestId('input-required')).not.toBeInTheDocument();
  });
});

describe('teaching the primitives', () => {
  it('explains the selected primitive in a sentence', () => {
    renderInspector(storeWith('rule'), { kind: 'node', id: NODE_ID });
    expect(screen.getByTestId('primitive-sentence')).toHaveTextContent(
      /a point where the process can go more than one way/i,
    );
  });

  it('labels enum choices in words rather than database values', () => {
    renderInspector(storeWith('outcome'), { kind: 'node', id: NODE_ID });
    const options = [...screen.getByTestId('outcome-result-kind').querySelectorAll('option')];
    expect(options.map((option) => option.textContent)).toContain('Waiting on missing information');
    expect(options.map((option) => option.textContent)).not.toContain('needs_information');
  });
});

describe('branches and the arrows that implement them', () => {
  it('shows the arrows leaving the rule beside its branches', () => {
    const store = storeWith('rule', {
      branches: [{ label: 'all fields present', condition: '', targetNodeId: null }],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    expect(screen.getByTestId('branch-edge-agreement')).toHaveTextContent('all fields present');
    expect(screen.queryByTestId('branch-edge-divergence')).not.toBeInTheDocument();
  });

  it('says so the moment a branch and its arrow stop agreeing', () => {
    // The seeded edge is labelled "all fields present". Renaming only the branch is the exact
    // mistake this surfaces, and it happens while the author is still on the card.
    const store = storeWith('rule', {
      branches: [{ label: 'documents complete', condition: '', targetNodeId: null }],
    });
    renderInspector(store, { kind: 'node', id: NODE_ID });

    const warning = screen.getByTestId('branch-edge-divergence');
    expect(warning).toHaveTextContent('documents complete');
    expect(warning).toHaveTextContent('all fields present');
  });
});

describe('editing a connection', () => {
  it('edits the label and priority in place', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule');
    renderInspector(store, { kind: 'edge', id: EDGE_ID });

    await user.clear(screen.getByTestId('edge-label'));
    await user.type(screen.getByTestId('edge-label'), 'documents missing');
    await user.clear(screen.getByTestId('edge-priority'));
    await user.type(screen.getByTestId('edge-priority'), '2');

    expect(store.getState().edges[0]?.label).toBe('documents missing');
    expect(store.getState().edges[0]?.priority).toBe(2);
    expect(store.getState().dirtyEdgeIds.has(EDGE_ID)).toBe(true);
  });

  it('names both ends, so a connection is identifiable without tracing it on the canvas', () => {
    const store = storeWith('rule');
    renderInspector(store, { kind: 'edge', id: EDGE_ID });
    expect(screen.getByTestId('edge-endpoints')).toBeInTheDocument();
  });

  it('offers no way to author a raw condition object', () => {
    // The control this replaces asked a warehouse receiving manager to type JSON. Its absence is
    // the feature, so it is asserted rather than merely not tested.
    const store = storeWith('rule');
    renderInspector(store, { kind: 'edge', id: EDGE_ID });

    expect(screen.queryByTestId('edge-condition')).not.toBeInTheDocument();
    expect(screen.getByTestId('edge-condition-empty')).toBeInTheDocument();
  });

  it('still shows a condition an import left behind, read-only', () => {
    // Removing the editor must not make stored data invisible: the compiler reads this column, so
    // an operator looking at why a board behaves oddly has to be able to see it.
    const store = storeWith('rule');
    store.updateEdge(EDGE_ID, { condition: { field: 'weight', op: 'gt', value: 1000 } });
    renderInspector(store, { kind: 'edge', id: EDGE_ID });

    expect(screen.getByTestId('edge-condition-readonly')).toHaveTextContent('"weight"');
    expect(screen.queryByTestId('edge-condition')).not.toBeInTheDocument();
    expect(store.getState().edges[0]?.condition).toEqual({
      field: 'weight',
      op: 'gt',
      value: 1000,
    });
  });
});

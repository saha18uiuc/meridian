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

  it('leaves a malformed condition alone rather than storing half of it', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule');
    renderInspector(store, { kind: 'edge', id: EDGE_ID });

    const field = screen.getByTestId('edge-condition');
    await user.type(field, '{{ not json');
    await user.tab();

    expect(store.getState().edges[0]?.condition).toBeNull();
  });

  it('clears the condition when the field is emptied', async () => {
    const user = userEvent.setup();
    const store = storeWith('rule');
    store.updateEdge(EDGE_ID, { condition: { field: 'weight', op: 'gt', value: 1000 } });
    renderInspector(store, { kind: 'edge', id: EDGE_ID });

    await user.clear(screen.getByTestId('edge-condition'));
    await user.tab();

    expect(store.getState().edges[0]?.condition).toBeNull();
  });
});

'use client';

import {
  ACTORS,
  FIELD_TYPES,
  INPUT_KINDS,
  RESULT_KINDS,
  RULE_KINDS,
  safeParseNodeData,
  type BranchSpec,
  type FieldSpec,
} from '@meridian/core/schemas';
import { useId } from 'react';
import type { Selection } from '@/features/whiteboard/Canvas';
import {
  useGraphStore,
  type GraphStore,
  type LocalNode,
} from '@/features/whiteboard/useGraphStore';

/**
 * Typed editing for every primitive field. Array editors expose explicit move-up/move-down
 * controls and never sort, because array order is author-meaningful and hash-significant.
 */
export function Inspector({
  store,
  selection,
  onSelect,
}: {
  store: GraphStore;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const state = useGraphStore(store, (s) => s);
  const errorId = useId();

  if (selection === null) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <p className="muted">Select a card or a connection to edit it.</p>
      </aside>
    );
  }

  if (selection.kind === 'edge') {
    const edge = state.edges.find((e) => e.edgeId === selection.id);
    if (edge === undefined) {
      return (
        <aside className="inspector" aria-label="Inspector">
          <p className="muted">That connection no longer exists.</p>
        </aside>
      );
    }
    return (
      <aside className="inspector stack" aria-label="Inspector">
        <h3>Connection</h3>
        <Labeled label="Label">
          <input
            value={edge.label ?? ''}
            onChange={(event) =>
              store.updateEdge(edge.edgeId, {
                label: event.target.value === '' ? null : event.target.value,
              })
            }
            data-testid="edge-label"
          />
        </Labeled>
        <Labeled label="Priority">
          <input
            type="number"
            value={edge.priority}
            onChange={(event) =>
              store.updateEdge(edge.edgeId, { priority: Number(event.target.value) })
            }
            data-testid="edge-priority"
          />
        </Labeled>
        <Labeled label="Condition (JSON, empty for none)">
          <JsonField
            value={edge.condition}
            onChange={(condition) => store.updateEdge(edge.edgeId, { condition })}
            testId="edge-condition"
          />
        </Labeled>
        <button
          type="button"
          onClick={() => {
            store.removeEdge(edge.edgeId);
            onSelect(null);
          }}
          data-testid="edge-delete"
        >
          Delete connection
        </button>
      </aside>
    );
  }

  const node = state.nodes.find((n) => n.nodeId === selection.id);
  if (node === undefined) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <p className="muted">That card no longer exists.</p>
      </aside>
    );
  }

  const parsed = safeParseNodeData(node.primitiveType, node.data);
  const validationMessage = parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? 'invalid card data');

  function patchData(patch: Record<string, unknown>): void {
    const target = node as LocalNode;
    store.updateNode(target.nodeId, { data: { ...target.data, ...patch } });
  }

  return (
    <aside className="inspector stack" aria-label="Inspector">
      <h3>{node.primitiveType} card</h3>
      <Labeled label="Title">
        <input
          value={node.title}
          onChange={(event) => store.updateNode(node.nodeId, { title: event.target.value })}
          data-testid="node-title"
        />
      </Labeled>

      <p className="muted" aria-live="polite" id={errorId} data-testid="inspector-validation">
        {validationMessage === null ? 'Card data is valid.' : `Invalid: ${validationMessage}`}
      </p>

      {node.primitiveType === 'input' ? (
        <InputFields data={node.data} patch={patchData} />
      ) : node.primitiveType === 'action' ? (
        <ActionFields data={node.data} patch={patchData} />
      ) : node.primitiveType === 'rule' ? (
        <RuleFields data={node.data} patch={patchData} />
      ) : (
        <OutcomeFields data={node.data} patch={patchData} />
      )}

      <button
        type="button"
        onClick={() => {
          store.removeNode(node.nodeId);
          onSelect(null);
        }}
        data-testid="node-delete"
      >
        Delete card
      </button>
    </aside>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="muted">{label}</span>
      {children}
    </label>
  );
}

function JsonField({
  value,
  onChange,
  testId,
}: {
  value: Record<string, unknown> | null;
  onChange: (next: Record<string, unknown> | null) => void;
  testId: string;
}) {
  return (
    <textarea
      rows={3}
      defaultValue={value === null ? '' : JSON.stringify(value)}
      onBlur={(event) => {
        const text = event.target.value.trim();
        if (text === '') {
          onChange(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            onChange(parsed as Record<string, unknown>);
          }
        } catch {
          // A malformed condition is left untouched; the aria-live line reports the card state.
        }
      }}
      data-testid={testId}
    />
  );
}

type Patch = (patch: Record<string, unknown>) => void;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Node data is arbitrary JSON — it comes from the database, and older boards may hold shapes the
 * current schema no longer writes. Coercing an object with `String()` would put the literal text
 * `[object Object]` into an input, and saving that would overwrite the real value with the name of
 * its own type. Only a primitive is worth showing; anything else falls back.
 */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

function OrderedList({
  label,
  count,
  onMove,
  onRemove,
  onAdd,
  children,
  testId,
}: {
  label: string;
  count: number;
  onMove: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  children: (index: number) => React.ReactNode;
  testId: string;
}) {
  return (
    <fieldset className="stack" data-testid={testId}>
      <legend>{label}</legend>
      {Array.from({ length: count }, (_unused, index) => (
        <div className="row" key={index}>
          {children(index)}
          <button
            type="button"
            aria-label={`Move ${label} item ${index + 1} up`}
            onClick={() => onMove(index, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${label} item ${index + 1} down`}
            onClick={() => onMove(index, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`Remove ${label} item ${index + 1}`}
            onClick={() => onRemove(index)}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={onAdd} data-testid={`${testId}-add`}>
        Add {label}
      </button>
    </fieldset>
  );
}

function InputFields({ data, patch }: { data: Record<string, unknown>; patch: Patch }) {
  const fields = asArray<FieldSpec>(data['fields']);
  const correlationKeys = asArray<string>(data['correlationKeys']);
  return (
    <>
      <Labeled label="Input kind">
        <select
          value={asText(data['inputKind'], 'event')}
          onChange={(event) => patch({ inputKind: event.target.value })}
          data-testid="input-kind"
        >
          {INPUT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Source system">
        <input
          value={asText(data['sourceSystem'], '')}
          onChange={(event) => patch({ sourceSystem: event.target.value })}
          data-testid="input-source-system"
        />
      </Labeled>
      <Labeled label="Required">
        <input
          type="checkbox"
          checked={data['required'] === true}
          onChange={(event) => patch({ required: event.target.checked })}
          data-testid="input-required"
        />
      </Labeled>

      <OrderedList
        label="field"
        testId="input-fields"
        count={fields.length}
        onMove={(index, delta) => patch({ fields: move(fields, index, index + delta) })}
        onRemove={(index) => patch({ fields: fields.filter((_f, i) => i !== index) })}
        onAdd={() =>
          patch({ fields: [...fields, { name: 'new_field', type: 'string', required: true }] })
        }
      >
        {(index) => {
          const field = fields[index] as FieldSpec;
          return (
            <>
              <input
                aria-label={`Field ${index + 1} name`}
                value={field.name}
                onChange={(event) => {
                  const next = [...fields];
                  next[index] = { ...field, name: event.target.value };
                  patch({ fields: next });
                }}
              />
              <select
                aria-label={`Field ${index + 1} type`}
                value={field.type}
                onChange={(event) => {
                  const next = [...fields];
                  next[index] = { ...field, type: event.target.value as FieldSpec['type'] };
                  patch({ fields: next });
                }}
              >
                {FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </>
          );
        }}
      </OrderedList>

      <OrderedList
        label="correlation key"
        testId="input-correlation-keys"
        count={correlationKeys.length}
        onMove={(index, delta) =>
          patch({ correlationKeys: move(correlationKeys, index, index + delta) })
        }
        onRemove={(index) =>
          patch({ correlationKeys: correlationKeys.filter((_k, i) => i !== index) })
        }
        onAdd={() => patch({ correlationKeys: [...correlationKeys, 'new_key'] })}
      >
        {(index) => (
          <input
            aria-label={`Correlation key ${index + 1}`}
            value={correlationKeys[index] ?? ''}
            onChange={(event) => {
              const next = [...correlationKeys];
              next[index] = event.target.value;
              patch({ correlationKeys: next });
            }}
          />
        )}
      </OrderedList>
    </>
  );
}

function ActionFields({ data, patch }: { data: Record<string, unknown>; patch: Patch }) {
  const inputs = asArray<string>(data['inputs']);
  const outputs = asArray<string>(data['outputs']);
  return (
    <>
      <Labeled label="Actor">
        <select
          value={asText(data['actor'], 'agent')}
          onChange={(event) => patch({ actor: event.target.value })}
          data-testid="action-actor"
        >
          {ACTORS.map((actor) => (
            <option key={actor} value={actor}>
              {actor}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Operation">
        <input
          value={asText(data['operation'], '')}
          onChange={(event) => patch({ operation: event.target.value })}
          data-testid="action-operation"
        />
      </Labeled>
      <Labeled label="System">
        <input
          value={asText(data['system'], '')}
          onChange={(event) => patch({ system: event.target.value })}
          data-testid="action-system"
        />
      </Labeled>
      <Labeled label="Instructions">
        <textarea
          rows={3}
          value={asText(data['instructions'], '')}
          onChange={(event) => patch({ instructions: event.target.value })}
          data-testid="action-instructions"
        />
      </Labeled>
      <OrderedList
        label="input"
        testId="action-inputs"
        count={inputs.length}
        onMove={(index, delta) => patch({ inputs: move(inputs, index, index + delta) })}
        onRemove={(index) => patch({ inputs: inputs.filter((_v, i) => i !== index) })}
        onAdd={() => patch({ inputs: [...inputs, 'new_input'] })}
      >
        {(index) => (
          <input
            aria-label={`Action input ${index + 1}`}
            value={inputs[index] ?? ''}
            onChange={(event) => {
              const next = [...inputs];
              next[index] = event.target.value;
              patch({ inputs: next });
            }}
          />
        )}
      </OrderedList>
      <OrderedList
        label="output"
        testId="action-outputs"
        count={outputs.length}
        onMove={(index, delta) => patch({ outputs: move(outputs, index, index + delta) })}
        onRemove={(index) => patch({ outputs: outputs.filter((_v, i) => i !== index) })}
        onAdd={() => patch({ outputs: [...outputs, 'new_output'] })}
      >
        {(index) => (
          <input
            aria-label={`Action output ${index + 1}`}
            value={outputs[index] ?? ''}
            onChange={(event) => {
              const next = [...outputs];
              next[index] = event.target.value;
              patch({ outputs: next });
            }}
          />
        )}
      </OrderedList>
    </>
  );
}

function RuleFields({ data, patch }: { data: Record<string, unknown>; patch: Patch }) {
  const branches = asArray<BranchSpec>(data['branches']);
  const ruleKind = asText(data['ruleKind'], 'decision');
  return (
    <>
      <Labeled label="Rule kind">
        <select
          value={ruleKind}
          onChange={(event) => patch({ ruleKind: event.target.value })}
          data-testid="rule-kind"
        >
          {RULE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Condition">
        <input
          value={asText(data['condition'], '')}
          onChange={(event) => patch({ condition: event.target.value })}
          data-testid="rule-condition"
        />
      </Labeled>
      {ruleKind === 'wait' ? (
        <Labeled label="Timeout (minutes)">
          <input
            type="number"
            min={1}
            value={Number(data['timeoutMinutes'] ?? 0) || ''}
            onChange={(event) => patch({ timeoutMinutes: Number(event.target.value) })}
            data-testid="rule-timeout"
          />
        </Labeled>
      ) : null}
      {ruleKind === 'retry' ? (
        <Labeled label="Max attempts">
          <input
            type="number"
            min={1}
            value={Number(data['maxAttempts'] ?? 0) || ''}
            onChange={(event) => patch({ maxAttempts: Number(event.target.value) })}
            data-testid="rule-max-attempts"
          />
        </Labeled>
      ) : null}
      <OrderedList
        label="branch"
        testId="rule-branches"
        count={branches.length}
        onMove={(index, delta) => patch({ branches: move(branches, index, index + delta) })}
        onRemove={(index) => patch({ branches: branches.filter((_b, i) => i !== index) })}
        onAdd={() =>
          patch({
            branches: [...branches, { label: 'new branch', condition: '', targetNodeId: null }],
          })
        }
      >
        {(index) => {
          const branch = branches[index] as BranchSpec;
          return (
            <>
              <input
                aria-label={`Branch ${index + 1} label`}
                value={branch.label}
                onChange={(event) => {
                  const next = [...branches];
                  next[index] = { ...branch, label: event.target.value };
                  patch({ branches: next });
                }}
              />
              <input
                aria-label={`Branch ${index + 1} condition`}
                value={branch.condition}
                onChange={(event) => {
                  const next = [...branches];
                  next[index] = { ...branch, condition: event.target.value };
                  patch({ branches: next });
                }}
              />
            </>
          );
        }}
      </OrderedList>
    </>
  );
}

function OutcomeFields({ data, patch }: { data: Record<string, unknown>; patch: Patch }) {
  const requiredAction = data['requiredAction'] as
    { actionType: string; description: string; capability?: string } | undefined;
  return (
    <>
      <Labeled label="Result kind">
        <select
          value={asText(data['resultKind'], 'ready')}
          onChange={(event) => patch({ resultKind: event.target.value })}
          data-testid="outcome-result-kind"
        >
          {RESULT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Terminal">
        <input
          type="checkbox"
          checked={data['terminal'] === true}
          onChange={(event) => patch({ terminal: event.target.checked })}
          data-testid="outcome-terminal"
        />
      </Labeled>
      <Labeled label="Required action type (empty for none)">
        <input
          value={requiredAction?.actionType ?? ''}
          onChange={(event) =>
            patch({
              requiredAction:
                event.target.value === ''
                  ? undefined
                  : {
                      actionType: event.target.value,
                      description: requiredAction?.description ?? '',
                      ...(requiredAction?.capability === undefined
                        ? {}
                        : { capability: requiredAction.capability }),
                    },
            })
          }
          data-testid="outcome-action-type"
        />
      </Labeled>
      {requiredAction === undefined ? null : (
        <Labeled label="Capability">
          <input
            value={requiredAction.capability ?? ''}
            onChange={(event) =>
              patch({
                requiredAction: {
                  ...requiredAction,
                  ...(event.target.value === '' ? {} : { capability: event.target.value }),
                },
              })
            }
            data-testid="outcome-capability"
          />
        </Labeled>
      )}
    </>
  );
}

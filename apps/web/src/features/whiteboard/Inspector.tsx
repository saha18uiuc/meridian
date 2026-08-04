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
import { PRIMITIVE_GUIDE, labelFor } from '@meridian/core/vocabulary';
import { useId } from 'react';
import type { Selection } from '@/features/whiteboard/Canvas';
import {
  useGraphStore,
  type GraphStore,
  type LocalEdge,
  type LocalNode,
} from '@/features/whiteboard/useGraphStore';

/**
 * Typed editing for every primitive field the compiler reads.
 *
 * Two things are deliberately outside that set, and both are argued in DECISIONS.md: an edge's
 * `condition_json`, which is displayed but never authored here, and an Input's node-level
 * `required`, which is retained in the schema for older boards and offered nowhere.
 *
 * Array editors expose explicit move-up/move-down controls and never sort, because array order is
 * author-meaningful and hash-significant.
 *
 * Every enumerated value is shown through `labelFor`, so the person filling the card reads "Waiting
 * on missing information" rather than `needs_information`. The stored value is unchanged — only
 * what is on screen differs — but a control that shows a database identifier to a warehouse manager
 * is asking them to learn our schema before they can describe their own process.
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
    const source = state.nodes.find((n) => n.nodeId === edge.sourceNodeId);
    const target = state.nodes.find((n) => n.nodeId === edge.targetNodeId);
    return (
      <aside className="inspector stack" aria-label="Inspector">
        <h3>Connection</h3>
        <p className="muted" data-testid="edge-endpoints">
          From <strong>{source?.title ?? 'a removed card'}</strong> to{' '}
          <strong>{target?.title ?? 'a removed card'}</strong>.
        </p>
        <Labeled
          label="When does the process take this path?"
          hint="Plain words. This is what a reader sees written on the arrow."
        >
          <input
            value={edge.label ?? ''}
            onChange={(event) =>
              store.updateEdge(edge.edgeId, {
                label: event.target.value === '' ? null : event.target.value,
              })
            }
            placeholder="e.g. all documents present"
            data-testid="edge-label"
          />
        </Labeled>
        <Labeled label="Priority" hint="Lower numbers are considered first when several paths fit.">
          <input
            type="number"
            value={edge.priority}
            onChange={(event) =>
              store.updateEdge(edge.edgeId, { priority: Number(event.target.value) })
            }
            data-testid="edge-priority"
          />
        </Labeled>
        <EdgeCondition edge={edge} />
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
  const guide = PRIMITIVE_GUIDE[node.primitiveType];

  function patchData(patch: Record<string, unknown>): void {
    const target = node as LocalNode;
    store.updateNode(target.nodeId, { data: { ...target.data, ...patch } });
  }

  const otherNodes = state.nodes.filter((n) => n.nodeId !== node.nodeId);
  const outgoing = state.edges.filter((e) => e.sourceNodeId === node.nodeId);

  return (
    <aside className="inspector stack" aria-label="Inspector">
      <h3>{guide.label}</h3>
      <p className="primitive-sentence" data-testid="primitive-sentence">
        {guide.sentence}
      </p>
      <Labeled label="Title" hint="What this step is called on the board.">
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
        <RuleFields
          data={node.data}
          patch={patchData}
          candidates={otherNodes}
          outgoing={outgoing}
        />
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

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="muted">{label}</span>
      {children}
      {hint === undefined ? null : <span className="field-hint">{hint}</span>}
    </label>
  );
}

/**
 * A connection's stored `condition_json` is shown, never typed.
 *
 * The control this replaces was a textarea asking for a raw JSON object, which is the one place in
 * the product that contradicted the premise of having primitives at all. The column stays — the
 * PRD specifies it and the compiler reads it — but the reference board sets it to `null` on every
 * single edge, expressing conditions as prose on the Rule card and as the label on the arrow. So
 * there is nothing here for a process owner to fill in, and the honest interface says so while
 * still showing a value that a migration or an import may have left behind.
 */
function EdgeCondition({ edge }: { edge: LocalEdge }) {
  if (edge.condition === null) {
    return (
      <p className="muted" data-testid="edge-condition-empty">
        Conditions are written in words — on the arrow above, and on the Rule card this arrow
        leaves.
      </p>
    );
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="muted">Stored machine condition</span>
      <pre className="code-block" data-testid="edge-condition-readonly">
        {JSON.stringify(edge.condition, null, 2)}
      </pre>
      <span className="field-hint">
        Set by an import rather than on this board. It is read by the compiler and is not editable
        here.
      </span>
    </div>
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

/**
 * A card chooser, so a target is picked from the board rather than typed as a UUID.
 *
 * `fallbackNodeId` and `branches[].targetNodeId` are both node references the compiler validates.
 * Offering a text box for them would ask a process owner to copy an identifier they have no way of
 * seeing, and would turn a typo into a compile error at freeze time rather than a choice they
 * cannot get wrong.
 */
function NodePicker({
  value,
  candidates,
  onChange,
  testId,
  emptyLabel,
  ariaLabel,
}: {
  value: string | null;
  candidates: LocalNode[];
  onChange: (nodeId: string | null) => void;
  testId: string;
  emptyLabel: string;
  ariaLabel?: string;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      data-testid={testId}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
    >
      <option value="">{emptyLabel}</option>
      {candidates.map((candidate) => (
        <option key={candidate.nodeId} value={candidate.nodeId}>
          {candidate.title} ({PRIMITIVE_GUIDE[candidate.primitiveType].label})
        </option>
      ))}
    </select>
  );
}

function OrderedList({
  label,
  addLabel,
  count,
  onMove,
  onRemove,
  onAdd,
  children,
  testId,
}: {
  label: string;
  addLabel?: string;
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
        {addLabel ?? `Add ${label}`}
      </button>
    </fieldset>
  );
}

function InputFields({ data, patch }: { data: Record<string, unknown>; patch: Patch }) {
  const fields = asArray<FieldSpec>(data['fields']);
  const correlationKeys = asArray<string>(data['correlationKeys']);
  return (
    <>
      <Labeled label="What arrives?">
        <select
          value={asText(data['inputKind'], 'event')}
          onChange={(event) => patch({ inputKind: event.target.value })}
          data-testid="input-kind"
        >
          {INPUT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {labelFor('inputKind', kind)}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled
        label="Where does it come from?"
        hint="The mailbox, portal, or system it arrives in."
      >
        <input
          value={asText(data['sourceSystem'], '')}
          onChange={(event) => patch({ sourceSystem: event.target.value })}
          placeholder="e.g. pre-alert mailbox"
          data-testid="input-source-system"
        />
      </Labeled>
      <OrderedList
        label="field"
        addLabel="Add a field this carries"
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
          function patchField(next: Partial<FieldSpec>): void {
            const all = [...fields];
            all[index] = { ...field, ...next };
            patch({ fields: all });
          }
          return (
            <>
              <input
                aria-label={`Field ${index + 1} name`}
                value={field.name}
                onChange={(event) => patchField({ name: event.target.value })}
              />
              <select
                aria-label={`Field ${index + 1} type`}
                value={field.type}
                onChange={(event) => patchField({ type: event.target.value as FieldSpec['type'] })}
              >
                {FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {labelFor('fieldType', type)}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Field ${index + 1} description`}
                value={field.description ?? ''}
                placeholder="What is it?"
                onChange={(event) =>
                  patchField(
                    event.target.value === ''
                      ? { description: undefined }
                      : { description: event.target.value },
                  )
                }
                data-testid={`input-field-description-${index}`}
              />
              <label className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  aria-label={`Field ${index + 1} is required`}
                  checked={field.required}
                  onChange={(event) => patchField({ required: event.target.checked })}
                  data-testid={`input-field-required-${index}`}
                />
                <span className="field-hint">required</span>
              </label>
            </>
          );
        }}
      </OrderedList>

      <OrderedList
        label="correlation key"
        addLabel="Add an identifier that ties this to a shipment"
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
      <Labeled label="Who does this?">
        <select
          value={asText(data['actor'], 'agent')}
          onChange={(event) => patch({ actor: event.target.value })}
          data-testid="action-actor"
        >
          {ACTORS.map((actor) => (
            <option key={actor} value={actor}>
              {labelFor('actor', actor)}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="What do they do?" hint="A short name for the work, in your own words.">
        <input
          value={asText(data['operation'], '')}
          onChange={(event) => patch({ operation: event.target.value })}
          placeholder="e.g. check every line on the invoice"
          data-testid="action-operation"
        />
      </Labeled>
      <Labeled label="Where do they do it?" hint="The system or tool the work happens in.">
        <input
          value={asText(data['system'], '')}
          onChange={(event) => patch({ system: event.target.value })}
          placeholder="e.g. gmail"
          data-testid="action-system"
        />
      </Labeled>
      <Labeled label="How should it be done?">
        <textarea
          rows={3}
          value={asText(data['instructions'], '')}
          onChange={(event) => patch({ instructions: event.target.value })}
          data-testid="action-instructions"
        />
      </Labeled>
      <OrderedList
        label="input"
        addLabel="Add something this needs"
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
        addLabel="Add something this produces"
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

function RuleFields({
  data,
  patch,
  candidates,
  outgoing,
}: {
  data: Record<string, unknown>;
  patch: Patch;
  candidates: LocalNode[];
  outgoing: LocalEdge[];
}) {
  const branches = asArray<BranchSpec>(data['branches']);
  const ruleKind = asText(data['ruleKind'], 'decision');
  const edgeLabels = new Set(
    outgoing.map((edge) => (edge.label ?? '').trim().toLowerCase()).filter((label) => label !== ''),
  );
  const unmatched = branches.filter((branch) => !edgeLabels.has(branch.label.trim().toLowerCase()));

  return (
    <>
      <Labeled label="What kind of decision point is this?">
        <select
          value={ruleKind}
          onChange={(event) => patch({ ruleKind: event.target.value })}
          data-testid="rule-kind"
        >
          {RULE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {labelFor('ruleKind', kind)}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="What is being decided?" hint="In plain words, as you would explain it aloud.">
        <input
          value={asText(data['condition'], '')}
          onChange={(event) => patch({ condition: event.target.value })}
          placeholder="e.g. does every batch on the invoice have a COA?"
          data-testid="rule-condition"
        />
      </Labeled>
      {ruleKind === 'wait' ? (
        <Labeled label="How long do we wait? (minutes)">
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
        <Labeled label="How many attempts before giving up?">
          <input
            type="number"
            min={1}
            value={Number(data['maxAttempts'] ?? 0) || ''}
            onChange={(event) => patch({ maxAttempts: Number(event.target.value) })}
            data-testid="rule-max-attempts"
          />
        </Labeled>
      ) : null}

      <Labeled
        label="If nothing else applies, go to"
        hint="The escape route. Used when none of the branches below fit."
      >
        <NodePicker
          value={typeof data['fallbackNodeId'] === 'string' ? data['fallbackNodeId'] : null}
          candidates={candidates}
          onChange={(nodeId) => patch({ fallbackNodeId: nodeId })}
          testId="rule-fallback"
          emptyLabel="No fallback"
        />
      </Labeled>

      <OrderedList
        label="branch"
        addLabel="Add a way this can go"
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
          function patchBranch(next: Partial<BranchSpec>): void {
            const all = [...branches];
            all[index] = { ...branch, ...next };
            patch({ branches: all });
          }
          return (
            <>
              <input
                aria-label={`Branch ${index + 1} label`}
                value={branch.label}
                onChange={(event) => patchBranch({ label: event.target.value })}
              />
              <input
                aria-label={`Branch ${index + 1} condition`}
                value={branch.condition}
                onChange={(event) => patchBranch({ condition: event.target.value })}
              />
              <NodePicker
                value={branch.targetNodeId}
                candidates={candidates}
                onChange={(nodeId) => patchBranch({ targetNodeId: nodeId })}
                testId={`rule-branch-target-${index}`}
                emptyLabel="Follow the arrow"
                ariaLabel={`Branch ${index + 1} target`}
              />
            </>
          );
        }}
      </OrderedList>

      <BranchEdgeAgreement branches={branches} outgoing={outgoing} unmatched={unmatched} />
    </>
  );
}

/**
 * Branch labels and arrow labels describe the same fork and are stored separately, so the board can
 * hold two different answers to "what are the ways out of here". Nothing in the data model links
 * them; the reference board keeps them equal by hand. Showing them side by side is what makes a
 * rename that touched only one of the two visible at the moment it happens, rather than at freeze.
 */
function BranchEdgeAgreement({
  branches,
  outgoing,
  unmatched,
}: {
  branches: BranchSpec[];
  outgoing: LocalEdge[];
  unmatched: BranchSpec[];
}) {
  if (branches.length === 0 && outgoing.length === 0) return null;
  const branchLabels = new Set(
    branches.map((branch) => branch.label.trim().toLowerCase()).filter((label) => label !== ''),
  );
  const strayEdges = outgoing.filter((edge) => {
    const label = (edge.label ?? '').trim().toLowerCase();
    return label !== '' && !branchLabels.has(label);
  });

  return (
    <div className="stack" style={{ gap: 4 }} data-testid="branch-edge-agreement">
      <span className="muted">Arrows leaving this card</span>
      {outgoing.length === 0 ? (
        <span className="field-hint">
          None yet. Drag from the card&apos;s right edge to add one.
        </span>
      ) : (
        <ul className="plain-list">
          {outgoing.map((edge) => (
            <li key={edge.edgeId} className="field-hint">
              {edge.label === null || edge.label === '' ? '(unlabelled)' : edge.label}
            </li>
          ))}
        </ul>
      )}
      {unmatched.length === 0 && strayEdges.length === 0 ? null : (
        <p className="banner warning" data-testid="branch-edge-divergence">
          {unmatched.length === 0
            ? ''
            : `No arrow matches the branch ${unmatched.map((b) => `"${b.label}"`).join(', ')}. `}
          {strayEdges.length === 0
            ? ''
            : `No branch matches the arrow ${strayEdges.map((e) => `"${e.label ?? ''}"`).join(', ')}.`}
        </p>
      )}
    </div>
  );
}

function OutcomeFields({ data, patch }: { data: Record<string, unknown>; patch: Patch }) {
  const requiredAction = data['requiredAction'] as
    { actionType: string; description?: string; capability?: string } | undefined;

  function patchAction(
    next: Partial<{ actionType: string; description: string; capability: string }>,
  ): void {
    const merged = {
      actionType: requiredAction?.actionType ?? '',
      description: requiredAction?.description ?? '',
      ...(requiredAction?.capability === undefined
        ? {}
        : { capability: requiredAction.capability }),
      ...next,
    };
    patch({ requiredAction: merged.actionType === '' ? undefined : merged });
  }

  return (
    <>
      <Labeled label="What kind of result is this?">
        <select
          value={asText(data['resultKind'], 'ready')}
          onChange={(event) => patch({ resultKind: event.target.value })}
          data-testid="outcome-result-kind"
        >
          {RESULT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {labelFor('resultKind', kind)}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="The process stops here" hint="Turn this off if work continues afterwards.">
        <input
          type="checkbox"
          checked={data['terminal'] === true}
          onChange={(event) => patch({ terminal: event.target.checked })}
          data-testid="outcome-terminal"
        />
      </Labeled>
      <Labeled
        label="Something must happen when we get here"
        hint="Leave empty if reaching this result is the whole story."
      >
        <input
          value={requiredAction?.actionType ?? ''}
          onChange={(event) => patchAction({ actionType: event.target.value })}
          placeholder="e.g. send_email"
          data-testid="outcome-action-type"
        />
      </Labeled>
      {requiredAction === undefined ? null : (
        <>
          <Labeled label="What should that say or do?">
            <textarea
              rows={2}
              value={requiredAction.description ?? ''}
              onChange={(event) => patchAction({ description: event.target.value })}
              data-testid="outcome-action-description"
            />
          </Labeled>
          <Labeled
            label="Capability it needs"
            hint="Which permission the agent must hold to do it."
          >
            <input
              value={requiredAction.capability ?? ''}
              onChange={(event) => patchAction({ capability: event.target.value })}
              placeholder="e.g. mail.send"
              data-testid="outcome-capability"
            />
          </Labeled>
        </>
      )}
    </>
  );
}

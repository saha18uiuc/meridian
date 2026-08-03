'use client';

import type { SpecJson } from '@meridian/core/schemas';

export function SpecViewer({
  specId,
  specJson,
  specHash,
  sourceCanvasHash,
  sourceRevisionNo,
  unresolvedCommentIds,
}: {
  specId: string;
  specJson: SpecJson;
  specHash: string;
  sourceCanvasHash: string;
  sourceRevisionNo: number;
  unresolvedCommentIds: string[];
}) {
  return (
    <div className="stack" data-testid="spec-viewer">
      <div className="panel stack">
        <h2 style={{ margin: 0 }}>{specJson.identity.name}</h2>
        <table>
          <tbody>
            <tr>
              <th>Spec version</th>
              <td>{specJson.identity.specVersion}</td>
            </tr>
            <tr>
              <th>Spec hash</th>
              <td>
                <code>{specHash}</code>
              </td>
            </tr>
            <tr>
              <th>Canvas hash</th>
              <td>
                <code>{sourceCanvasHash}</code>
              </td>
            </tr>
            <tr>
              <th>Source revision</th>
              <td>{sourceRevisionNo}</td>
            </tr>
            <tr>
              <th>Capabilities</th>
              <td>{specJson.capabilities.join(', ') || '—'}</td>
            </tr>
            <tr>
              <th>Unresolved at freeze</th>
              <td>{unresolvedCommentIds.length}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          The download below is the canonical RFC 8785 serialization of the stored specification,
          not the raw bytes PostgreSQL happens to hold. Only the canonical form hashes back to{' '}
          <code>spec_hash</code>.
        </p>
        <a href={`/api/specs/${specId}?download=1`} data-testid="spec-download">
          Download canonical spec.json
        </a>
      </div>

      <div className="panel stack">
        <h3>Assumptions</h3>
        {specJson.assumptions.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <ul>
            {specJson.assumptions.map((assumption) => (
              <li key={assumption.sourceCommentId}>{assumption.text}</li>
            ))}
          </ul>
        )}
        <h3>Known gaps</h3>
        {specJson.knownGaps.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <ul>
            {specJson.knownGaps.map((gap) => (
              <li key={gap.sourceCommentId}>
                <span className={gap.severity === 'blocking' ? 'badge blocking' : 'badge'}>
                  {gap.severity}
                </span>{' '}
                {gap.text}
              </li>
            ))}
          </ul>
        )}
        <h3>Acceptance criteria</h3>
        <ul>
          {specJson.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </div>

      <div className="panel stack">
        <h3>Process</h3>
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>Primitive</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {specJson.process.nodes.map((node) => (
              <tr key={node.nodeId}>
                <td>{node.title}</td>
                <td>{node.primitiveType}</td>
                <td className="muted">
                  {specJson.process.initialNodeIds.includes(node.nodeId) ? 'initial ' : ''}
                  {specJson.process.terminalNodeIds.includes(node.nodeId) ? 'terminal' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

'use client';

/**
 * The whole point of the lineage chain is that you can read it off one row: which spec, which
 * commit, which parent. A missing Git SHA is shown as missing rather than hidden.
 */
export function LineageBadge({
  specHash,
  gitCommitSha,
  parentVersionNo,
}: {
  specHash: string | null;
  gitCommitSha: string | null;
  parentVersionNo: number | null;
}) {
  return (
    <span className="row" data-testid="lineage-badge">
      <code title="spec hash">{specHash === null ? '—' : `${specHash.slice(0, 12)}…`}</code>
      <code title="git commit">
        {gitCommitSha === null ? 'no commit yet' : gitCommitSha.slice(0, 7)}
      </code>
      <span className="muted">
        {parentVersionNo === null ? 'root' : `from v${parentVersionNo}`}
      </span>
    </span>
  );
}

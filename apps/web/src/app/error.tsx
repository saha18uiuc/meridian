'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="panel stack">
      <h2>Something went wrong</h2>
      <p className="muted">{error.message}</p>
      {error.digest === undefined ? null : (
        <p className="muted">
          Correlation id: <code>{error.digest}</code>
        </p>
      )}
      <div>
        <button type="button" className="primary" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}

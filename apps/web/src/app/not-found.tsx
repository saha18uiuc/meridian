import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="panel stack">
      <h2>Not found</h2>
      <p className="muted">
        This resource does not exist, or it belongs to another account. Meridian reports both the
        same way on purpose.
      </p>
      <Link href="/boards">Back to boards</Link>
    </div>
  );
}

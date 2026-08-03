'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createBrowserClient } from '@/server/supabase/browser-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('demo@meridian.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError !== null) {
      setError(signInError.message);
      return;
    }
    router.push('/boards');
    router.refresh();
  }

  return (
    <div className="panel stack" style={{ maxWidth: 380, margin: '48px auto' }}>
      <h2>Sign in</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Email</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            data-testid="login-email"
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            data-testid="login-password"
          />
        </label>
        {error === null ? null : (
          <p className="banner error" data-testid="login-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy} data-testid="login-submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

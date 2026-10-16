'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { apiBaseUrl } from '@/lib/api-base';

/**
 * Sign-in and first-account creation.
 *
 * A client component because it holds credentials in local state and must
 * never let them touch the server render. Two details are deliberate:
 *
 *  - `credentials: 'include'` is required. The API sets an httpOnly session
 *    cookie; without this the browser discards it and the login "succeeds"
 *    while leaving the user signed out.
 *  - The API's error message is shown verbatim. It is written to be uniform
 *    across "no such account" and "wrong password", and rewording it here
 *    could reintroduce the distinction the API works to avoid.
 */

type Mode = 'signin' | 'create';

export function SignInForm({
  bootstrapOpen,
  registrationOpen,
}: {
  bootstrapOpen: boolean;
  registrationOpen: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(bootstrapOpen ? 'create' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = bootstrapOpen || registrationOpen;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `${apiBaseUrl}${mode === 'create' ? '/v1/auth/register' : '/v1/auth/login'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Without this the Set-Cookie is dropped and the session is lost.
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        },
      );

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? ((body as { error?: { message?: string } }).error?.message ?? 'Koneksyon an echwe.')
            : 'Koneksyon an echwe.';
        setError(message);
        return;
      }

      // The password never survives the request that used it.
      setPassword('');
      router.replace('/');
      router.refresh();
    } catch {
      setError(`Could not reach the API at ${apiBaseUrl}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Imèl</span>
        <input
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-10 rounded-[6px] border border-edge-strong bg-surface-2 px-3 text-[13px] text-text-1 transition-colors placeholder:text-text-3 focus:border-accent/50"
          placeholder="you@example.com"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Modpas</span>
        <input
          type="password"
          name="password"
          // Tells a password manager to offer a NEW password when creating an
          // account and the saved one when signing in.
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-10 rounded-[6px] border border-edge-strong bg-surface-2 px-3 text-[13px] text-text-1 transition-colors placeholder:text-text-3 focus:border-accent/50"
          placeholder={mode === 'create' ? 'Omwen 12 karaktè' : '••••••••••••'}
        />
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-[6px] border border-bear/25 bg-bear/8 px-3 py-2 text-[12px] leading-relaxed text-bear"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="h-10 rounded-[6px] border border-accent/30 bg-accent-dim text-[13px] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Ap travay…' : mode === 'create' ? 'Kreye kont' : 'Konekte'}
      </button>

      {canCreate ? (
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'create' ? 'signin' : 'create');
            setError(null);
          }}
          className="text-[12px] text-text-3 underline-offset-4 transition-colors hover:text-text-2 hover:underline"
        >
          {mode === 'create' ? 'Ou gen yon kont deja? Konekte' : 'Kreye yon kont'}
        </button>
      ) : null}
    </form>
  );
}

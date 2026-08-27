'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiBaseUrl } from '@/lib/api-base';

/**
 * Identity control in the command bar.
 *
 * Signed out it is a link; signed in it shows who you are and offers sign-out.
 * Compact by design -- identity frames the terminal and must never compete
 * with the decision, the same rule the rest of the command bar follows.
 */
export function AccountMenu({
  email,
  role,
  displayName,
}: {
  email: string;
  role: 'user' | 'admin';
  displayName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch(`${apiBaseUrl}/v1/auth/logout`, {
        method: 'POST',
        // Required both ways: to send the session cookie, and to accept the
        // cleared one the API sends back.
        credentials: 'include',
      });
    } catch {
      // A failed request still clears local state below. The session row may
      // survive on the server, which is why sign-out is also available from
      // the sessions list.
    } finally {
      setBusy(false);
      router.replace('/signin');
      router.refresh();
    }
  }

  const label = displayName ?? email;

  return (
    <span className="flex items-center gap-2">
      <span className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
        <span className="max-w-[160px] truncate text-[12px] text-text-2">{label}</span>
        {role === 'admin' ? (
          <span className="font-mono text-[10px] tracking-wider text-text-3 uppercase">admin</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="h-8 rounded-md border border-edge px-2.5 text-[12px] text-text-2 transition-colors hover:border-edge-strong hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? '…' : 'Sign out'}
      </button>
    </span>
  );
}

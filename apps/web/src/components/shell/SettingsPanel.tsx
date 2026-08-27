'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { apiBaseUrl } from '@/lib/api-base';
import { IconSettings } from '@/components/ui/icons';

/**
 * The settings surface.
 *
 * This was a disabled button reading "Settings — not implemented yet". The
 * honest label did not make it less of a dead control.
 *
 * What it holds is bounded by what the product can actually change. There is no
 * theme to switch, no locale, no notification preference — inventing those to
 * fill a panel would be the fake version of this fix. What genuinely exists is
 * **account and session management**, backed by endpoints that already ship:
 *
 *   GET  /v1/auth/sessions              the sessions this account holds
 *   POST /v1/auth/sessions/revoke-all   ends every one of them
 *
 * Everything else in the panel is read-only instance state, labelled as such,
 * because "here is what this deployment is configured as" is useful and
 * truthful while a control that pretended to change it would not be.
 */

interface SessionRow {
  readonly id: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly expiresAt: number;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly current: boolean;
}

function when(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

export function SettingsPanel({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) return;
    setState('loading');
    setMessage(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/sessions`, { credentials: 'include' });
      if (!response.ok) {
        // A 429 here is a rate ceiling, not a fault, and saying "failed" would
        // send the reader looking for a problem that does not exist.
        setState('error');
        setMessage(
          response.status === 429
            ? 'Request limit reached — try again shortly.'
            : `Could not load sessions (${response.status}).`,
        );
        return;
      }
      const body = (await response.json()) as { sessions: SessionRow[] };
      setSessions(body.sessions);
      setState('idle');
    } catch {
      setState('error');
      setMessage('Could not reach the API.');
    }
  }, [signedIn]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Escape closes, and focus returns to the button that opened it — otherwise a
  // keyboard user is dropped at the top of the document.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  async function revokeAll(): Promise<void> {
    setState('working');
    setMessage(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/sessions/revoke-all`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        setState('error');
        setMessage(`Could not revoke sessions (${response.status}).`);
        return;
      }
      const body = (await response.json()) as { revoked?: number };
      setState('idle');
      // Ending every session ends this one too, so the page is about to become
      // a signed-out page. Saying so is better than the user discovering it.
      setMessage(
        `${body.revoked ?? 0} session(s) ended, including this one. You will need to sign in again.`,
      );
      await load();
    } catch {
      setState('error');
      setMessage('Could not reach the API.');
    }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Settings"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
          open
            ? 'border-accent/40 bg-accent/10 text-text-1'
            : 'border-edge text-text-3 hover:border-edge-strong hover:text-text-2'
        }`}
      >
        <IconSettings size={15} />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Settings"
          className="panel absolute top-10 right-0 z-40 flex w-[330px] flex-col gap-3 p-3.5"
        >
          <div className="flex flex-col gap-1">
            <p className="telemetry-label">Sessions</p>
            <p className="text-[11px] leading-relaxed text-text-3">
              Every device signed in to this account. Sessions are server-side, so ending one takes
              effect immediately.
            </p>
          </div>

          {!signedIn ? (
            <p className="rounded-[6px] border border-edge bg-surface-2 px-3 py-2.5 text-[12px] text-text-3">
              Sign in to manage sessions.
            </p>
          ) : state === 'loading' ? (
            <p className="text-[12px] text-text-3">Loading…</p>
          ) : sessions && sessions.length > 0 ? (
            <ul className="flex max-h-[190px] flex-col gap-1.5 overflow-y-auto">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-col gap-0.5 rounded-[6px] border border-edge bg-surface-2 px-2.5 py-2"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] text-text-2">
                      {session.userAgent ?? 'Unknown client'}
                    </span>
                    {session.current ? (
                      <span className="shrink-0 rounded-[4px] border border-accent/35 px-1.5 py-px font-mono text-[9px] tracking-wider text-accent uppercase">
                        this one
                      </span>
                    ) : null}
                  </span>
                  <span className="tnum text-[10.5px] text-text-3">
                    {session.ipAddress ?? '—'} · last seen {when(session.lastSeenAt)} · expires{' '}
                    {when(session.expiresAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-text-3">No active sessions.</p>
          )}

          {signedIn ? (
            <button
              type="button"
              onClick={() => void revokeAll()}
              disabled={state === 'working'}
              className="h-8 rounded-[6px] border border-bear/40 bg-bear/10 text-[12px] font-medium text-bear transition-colors hover:bg-bear/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === 'working' ? 'Ending sessions…' : 'Sign out everywhere'}
            </button>
          ) : null}

          {message ? (
            <p role="status" className="text-[11px] leading-relaxed text-text-2">
              {message}
            </p>
          ) : null}

          <div className="flex flex-col gap-1 border-t border-edge pt-2.5">
            <p className="telemetry-label">This deployment</p>
            {/* Read-only on purpose. These are server-side configuration, and a
                control here that appeared to change them would be a lie about
                where the decision lives. */}
            <dl className="flex flex-col gap-1 text-[11px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-3">Execution</dt>
                <dd className="font-mono text-[10px] tracking-wider text-warn uppercase">
                  demo only
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-3">Broker</dt>
                <dd className="text-text-2">None connected</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-3">API</dt>
                <dd className="truncate font-mono text-[10px] text-text-3">{apiBaseUrl}</dd>
              </div>
            </dl>
            <p className="pt-1 text-[10.5px] leading-relaxed text-text-3">
              Instrument, timeframe defaults and worker intervals are set by the server and are not
              editable from the dashboard.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

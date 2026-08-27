'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiBaseUrl } from '@/lib/api-base';
// Type-only, so this does not pull the server-only module into the bundle.
import type { SimulationModelView } from '@/lib/api';

/**
 * Choosing a simulation model.
 *
 * A SELECT, not a form of numbers. The options come from the server catalogue
 * and the request carries an id and nothing else — there is deliberately no
 * field here for a rate, a tie rule or a starting balance, because accepting
 * one would let the client author the accounting model. The API rejects a body
 * containing any of them, so this control cannot quietly grow into doing so.
 *
 * The button being disabled is a convenience, never a control: the selection is
 * validated server-side against the selectable set.
 */
export function ModelSelect({
  models,
  selectedId,
}: {
  models: readonly SimulationModelView[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(selectedId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(next: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/accounts/me/simulation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        // Required: the session lives in an httpOnly cookie.
        credentials: 'include',
        // The id alone. Nothing else is sent, and nothing else would be accepted.
        body: JSON.stringify({ modelId: next === '' ? null : next }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The change was refused (${response.status}).`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="simulation-model"
        className="text-[10px] tracking-[0.14em] text-text-3 uppercase"
      >
        Simulation model
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="simulation-model"
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-[6px] border border-edge-strong bg-surface-2 px-2 text-[12px] text-text-1 disabled:opacity-50"
        >
          {/* "Off" is a real choice, not the absence of one. */}
          <option value="">No simulation</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} v{model.version}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled || value === (selectedId ?? '')}
          onClick={() => void apply(value)}
          className="h-8 shrink-0 rounded-[6px] border border-accent/40 bg-accent/10 px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {disabled ? 'Applying…' : 'Apply'}
        </button>
      </div>
      {error ? <p className="text-[11px] text-bear">{error}</p> : null}
      <p className="text-[10px] leading-relaxed text-text-3">
        Models are defined by BinaryAI and versioned. You choose among them; you cannot set a rate,
        and no rate here comes from a broker.
      </p>
    </div>
  );
}

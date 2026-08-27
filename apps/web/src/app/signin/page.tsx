import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/auth/SignInForm';
import { Surface } from '@/components/ui/primitives';
import { fetchAuthContext } from '@/lib/api';

// Auth state is per-request by definition; a cached one would show the wrong
// person's name after a sign-out.
export const dynamic = 'force-dynamic';

/**
 * Sign-in.
 *
 * Deliberately the only screen in the product that is not the workspace: it
 * borrows the terminal's surfaces and type scale rather than introducing a
 * second visual language for one page.
 *
 * What it will not do is guess. If the API is unreachable, or no database is
 * configured, it says exactly that instead of presenting a form that cannot
 * possibly succeed.
 */
export default async function SignInPage() {
  const context = await fetchAuthContext();

  // Already signed in: nothing to do here.
  if (context.ok && context.data.authenticated) redirect('/');

  return (
    // Sits inside the terminal shell rather than replacing it: the command bar
    // and rail stay, and sign-in occupies the workspace. One visual language.
    <div className="flex min-h-[65vh] items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-[380px] flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="inline-block h-[18px] w-[3px] rounded-full bg-accent shadow-[0_0_10px_var(--accent)]"
            />
            <span className="text-[15px] font-semibold tracking-tight text-text-1">BinaryAI</span>
          </div>
          <p className="text-[13px] leading-relaxed text-text-3">
            Market analysis and decision support. Demo only — BinaryAI places no orders and holds no
            broker connection.
          </p>
        </div>

        <Surface className="p-5">
          {!context.ok ? (
            <p className="text-[12px] leading-relaxed text-warn">
              The API is unreachable, so signing in is not possible right now. {context.error}
            </p>
          ) : !context.data.accountsAvailable ? (
            <p className="text-[12px] leading-relaxed text-warn">
              {context.data.reason ??
                'No database is configured, so user accounts do not exist on this instance.'}
            </p>
          ) : (
            <>
              {context.data.bootstrapOpen ? (
                <p className="mb-4 rounded-[6px] border border-accent/25 bg-accent-dim px-3 py-2 text-[12px] leading-relaxed text-accent">
                  This instance has no accounts yet. The first account you create becomes the
                  administrator.
                </p>
              ) : null}
              <SignInForm
                bootstrapOpen={context.data.bootstrapOpen}
                registrationOpen={context.data.registrationOpen}
              />
            </>
          )}
        </Surface>

        {context.ok && !context.data.authEnabled ? (
          <p className="text-[11px] leading-relaxed text-text-3">
            Authentication is currently disabled (<span className="tnum">AUTH_ENABLED=false</span>),
            so the workspace is reachable without signing in. Signing in still scopes stored signals
            to your account.
          </p>
        ) : null}
      </div>
    </div>
  );
}

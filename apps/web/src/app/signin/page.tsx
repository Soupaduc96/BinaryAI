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
            <span className="flex flex-col gap-[3px] leading-none">
              <span className="text-[9px] font-semibold tracking-[0.18em] text-text-3 uppercase">
                PAD Digital LLC
              </span>
              <span className="text-[16px] font-semibold tracking-tight text-text-1">BinaryAI</span>
            </span>
          </div>
          {/*
           * A real <h1>. Every other route has one through WorkspaceHeader;
           * this page was the exception, which left a keyboard or screen-reader
           * user arriving here with no heading to orient from.
           */}
          <h1 className="page-title">Konekte nan BinaryAI</h1>
          <p className="text-[13px] leading-relaxed text-text-3">
            Analiz mache ak sipò desizyon. Demo sèlman — BinaryAI pa pase okenn lòd epi li pa gen
            okenn koneksyon ak courtier.
          </p>
        </div>

        <Surface variant="primary" className="p-5">
          {!context.ok ? (
            <p className="text-[12px] leading-relaxed text-warn">
              API a enjwenyab, kidonk nou pa ka konekte kounye a. {context.error}
            </p>
          ) : !context.data.accountsAvailable ? (
            <p className="text-[12px] leading-relaxed text-warn">
              {context.data.reason ??
                'Pa gen baz done konfigire, kidonk kont itilizatè pa egziste sou enstans sa a.'}
            </p>
          ) : (
            <>
              {context.data.bootstrapOpen ? (
                <p className="mb-4 rounded-lg border border-accent/30 bg-accent-dim px-3 py-2 text-[12px] leading-relaxed text-accent">
                  Enstans sa a poko gen kont. Premye kont ou kreye a ap vin administratè a.
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
            Otantifikasyon dezaktive kounye a (<span className="tnum">AUTH_ENABLED=false</span>),
            kidonk espas travay la aksesib san konekte. Konekte toujou limite siyal ki anrejistre yo
            ak kont ou.
          </p>
        ) : null}
      </div>
    </div>
  );
}

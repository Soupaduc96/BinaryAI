import { SystemHealthStrip } from '@/components/system/SystemHealthStrip';
import { SystemStatusModule } from '@/components/workspace/RightRail';
import { WorkspaceHeader } from '@/components/shell/WorkspaceHeader';
import { fetchSystemStatus } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * System.
 *
 * Component health and the worker runtime, reported from the API's own status
 * rather than from configuration. The distinction this page exists to preserve:
 * a service that is CONFIGURED is not a service that is WORKING, and an enabled
 * worker that has never completed a cycle is degraded, not healthy.
 */
export default async function SystemPage() {
  const status = await fetchSystemStatus();

  return (
    <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
      <WorkspaceHeader
        eyebrow="Sistèm"
        title="Sistèm"
        lede="Sa k ap kouri toutbon. Chak eta soti nan estati an dirèk API a: konfigire men enjwenyab li li kòm endisponib, epi yon travayè ki poko fini yon sik li li kòm degrade olye ke anliy."
      />

      <SystemStatusModule status={status} />
      <SystemHealthStrip status={status} />
    </div>
  );
}

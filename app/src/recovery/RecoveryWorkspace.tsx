// The `/app` recovery workspace: connected collectors on the left (exact contract
// state copy + auto-heal opt-out), the selected collector's accepted deliveries and
// verified repairs on the right. Polls `/api/recovery/collectors` every 5s, the same
// cadence as the old `/fleet` surface (FleetApp.tsx). Single viewport: header and
// table headers are pinned, only table bodies and the rail scroll.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleNotch, Plus, SignOut } from '@phosphor-icons/react';
import { AddCollectorDialog } from '@/components/fleet/FleetShell';
import { CollectorRail } from './CollectorRail';
import { AcceptedResultsTable, RepairsTable } from './RecoveryTables';
import { WebhookReveal } from './WebhookReveal';
import { usePagedTable } from './usePagedTable';
import {
  ApiError,
  fetchRecoveryCollectors,
  fetchRecoveryDeliveries,
  fetchRecoveryRepairs,
  rotateIngestToken,
  setCollectorAutoHeal,
  type RecoveryCollector,
} from '@/lib/recoveryApi';
import { connectCollector, listAvailableCollectors } from '@/onboarding/api';
import { signOut } from '@/lib/session';

const POLL_INTERVAL_MS = 5000;

interface PendingWebhook {
  collectorName: string;
  webhookUrl: string;
}

export function RecoveryWorkspace() {
  const navigate = useNavigate();
  const [collectors, setCollectors] = useState<RecoveryCollector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const deliveriesLoader = useCallback(
    (collectorId: string, before: string | number | null, limit: number) =>
      fetchRecoveryDeliveries(collectorId, { before, limit }),
    [],
  );
  const repairsLoader = useCallback(
    (collectorId: string, before: string | number | null, limit: number) =>
      fetchRecoveryRepairs(collectorId, { before, limit }),
    [],
  );
  const deliveriesPager = usePagedTable(deliveriesLoader);
  const repairsPager = usePagedTable(repairsLoader);

  const [addingCollector, setAddingCollector] = useState(false);
  const [pendingWebhook, setPendingWebhook] = useState<PendingWebhook | null>(null);
  const [pendingAutoHeal, setPendingAutoHeal] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const pollCollectors = useCallback(async () => {
    try {
      const next = await fetchRecoveryCollectors();
      setCollectors(next);
      setError(null);
      setSelectedId((current) => {
        if (current && next.some((c) => c.collectorId === current)) return current;
        return next[0]?.collectorId ?? null;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void pollCollectors();
    const id = window.setInterval(() => void pollCollectors(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [pollCollectors]);

  useEffect(() => {
    // Selection change (including the first collector auto-selected after the
    // initial poll) resets both tables to page 1. Not re-run on every 5s
    // poll or on a page-size change — the pagers own that state themselves.
    deliveriesPager.reset(selectedId);
    repairsPager.reset(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  const handleToggleAutoHeal = useCallback((collector: RecoveryCollector, enabled: boolean) => {
    setPendingAutoHeal(collector.collectorId);
    setCollectors((current) =>
      current
        ? current.map((c) => (c.collectorId === collector.collectorId ? { ...c, autoHeal: enabled } : c))
        : current,
    );
    void setCollectorAutoHeal(collector.collectorId, enabled)
      .catch(() => {
        // Roll back optimistic flip on failure; the next poll would fix it too,
        // but doing it immediately keeps the toggle honest with the server.
        setCollectors((current) =>
          current
            ? current.map((c) => (c.collectorId === collector.collectorId ? { ...c, autoHeal: !enabled } : c))
            : current,
        );
      })
      .finally(() => setPendingAutoHeal(null));
  }, []);

  const handleAddCollector = useCallback(async (collectorId: string) => {
    const connected = await connectCollector(collectorId);
    setPendingWebhook({ collectorName: connected.name, webhookUrl: connected.deliveryUrl });
    await pollCollectors();
  }, [pollCollectors]);

  const handleRotateToken = useCallback(async (collector: RecoveryCollector) => {
    const { webhookUrl } = await rotateIngestToken(collector.collectorId);
    setPendingWebhook({ collectorName: collector.name, webhookUrl });
  }, []);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      navigate('/', { replace: true });
    } catch {
      setSignOutError('Could not sign you out. Please try again.');
      setSigningOut(false);
    }
  }, [navigate, signingOut]);

  const selected = collectors?.find((c) => c.collectorId === selectedId) ?? null;

  if (error && !collectors) {
    return (
      <main className="flex min-h-[calc(100svh-var(--poly-chrome-offset,0px))] flex-col items-center justify-center gap-4 bg-black/55 p-8 font-sans text-[#EDEDED]">
        <p className="max-w-md text-center text-sm text-red-200">Could not reach the recovery workspace: {error}</p>
      </main>
    );
  }

  if (!collectors) {
    return (
      <main className="flex min-h-[calc(100svh-var(--poly-chrome-offset,0px))] items-center justify-center bg-black/55 font-sans text-[#EDEDED]">
        <p className="font-mono text-sm text-[#9B9B9B]">loading /api/recovery/collectors…</p>
      </main>
    );
  }

  return (
    <div className="flex h-[calc(100svh-var(--poly-chrome-offset,0px))] flex-col bg-black/65 font-sans text-[#EDEDED] backdrop-blur-[2px]">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-[#272727] px-4">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9B9B9B]">Polygraph</span>
        <span className="font-mono text-xs text-[#9B9B9B]">Recovery workspace</span>
        <span
          title="Telegram approvals — coming soon"
          className="ml-auto flex items-center gap-1.5 rounded-full border border-[#313131] bg-[#1B1B1B] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-[#71717A]"
        >
          Telegram approvals — coming soon
        </span>
        <button
          type="button"
          onClick={() => setAddingCollector(true)}
          className="flex h-10 items-center gap-1.5 rounded-lg border border-[#49405d] bg-[#171220] px-3 text-sm font-medium text-[#EDEDED] transition-[background-color,border-color,transform] hover:border-[#8b5cf6] hover:bg-[#211832] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED]"
        >
          <Plus size={16} weight="bold" aria-hidden />
          Add collector
        </button>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-[#9B9B9B] transition-[background-color,color,transform] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EDEDED] disabled:cursor-wait disabled:opacity-70"
        >
          {signingOut ? <CircleNotch size={16} className="animate-spin" aria-hidden /> : <SignOut size={16} aria-hidden />}
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        {signOutError && <span role="alert" className="text-xs text-red-200">{signOutError}</span>}
      </header>

      {error && (
        <p role="alert" className="shrink-0 border-b border-red-400/20 bg-red-400/10 px-4 py-2 text-xs text-red-200">
          Collector list could not refresh: {error}
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4" style={{ gridTemplateColumns: '280px 1fr' }}>
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9B9B9B]">Collectors</h2>
            {selected && (
              <button
                type="button"
                onClick={() => void handleRotateToken(selected)}
                className="font-mono text-[10px] uppercase tracking-wide text-[#818CF8] hover:text-[#A5B4FC]"
              >
                Rotate token
              </button>
            )}
          </div>
          <CollectorRail
            collectors={collectors}
            selectedId={selectedId}
            onSelect={handleSelect}
            onToggleAutoHeal={handleToggleAutoHeal}
            pendingAutoHeal={pendingAutoHeal}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-4">
          <AcceptedResultsTable
            deliveries={deliveriesPager.items}
            loading={deliveriesPager.loading}
            pager={{
              page: deliveriesPager.page,
              pageSize: deliveriesPager.pageSize,
              total: deliveriesPager.total,
              startIndex: deliveriesPager.startIndex,
              hasNext: deliveriesPager.hasNext,
              changing: deliveriesPager.changing,
              onPrev: deliveriesPager.goPrev,
              onNext: deliveriesPager.goNext,
              onPageSizeChange: deliveriesPager.setPageSize,
            }}
          />
          <RepairsTable
            repairs={repairsPager.items}
            loading={repairsPager.loading}
            pager={{
              page: repairsPager.page,
              pageSize: repairsPager.pageSize,
              total: repairsPager.total,
              startIndex: repairsPager.startIndex,
              hasNext: repairsPager.hasNext,
              changing: repairsPager.changing,
              onPrev: repairsPager.goPrev,
              onNext: repairsPager.goNext,
              onPageSizeChange: repairsPager.setPageSize,
            }}
          />
        </div>
      </div>

      {addingCollector && (
        <AddCollectorDialog
          onClose={() => setAddingCollector(false)}
          onAddCollector={handleAddCollector}
          onListCollectors={listAvailableCollectors}
          connectedIds={new Set(collectors.map((c) => c.collectorId))}
        />
      )}
      {pendingWebhook && (
        <WebhookReveal
          collectorName={pendingWebhook.collectorName}
          webhookUrl={pendingWebhook.webhookUrl}
          onClose={() => setPendingWebhook(null)}
        />
      )}
    </div>
  );
}

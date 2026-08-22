import { useCallback, useEffect, useState } from 'react';
import { fetchSessionStatus, type SessionStatus } from '@/lib/session';

/** The session probe both gate routes run. `retry` re-probes; the in-flight
 * result is dropped on unmount so a slow answer can't set state after it. */
export function useSessionStatus() {
  const [status, setStatus] = useState<SessionStatus | 'loading'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void fetchSessionStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, retry };
}

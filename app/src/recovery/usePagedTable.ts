// A small client-side page tracker over the recovery API's keyset ("before"
// cursor) pagination. The server only ever answers "give me the rows before
// cursor X", so Prev can't be a fresh offset query — instead this hook keeps a
// stack of the cursors it used to reach each page it has visited forward, and
// Prev replays the one already known for the previous page. Next pushes the
// server's `next_before` onto the stack before advancing.
import { useCallback, useMemo, useRef, useState } from 'react';

export const DEFAULT_PAGE_SIZE = 25;

export interface PagedResult<T> {
  items: T[];
  nextBefore: string | number | null;
  total: number;
}

export interface PagedTableState<T> {
  items: T[];
  loading: boolean;
  changing: boolean;
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  /** 0-based count of rows before the current page — lets the footer render
   * "Showing a–b of total" from the actual rows seen so far rather than
   * assuming every prior page was exactly `pageSize` long. */
  startIndex: number;
  reset: (collectorId: string | null) => void;
  /** Re-read the visible page without changing its cursor, size, or loading UI.
   * Used by the recovery workspace while Bright Data deliveries arrive. */
  refresh: () => void;
  goNext: () => void;
  goPrev: () => void;
  setPageSize: (size: number) => void;
}

export function usePagedTable<T>(
  loader: (collectorId: string, before: string | number | null, limit: number) => Promise<PagedResult<T>>,
): PagedTableState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSizeState, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState<string | number | null>(null);
  const [startIndex, setStartIndex] = useState(0);

  // cursors[i] is the `before` value that fetches page i+1; cursors[0] is
  // always null (page 1 has no cursor). starts[i] is the 0-based row count
  // before page i+1, computed from the actual row counts already seen — never
  // assumed to be `(page - 1) * pageSize`, since only full pages (usually all
  // but the last) actually hold `pageSize` rows. Both rebuilt from scratch on
  // reset/page-size change.
  const cursors = useRef<Array<string | number | null>>([null]);
  const starts = useRef<number[]>([0]);
  const collectorRef = useRef<string | null>(null);
  const token = useRef(0);

  const load = useCallback(
    async (collectorId: string, targetPage: number, size: number, mode: 'initial' | 'changing' | 'background') => {
      const myToken = ++token.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'changing') setChanging(true);
      try {
        const before = cursors.current[targetPage - 1] ?? null;
        const result = await loader(collectorId, before, size);
        if (myToken !== token.current) return;
        starts.current[targetPage] = (starts.current[targetPage - 1] ?? 0) + result.items.length;
        setItems(result.items);
        setTotal(result.total);
        setNextBefore(result.nextBefore);
        setStartIndex(starts.current[targetPage - 1] ?? 0);
        setPage(targetPage);
      } catch {
        if (myToken !== token.current) return;
        // A transient polling failure must not erase the last accepted rows or
        // kick an operator back to page one. Selection/page changes still keep
        // the established empty-state behaviour.
        if (mode !== 'background') {
          setItems([]);
          setTotal(0);
          setNextBefore(null);
          setStartIndex(0);
          setPage(1);
        }
      } finally {
        if (myToken === token.current) {
          if (mode === 'initial') setLoading(false);
          if (mode === 'changing') setChanging(false);
        }
      }
    },
    [loader],
  );

  const reset = useCallback(
    (collectorId: string | null) => {
      collectorRef.current = collectorId;
      cursors.current = [null];
      starts.current = [0];
      if (!collectorId) {
        ++token.current;
        setItems([]);
        setTotal(0);
        setNextBefore(null);
        setStartIndex(0);
        setPage(1);
        setLoading(false);
        setChanging(false);
        return;
      }
      void load(collectorId, 1, pageSizeState, 'initial');
    },
    [load, pageSizeState],
  );

  const refresh = useCallback(() => {
    const collectorId = collectorRef.current;
    if (!collectorId) return;
    void load(collectorId, page, pageSizeState, 'background');
  }, [load, page, pageSizeState]);

  const goNext = useCallback(() => {
    const collectorId = collectorRef.current;
    if (!collectorId || nextBefore == null) return;
    cursors.current[page] = nextBefore;
    void load(collectorId, page + 1, pageSizeState, 'changing');
  }, [load, nextBefore, page, pageSizeState]);

  const goPrev = useCallback(() => {
    const collectorId = collectorRef.current;
    if (!collectorId || page <= 1) return;
    void load(collectorId, page - 1, pageSizeState, 'changing');
  }, [load, page, pageSizeState]);

  const setPageSize = useCallback(
    (size: number) => {
      const collectorId = collectorRef.current;
      setPageSizeState(size);
      cursors.current = [null];
      starts.current = [0];
      if (!collectorId) return;
      void load(collectorId, 1, size, 'changing');
    },
    [load],
  );

  return useMemo(
    () => ({
      items,
      loading,
      changing,
      page,
      pageSize: pageSizeState,
      total,
      hasNext: nextBefore != null,
      startIndex,
      reset,
      refresh,
      goNext,
      goPrev,
      setPageSize,
    }),
    [items, loading, changing, page, pageSizeState, total, nextBefore, startIndex, reset, refresh, goNext, goPrev, setPageSize],
  );
}

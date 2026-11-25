import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkerHistoryKind,
  WorkerHistoryNotification,
  WorkerHistoryPage,
  WorkerOverviewSnapshot,
} from "../shared/contracts.js";

export type {
  WorkerHistoryKind,
  WorkerHistoryNotification,
  WorkerHistoryPage,
  WorkerOverviewSnapshot,
};

/** Terminal statuses are not activity; everything else keeps a task in the running region. */
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** True while a record still belongs to the running region of the overview. */
export function isActiveWorker(worker: {
  latestRun: { status: string } | null;
}): boolean {
  const status = worker.latestRun?.status;
  return status !== undefined && !TERMINAL.has(status);
}

/** The run status shown for a record that has no run yet (it is still queued). */
export function workerStatus(worker: {
  latestRun: { status: string } | null;
}): string {
  return worker.latestRun?.status ?? "queued";
}

/**
 * Title displayed for a worker row or card: the shown run's own requirement title, falling back
 * to the worker's original task name for runs recorded before titles were stored per run.
 */
export function displayTaskName(
  worker: { taskName: string },
  run: { taskName?: string } | null | undefined,
): string {
  return run?.taskName ?? worker.taskName;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Merges one server page into the rows already on screen. A worker/notification appears once:
 * refreshed rows replace their old copy while older loaded pages survive, so a first page that
 * shifts under polling can never create a gap or a duplicate. Ordering is the server's contract:
 * finish/creation time descending, then id descending (SQLite BINARY) as the unique tie-break.
 */
export function mergeHistoryPage<T extends { id: string }>(
  current: T[],
  page: T[],
  timeOf: (item: T) => string,
): T[] {
  if (!page.length) return current;
  const merged = new Map<string, T>();
  for (const item of current) merged.set(item.id, item);
  for (const item of page) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => {
    const delta = timestamp(timeOf(b)) - timestamp(timeOf(a));
    return delta !== 0 ? delta : b.id.localeCompare(a.id);
  });
}

/** Drops a worker that resumed, so its old terminal row cannot coexist with its active card. */
export function withoutResumedWorkers<T extends { id: string }>(
  items: T[],
  activeIds: Set<string>,
): T[] {
  if (!activeIds.size) return items;
  return items.filter((item) => !activeIds.has(item.id));
}

type HistoryState<T> = {
  identity: string;
  items: T[];
  cursor: string | null;
  /** A page beyond the overview's first page was requested; later polls must not rewind it. */
  paged: boolean;
  loading: boolean;
  error: string;
  /** Bumped when a detached first page rebuilds the window; late pages carry the old value. */
  generation: number;
};

const EMPTY_HISTORY = {
  identity: "",
  items: [] as never[],
  cursor: null,
  paged: false,
  loading: false,
  error: "",
  generation: 0,
};

/**
 * One independently paged history table. The overview supplies the first page (and keeps it
 * fresh while polling); `loadMore` reads the next page only when that table reaches its bottom.
 * Loaded pages are retained, scope switches clear the table, and a response for a superseded
 * scope/key is ignored.
 */
export function useHistoryFeed<T extends { id: string }>({
  identity,
  page,
  timeOf,
  request,
  exclude,
}: {
  identity: string;
  page: WorkerHistoryPage<T> | null | undefined;
  timeOf: (item: T) => string;
  request: (cursor: string) => Promise<WorkerHistoryPage<T>>;
  /** Ids that left this history (for example a worker that resumed) and must be dropped. */
  exclude?: Set<string>;
}) {
  const [state, setState] = useState<HistoryState<T>>(
    EMPTY_HISTORY as HistoryState<T>,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef(request);
  requestRef.current = request;
  const timeRef = useRef(timeOf);
  timeRef.current = timeOf;
  const excludeRef = useRef(exclude);
  excludeRef.current = exclude;
  useEffect(() => {
    if (!page || !Array.isArray(page.items)) return;
    setState((previous) => {
      const current =
        previous.identity === identity
          ? previous
          : ({ ...EMPTY_HISTORY, identity } as HistoryState<T>);
      // Overlap is by the server's full sort key, not id alone: a worker that finished again
      // keeps its id but moves with a new finishedAt. A cached row is only the same row when
      // both time and id match (legacy rows without a time still match on id + empty time).
      const known = new Map(
        current.items.map((item) => [item.id, timeOf(item)]),
      );
      const overlaps = page.items.some(
        (item) => known.has(item.id) && known.get(item.id) === timeOf(item),
      );
      // A cached window that shares no sort key with the polled first page has a hole between
      // them: the server pushed more rows than the window can bridge, or retention cleared an
      // empty page. Rebuild from this first page; the generation bump retires any older request.
      if (current.items.length > 0 && !overlaps) {
        const items = exclude?.size
          ? withoutResumedWorkers(page.items, exclude)
          : page.items;
        return {
          identity,
          items,
          cursor: page.nextCursor ?? null,
          paged: false,
          loading: false,
          error: "",
          generation: current.generation + 1,
        };
      }
      let items = mergeHistoryPage(current.items, page.items, timeOf);
      if (exclude?.size) items = withoutResumedWorkers(items, exclude);
      // The overview cursor only applies until an older page was read; that cursor is deeper.
      const cursor = current.paged ? current.cursor : page.nextCursor;
      return { ...current, items, cursor };
    });
    // `timeOf`/`exclude` are read through refs; only a new overview page is a real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, page]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.identity !== identity || current.loading || !current.cursor)
      return;
    const cursor = current.cursor;
    const generation = current.generation;
    setState((value) =>
      value.identity === identity ? { ...value, loading: true, error: "" } : value,
    );
    void requestRef
      .current(cursor)
      .then((next) => {
        setState((value) => {
          if (value.identity !== identity || value.generation !== generation)
            return value;
          let items = mergeHistoryPage(value.items, next.items, timeRef.current);
          if (excludeRef.current?.size)
            items = withoutResumedWorkers(items, excludeRef.current);
          return {
            ...value,
            items,
            cursor: next.nextCursor,
            paged: true,
            loading: false,
            error: "",
          };
        });
      })
      .catch((caught) => {
        setState((value) =>
          value.identity === identity && value.generation === generation
            ? { ...value, loading: false, error: String(caught) }
            : value,
        );
      });
  }, [identity]);

  /** Applies a change to one loaded row without disturbing pages, cursor or scroll position. */
  const update = useCallback(
    (id: string, change: (item: T) => T) => {
      setState((value) =>
        value.identity === identity
          ? {
              ...value,
              items: value.items.map((item) =>
                item.id === id ? change(item) : item,
              ),
            }
          : value,
      );
    },
    [identity],
  );

  const ready = state.identity === identity;
  // Exclusion also applies at render time: the mount effect below runs after the commit that
  // makes a worker active, so relying on it alone would show one frame where a resumed worker
  // sits in both the live list and the finished table.
  const visible = ready ? state.items : ([] as T[]);
  return {
    items:
      exclude?.size && visible.length
        ? withoutResumedWorkers(visible, exclude)
        : visible,
    nextCursor: ready ? state.cursor : null,
    loading: ready ? state.loading : false,
    error: ready ? state.error : "",
    loadMore,
    update,
  };
}

/** Remaining milliseconds until the global agy cooldown deadline; null when unknown/over. */
export function cooldownRemaining(
  deadline: string | null | undefined,
  now: number,
): number | null {
  if (!deadline) return null;
  const at = Date.parse(deadline);
  if (!Number.isFinite(at) || at <= now) return null;
  return at - now;
}

/**
 * True when the given scroll box has reached its bottom. Tables request their own next page
 * only from this check, so an idle table never walks the whole history.
 */
export function atScrollBottom(node: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 16;
}

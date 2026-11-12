import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";

import type { schedulerApi } from "./api.js";
import { STAGE_LOG_DEFAULT_LIMIT } from "../shared/contracts.js";
import type { StageLogEntry, StageLogPage } from "../shared/contracts.js";

type StageApi = Pick<ReturnType<typeof schedulerApi>, "stageLogs">;

type StageLogTableProps = {
  api: StageApi;
  taskId: string;
  /** Closes the panel; the caller owns which task (if any) has its stage log open. */
  onClose: () => void;
};

/** Refresh period of the live (newest) page. */
const LOG_POLL_MS = 5000;

/** Local wall-clock rendering of a host timestamp; the host stores UTC. */
function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("zh-CN", { hour12: false });
}

/** Structured detail as-is: shown read-only, never interpreted as markup. */
function formatData(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  // The host parsed this from JSON already, so it cannot hold a cycle or a BigInt.
  return JSON.stringify(data, null, 2);
}

/**
 * Stage log of one resident task, shown as a table under its row: one line per entry, which is
 * what an operator scans ("deployed staging", "test suite failed"). It is informational only —
 * nothing here is a terminal run or the task's state.
 *
 * The newest page polls by replacing itself; paging to older entries stops polling so a history
 * view cannot shift under the reader, and "回到最新" resumes it.
 */
export function StageLogTable({ api, taskId, onClose }: StageLogTableProps) {
  // Null = following the newest page; a string is the cursor of the history page being read.
  const [cursor, setCursor] = useState<string | null>(null);
  // Rows currently shown: the newest page, or the newest page plus the older pages read so far.
  const [logs, setLogs] = useState<StageLogEntry[]>([]);
  // Cursor of the next, older page; null when the host has no further entries.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // First load of a page (the initial spinner, not background refreshes).
  const [loading, setLoading] = useState(true);
  // Reading one older page, which disables the control instead of racing itself.
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Last failure, shown with a retry control; cleared by the next attempt.
  const [error, setError] = useState<string | null>(null);
  // Identifies the newest request, so a response that lost the race (task switched, panel closed,
  // user paged elsewhere) is dropped instead of overwriting the visible table.
  const requestSeqRef = useRef(0);
  // The request the retry control repeats, so a failed older-page read is not turned into a
  // duplicate append of a page that already loaded.
  const lastAttemptRef = useRef<string | null>(null);
  // Whether this panel is still mounted; a stale response must not touch state after cleanup.
  const mountedRef = useRef(true);

  const fetchPage = useCallback(
    async (at: string | null) => {
      const seq = ++requestSeqRef.current;
      lastAttemptRef.current = at;
      if (at) setLoadingOlder(true);
      setError(null);
      try {
        const page = await api.stageLogs(taskId, { ...(at ? { cursor: at } : {}), limit: STAGE_LOG_DEFAULT_LIMIT });
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        const next: StageLogPage = page ?? { logs: [], nextCursor: null };
        // A newest-page refresh replaces the rows; paging older appends, so neither path can
        // duplicate entries the way an append-poll would.
        setLogs((previous) => (at ? [...previous, ...next.logs] : next.logs));
        setNextCursor(next.nextCursor ?? null);
        setCursor(at);
      } catch (fetchError) {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      } finally {
        if (mountedRef.current && seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingOlder(false);
        }
      }
    },
    [api, taskId],
  );

  /** Switches to an older page before the request starts, so the live poll cannot interleave. */
  const openOlderPage = useCallback((at: string) => {
    setCursor(at);
    void fetchPage(at);
  }, [fetchPage]);

  /** Returns to the newest page and resumes polling immediately, then refreshes its rows. */
  const returnToLatest = useCallback(() => {
    setCursor(null);
    void fetchPage(null);
  }, [fetchPage]);

  useEffect(() => {
    mountedRef.current = true;
    // A different task (or a fresh mount) starts from the newest page, never from the previous
    // task's cursor or rows.
    setLogs([]);
    setCursor(null);
    setNextCursor(null);
    setLoading(true);
    void fetchPage(null);
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
    };
  }, [fetchPage]);

  useEffect(() => {
    // Only the live page polls: an older page is a fixed history view the user asked for.
    if (cursor !== null) return;
    const timer = setInterval(() => { void fetchPage(null); }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [cursor, fetchPage]);

  const columnCount = 7;

  return (
    <div className="cron-stage-log" aria-label={`阶段日志 ${taskId}`}>
      <header className="cron-stage-log-head">
        <div>
          <strong>阶段日志</strong>
          <small className="cron-resident-note">仅保留最近 7 天；此处是任务自身的记录，不代表任务状态。</small>
        </div>
        <div className="cron-stage-log-actions">
          {cursor !== null && <button type="button" onClick={returnToLatest}>回到最新</button>}
          <button type="button" aria-label="刷新阶段日志" title="刷新阶段日志" onClick={returnToLatest}>
            <RefreshCw size={14} />
          </button>
          <button type="button" aria-label="关闭阶段日志" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="cron-stage-log-scroll">
        <table className="cron-stage-log-table">
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">阶段</th>
              <th scope="col">状态</th>
              <th scope="col">日志内容</th>
              <th scope="col">来源</th>
              <th scope="col">添加时间</th>
              <th scope="col">详情</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={columnCount} role="alert">
                  {error}
                  <button type="button" onClick={() => void fetchPage(lastAttemptRef.current)}>重试</button>
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={columnCount}>正在读取阶段日志…</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={columnCount}>这个任务还没有阶段日志。</td>
              </tr>
            ) : (
              logs.map((entry) => {
                const data = formatData(entry.data);
                return (
                  <tr key={entry.id} data-stage-log-row={entry.id}>
                    <td>
                      <time dateTime={entry.occurredAt} className="cron-stage-log-time">
                        {formatTime(entry.occurredAt)}
                      </time>
                    </td>
                    <td className="cron-stage-log-phase">{entry.phase || "—"}</td>
                    <td className="cron-stage-log-status">{entry.status}</td>
                    <td className="cron-stage-log-content">{entry.content}</td>
                    <td className="cron-stage-log-source">
                      {entry.source === "system" ? "系统" : "Agent"}
                    </td>
                    <td>
                      <time dateTime={entry.createdAt} className="cron-stage-log-time">
                        {formatTime(entry.createdAt)}
                      </time>
                    </td>
                    <td className="cron-stage-log-detail">
                      {data ? (
                        <details>
                          <summary>展开</summary>
                          <pre className="cron-stage-log-data">{data}</pre>
                        </details>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {cursor !== null && (
        <p className="cron-resident-note">正在查看较早的阶段日志（自动刷新已暂停）。</p>
      )}
      {nextCursor && !error && (
        <button type="button" disabled={loadingOlder} onClick={() => openOlderPage(nextCursor)}>
          {loadingOlder ? "正在加载更早日志…" : "加载更早日志"}
        </button>
      )}
    </div>
  );
}

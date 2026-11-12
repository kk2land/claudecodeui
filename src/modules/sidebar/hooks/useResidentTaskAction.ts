import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { useProviderCapabilities } from '@/shared/hooks/useProviderCapabilities';
import type {
  LLMProvider,
  ProjectSession,
  ResidentSessionInfo,
} from '@/shared/types';

/**
 * What the session menu needs to render its resident ("设为常驻") entry, and to act on it.
 * `bound` is true exactly when a binding exists, which is also the protection marker the server
 * reports, so a disabled or hidden binding must never look adoptable again.
 */
export type ResidentTaskAction = {
  /** Whether the entry belongs in the menu at all; false for providers without the capability. */
  available: boolean;
  bound: boolean;
  disabled: boolean;
  label: string;
  /** Why the entry is greyed out, or the last adoption failure; null when there is nothing to say. */
  description: string | null;
  pending: boolean;
  adopt: () => Promise<void>;
};

type ResidentTaskActionInput = {
  session: ProjectSession;
  provider: LLMProvider;
  /** A running foreground turn is the only adoptable state; idle sessions are greyed, not hidden. */
  isProcessing: boolean;
};

/** Messages for the server's adoption refusals, which are answers rather than errors. */
const BLOCKED_REASON_LABELS: Record<NonNullable<ResidentSessionInfo['blockedReason']>, string> = {
  already_resident: '已设为常驻',
  not_running: '会话当前没有正在运行的任务',
  unsupported_provider: '该 Agent 不支持常驻任务',
  plugin_unavailable: '常驻任务插件不可用',
};

/** Reads the plugin RPC refusal envelope so the menu shows the server's own reason. */
async function readAdoptionError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: string | { message?: string; code?: string } }
    | null;
  const detail = body?.error;
  const message = typeof detail === 'string' ? detail : detail?.message;
  if (message) return message;
  return `设为常驻失败（HTTP ${response.status}）`;
}

/**
 * Owns the sidebar's resident adoption entry for one session row. Used by SessionOptions (the
 * desktop three-dot menu) and by the mobile session sheet in SidebarSessionItem, so both show the
 * same state from the same rule and neither re-derives the server's eligibility.
 */
export function useResidentTaskAction({
  session,
  provider,
  isProcessing,
}: ResidentTaskActionInput): ResidentTaskAction {
  const capabilities = useProviderCapabilities();
  const serverResident: ResidentSessionInfo | null = session.resident ?? null;
  // Local echo of a successful adoption, which is a real server-confirmed binding. It covers the
  // window before the session projection is refetched, and is cleared as soon as the server
  // reports a binding of its own so the server stays the single authority.
  const [adoptedTaskId, setAdoptedTaskId] = useState<string | null>(null);
  // Last refusal or failure, shown inside the menu so a click never fails silently.
  const [error, setError] = useState<string | null>(null);
  // Set while an adoption request is in flight, which also blocks a second click.
  const [pending, setPending] = useState(false);
  // Whether the server has already reported a real binding for this row, which is what makes a
  // later "unbound" projection a trustworthy release of the local confirmation (task deleted)
  // rather than a stale list snapshot from before the adoption landed.
  const serverConfirmedBindingRef = useRef(false);

  useEffect(() => {
    const serverTaskId = serverResident?.taskId ?? null;
    if (serverTaskId) {
      // Server owns the binding; the local confirmation has served its purpose.
      serverConfirmedBindingRef.current = true;
      setAdoptedTaskId(null);
      return;
    }
    if (serverResident && serverConfirmedBindingRef.current) {
      // The binding the server told us about is gone (task removed), so the menu must be able to
      // offer adoption again instead of claiming the session is still resident.
      setAdoptedTaskId(null);
    }
  }, [serverResident]);

  const providerSupportsResidentTasks = Boolean(capabilities[provider]?.supportsResidentTasks);
  const bound = Boolean(serverResident?.taskId) || adoptedTaskId !== null;
  const blockedReason = serverResident?.blockedReason ?? null;
  /**
   * Adoption needs all three: a provider the capability matrix admits, a genuinely running
   * foreground turn (background-only work is not a takeover-able run), and a server answer that
   * does not forbid it.
   *
   * `blockedReason === 'not_running'` is a snapshot from whenever the session list was read; a
   * session that has started running since then is exactly the normal list→live transition, so it
   * reads as adoptable once `isProcessing` says the turn is real. Every other refusal
   * (`already_resident`, `unsupported_provider`, `plugin_unavailable`) is permanent for the
   * current state and stays greyed. With no projection at all the entry stays unavailable rather
   * than guessing.
   */
  const permanentlyBlocked = blockedReason === 'already_resident'
    || blockedReason === 'unsupported_provider'
    || blockedReason === 'plugin_unavailable';
  const serverAllows = serverResident !== null
    && (serverResident.adoptable || blockedReason === 'not_running');
  const adoptable = providerSupportsResidentTasks
    && isProcessing
    && !bound
    && !permanentlyBlocked
    && serverAllows;
  const available = bound || providerSupportsResidentTasks;
  const refusalReason = permanentlyBlocked ? blockedReason : null;

  const adopt = useCallback(async () => {
    if (pending || bound || !adoptable) return;
    setPending(true);
    setError(null);
    try {
      const response = await api.plugins.adoptResidentSession(session.id);
      if (!response.ok) {
        setError(await readAdoptionError(response));
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | { task?: { taskId?: string } }
        | null;
      // Adoption never starts, stops or interrupts the run and never sends a prompt; the only
      // effect here is that the menu now reports the confirmed binding.
      setAdoptedTaskId(body?.task?.taskId ?? 'adopted');
    } catch (adoptError) {
      setError(adoptError instanceof Error ? adoptError.message : '设为常驻失败');
    } finally {
      setPending(false);
    }
  }, [adoptable, bound, pending, session.id]);

  const description = error
    ?? (bound
      ? '该会话已由常驻任务接管，可继续在前台聊天'
      : !providerSupportsResidentTasks
        ? BLOCKED_REASON_LABELS.unsupported_provider
        : refusalReason
          ? BLOCKED_REASON_LABELS[refusalReason]
          : !isProcessing
            ? BLOCKED_REASON_LABELS.not_running
            : // The projection has not arrived yet; nothing is claimed until it does.
              serverResident === null
              ? '正在等待会话状态'
              : null);

  return {
    available,
    bound,
    disabled: bound || !adoptable || pending,
    label: bound ? '已设为常驻' : '设为常驻',
    description,
    pending,
    adopt,
  };
}

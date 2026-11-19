import { useCallback, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import { createUuid } from '@/shared/utils';
import type {
  CodexApprovedPlan,
  LLMProvider,
  PermissionMode,
  Project,
  SessionEstablishedContext,
} from '@/shared/types';

type PlanHandoffArgs = {
  /** True only for native Codex app-server transcripts that advertise `planHandoff`. */
  enabled: boolean;
  project: Project | null;
  sendMessage(message: unknown): void;
  onSessionEstablished(sessionId: string, context: SessionEstablishedContext): void;
  /**
   * Application session whose transcript produced the plan. Together with the
   * exact plan body it identifies a completed handoff, so a repeat click can
   * reopen the existing target instead of allocating another session.
   */
  sourceSessionId: string | null;
  /**
   * Navigates to a target that already runs this plan. The hook only remembers
   * a completed handoff while this callback exists, because a remembered target
   * must be reachable rather than silently swallowed.
   */
  onOpenSession?(sessionId: string): void;
  onSessionProcessing?(sessionId: string, activity: { statusText: string | null; canInterrupt: boolean }): void;
  /** Prompt the new session starts with; the approved plan itself travels in `approvedPlan`. */
  content: string;
  /** Model, effort and permission chosen in the source composer, carried to the new target. */
  model: string;
  effort: string;
  permissionMode: PermissionMode;
  resolvePermissionModeForProvider(provider: LLMProvider, mode: PermissionMode | string): PermissionMode;
  /** Concrete native route of the source thread; omitted when the selection names no real model. */
  modelSelection?: NonNullable<CodexApprovedPlan['modelSelection']>;
};

type CreateSessionBody = {
  data?: { sessionId?: unknown; sessionName?: unknown };
  error?: { message?: unknown };
  message?: unknown;
};

const readFailureMessage = (body: CreateSessionBody | null, status: number): string => {
  const error = body?.error?.message;
  if (typeof error === 'string' && error) return error;
  const message = body?.message;
  return typeof message === 'string' && message ? message : `HTTP ${status}`;
};

/**
 * Identity of one handoff attempt: the source session plus the plan body exactly
 * as shown. A revised plan or another source session is a different key, so it
 * still starts its own target; identical text from the same session is reused.
 */
const planHandoffKey = (sourceSessionId: string | null, markdown: string): string =>
  `${sourceSessionId ?? ''}\u0000${markdown}`;

/**
 * Used by chat's ChatInterface to implement an approved plan in a brand-new
 * Codex session.
 *
 * The source composer is never touched: no draft, attachment, todo or queued
 * message is cleared or sent, because the target is allocated through the
 * session gateway and receives exactly one explicit `chat.send`. The target's
 * native user echo is what appears in its transcript, and a refused send is
 * reported on the target by the existing realtime protocol-error path.
 *
 * A handoff is remembered only after its target received that one send, and
 * only for this page: clicking the same plan again navigates to that target
 * through `onOpenSession` instead of creating, processing or sending anything
 * twice. Nothing is persisted and no other tab or session history is involved.
 */
export function usePlanHandoff({
  enabled,
  project,
  sendMessage,
  onSessionEstablished,
  onSessionProcessing,
  sourceSessionId,
  onOpenSession,
  content,
  model,
  effort,
  permissionMode,
  resolvePermissionModeForProvider,
  modelSelection,
}: PlanHandoffArgs) {
  // A repeated click must not allocate a second session while the gateway call is in flight.
  const [pending, setPending] = useState(false);
  // Guards against two clicks in the same tick, before the state update renders.
  const inFlightRef = useRef(false);
  // Completed handoffs of this page, keyed by source session and exact plan body,
  // holding the target to reopen. State rather than a ref so the toolbar can
  // relabel its entry once a plan has a target; it is never persisted.
  const [handedOffPlans, setHandedOffPlans] = useState<ReadonlyMap<string, string>>(() => new Map());

  const implementInNewSession = useCallback(async ({ markdown }: { markdown: string }) => {
    if (!enabled || inFlightRef.current) return;
    // A plan that already reached a target only needs navigation: no second
    // target, establishment, processing mark or `chat.send`.
    const handedOffTarget = handedOffPlans.get(planHandoffKey(sourceSessionId, markdown));
    if (handedOffTarget) {
      onOpenSession?.(handedOffTarget);
      return;
    }
    const projectPath = project?.fullPath || project?.path || '';
    if (!project || !projectPath) throw new Error('Choose a project before implementing the plan.');

    inFlightRef.current = true;
    setPending(true);
    try {
      const response = await api.providers.createSession({
        provider: 'codex',
        projectPath,
        // The plan names the new conversation; its prompt is the implement message below.
        initialMessage: markdown,
      });
      const body = await response.json().catch(() => null) as CreateSessionBody | null;
      const targetSessionId = body?.data?.sessionId;
      if (!response.ok || typeof targetSessionId !== 'string' || !targetSessionId) {
        throw new Error(readFailureMessage(body, response.status));
      }

      const returnedName = typeof body?.data?.sessionName === 'string' ? body.data.sessionName.trim() : '';
      onSessionEstablished(targetSessionId, {
        provider: 'codex',
        project,
        ...(returnedName ? { summary: returnedName } : {}),
      });

      const toolsSettings = readUserPreference(
        PROVIDER_PERMISSION_PREFERENCE_KEYS.codex,
        { allowedTools: [], disallowedTools: [], skipPermissions: false },
      );
      onSessionProcessing?.(targetSessionId, { statusText: null, canInterrupt: true });
      // Exactly one send, to the id the gateway returned. `approvedPlan` carries
      // the plan text verbatim, so the runtime never has to reconstruct it.
      sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content,
        options: {
          collaborationMode: 'default',
          model,
          effort,
          permissionMode: resolvePermissionModeForProvider('codex', permissionMode),
          toolsSettings,
          skipPermissions: toolsSettings?.skipPermissions || false,
          clientMessageId: createUuid(),
          approvedPlan: {
            markdown,
            ...(modelSelection ? { modelSelection } : {}),
          },
        },
      });
      // Recorded after the send, so a failed creation or dispatch stays retryable.
      if (onOpenSession) {
        const key = planHandoffKey(sourceSessionId, markdown);
        setHandedOffPlans((plans) => new Map(plans).set(key, targetSessionId));
      }
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  }, [
    content,
    effort,
    enabled,
    handedOffPlans,
    model,
    modelSelection,
    onOpenSession,
    onSessionEstablished,
    onSessionProcessing,
    permissionMode,
    project,
    resolvePermissionModeForProvider,
    sendMessage,
    sourceSessionId,
  ]);

  /** Target already running a plan with this body for the current source, or null. */
  const handedOffSessionIdFor = useCallback(
    ({ markdown }: { markdown: string }): string | null =>
      handedOffPlans.get(planHandoffKey(sourceSessionId, markdown)) ?? null,
    [handedOffPlans, sourceSessionId],
  );

  return { enabled, pending, implementInNewSession, handedOffSessionIdFor };
}

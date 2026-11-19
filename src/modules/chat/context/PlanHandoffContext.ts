import { createContext, useContext } from 'react';

/** The newest fully generated plan of the open conversation, with the session it belongs to so a failure can stay scoped to it. */
type PlanHandoffLatestPlan = {
  sourceSessionId: string | null;
  markdown: string;
};

/**
 * Starts a new Codex session that executes an approved plan.
 *
 * ChatInterface owns the only provider of this context; CodexControlPanel
 * consumes it so the composer toolbar can hand the latest complete plan across
 * the module without threading props through the composer. `latestPlan` is
 * already gated on native support, plan mode, an idle transcript and a
 * finished plan, so a consumer only decides whether to show its entry. A null
 * context means the current provider/runtime cannot hand a plan off natively.
 */
type PlanHandoffContextValue = {
  /**
   * Resolves after the new target session received its one `chat.send`; rejects
   * when no target could be created. Repeating the same plan after a successful
   * handoff only reopens the recorded target and creates nothing.
   */
  implementInNewSession(request: { markdown: string }): Promise<void>;
  /** True while a handoff is being dispatched, so the toolbar cannot start a duplicate session. */
  pending: boolean;
  /** Newest complete plan after the last context clear, or null when there is nothing safe to implement. */
  latestPlan: PlanHandoffLatestPlan | null;
  /**
   * Session id that already executes `latestPlan` from this page, or null while
   * it has no target. The toolbar opens it instead of offering another creation.
   */
  handedOffTargetSessionId: string | null;
};

const PlanHandoffContext = createContext<PlanHandoffContextValue | null>(null);

/** The composer toolbar reads the handoff capability; transcripts outside the provider get null. */
export function usePlanHandoff(): PlanHandoffContextValue | null {
  return useContext(PlanHandoffContext);
}

export default PlanHandoffContext;

import { createContext, useContext } from 'react';

import type { ToolPermissionDecision, PendingPermissionRequest } from '@/shared/types';

type PermissionContextValue = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: ToolPermissionDecision,
  ) => void;
};

const PermissionContext = createContext<PermissionContextValue | null>(null);

/** Chat tool renderers read the current approval requests and response handler. */
export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;

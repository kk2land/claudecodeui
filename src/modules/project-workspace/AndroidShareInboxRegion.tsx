import { AndroidShareInbox } from '@/modules/android-bridge';
import { useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';

/** Rendered by ProjectWorkspaceShell to mount the Android share inbox inside the signed-in workspace. */
export default function AndroidShareInboxRegion() {
  const { projects, selectedSession, onSessionSelect } = useProjectSidebarState().sidebarSharedProps;
  const { setActiveTab } = useProjectMainState();

  return (
    <AndroidShareInbox
      projects={projects}
      currentSession={selectedSession}
      onOpenSession={(session) => {
        setActiveTab('chat');
        onSessionSelect(session);
      }}
    />
  );
}

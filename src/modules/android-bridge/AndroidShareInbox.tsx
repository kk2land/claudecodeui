import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { DownloadIcon, Share2Icon, Trash2Icon } from 'lucide-react';

import { getAndroidBridge } from '@/modules/android-bridge/androidBridge';
import { useAndroidShares } from '@/modules/android-bridge/hooks/useAndroidShares';
import {
  cancelAndroidShareInsertion,
  clearAndroidShareInsertionError,
  enqueueAndroidShareInsertion,
  subscribeAndroidShareInsertionError,
} from '@/modules/android-bridge/shareInsertion';
import type { AndroidShare, Project, ProjectSession } from '@/shared/types';

type AndroidShareInboxProps = {
  projects: Project[];
  currentSession: ProjectSession | null;
  onOpenSession: (session: ProjectSession) => void;
};

const describeShare = (share: AndroidShare, t: TFunction): string => {
  if (share.kind === 'text' || share.kind === 'link') {
    return share.text?.trim()
      || t(`androidShare.${share.kind === 'link' ? 'sharedLink' : 'sharedText'}`, {
        defaultValue: share.kind === 'link' ? 'Shared link' : 'Shared text',
      });
  }
  return share.name
    || t(`androidShare.${share.kind === 'image' ? 'sharedImage' : 'sharedFile'}`, {
      defaultValue: share.kind === 'image' ? 'Shared image' : 'Shared file',
    });
};

/**
 * Rendered by the project workspace as a small floating inbox for system shares
 * imported by the Android app. Import only queues the share for the target
 * composer; nothing is ever sent or queued as a chat message here.
 */
export function AndroidShareInbox({ projects, currentSession, onOpenSession }: AndroidShareInboxProps) {
  const { t } = useTranslation('common');
  const bridge = getAndroidBridge();
  const { shares } = useAndroidShares();
  // Session the user explicitly chose; an empty value follows the open session.
  const [chosenSessionId, setChosenSessionId] = useState('');
  // Insertion failures are shown here because the composer has no global toast.
  const [insertionError, setInsertionError] = useState<string | null>(null);
  // Inbox-local validation or discard failures, kept separate from composer errors.
  const [localError, setLocalError] = useState<string | null>(null);
  // The share currently being discarded, so only that row shows a busy state.
  const [discardingId, setDiscardingId] = useState<string | null>(null);

  useEffect(() => subscribeAndroidShareInsertionError(setInsertionError), []);

  if (!bridge || (shares.length === 0 && !insertionError)) {
    return null;
  }

  const sessionOptions = projects.flatMap((project) => (
    (project.sessions ?? []).map((session) => ({
      session,
      projectName: project.displayName || project.path || project.projectId,
    }))
  ));
  const targetSessionId = chosenSessionId || currentSession?.id || '';
  const selectedSession = sessionOptions.find((option) => option.session.id === targetSessionId)?.session
    ?? currentSession;

  const handleImport = (share: AndroidShare) => {
    if (!selectedSession) {
      setLocalError(t('androidShare.noSession', {
        defaultValue: 'Open or choose a session first.',
      }));
      return;
    }

    clearAndroidShareInsertionError();
    setLocalError(null);
    enqueueAndroidShareInsertion(share, selectedSession.id);
    onOpenSession(selectedSession);
  };

  const handleDiscard = async (share: AndroidShare) => {
    if (!bridge) {
      return;
    }

    setDiscardingId(share.id);
    cancelAndroidShareInsertion(share.id);
    try {
      await bridge.discardShare(share.id);
      // The discarded share can no longer report its old failure, so drop it
      // with the row; once the list is empty the whole panel disappears.
      clearAndroidShareInsertionError();
      setLocalError(null);
    } catch (error) {
      setLocalError(error instanceof Error
        ? error.message
        : t('androidShare.discardFailed', { defaultValue: 'Could not discard the shared item' }));
    } finally {
      setDiscardingId(null);
    }
  };

  const error = insertionError || localError;

  return (
    <section className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <Share2Icon className="h-4 w-4 text-blue-600" />
        <h3 className="text-sm font-medium text-foreground">
          {t('androidShare.title', { defaultValue: 'Received from Android' })}
        </h3>
      </div>

      <label className="mt-3 block text-xs text-muted-foreground" htmlFor="android-share-session">
        {t('androidShare.target', { defaultValue: 'Import into session' })}
      </label>
      <select
        id="android-share-session"
        value={selectedSession?.id ?? ''}
        onChange={(event) => {
          setChosenSessionId(event.target.value);
          setLocalError(null);
        }}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
      >
        {!selectedSession && <option value="">{t('androidShare.noSession', { defaultValue: 'Open or choose a session first.' })}</option>}
        {sessionOptions.map(({ session, projectName }) => (
          <option key={session.id} value={session.id}>
            {session.summary || session.name || session.title || session.id} · {projectName}
          </option>
        ))}
      </select>

      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </p>
      )}

      <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
        {shares.map((share) => (
          <li key={share.id} className="rounded-lg border border-border/60 p-2">
            <p className="line-clamp-2 break-words text-sm text-foreground">{describeShare(share, t)}</p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleDiscard(share)}
                disabled={discardingId === share.id}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
              >
                <Trash2Icon className="h-3.5 w-3.5" />
                {t('buttons.delete', { defaultValue: 'Delete' })}
              </button>
              <button
                type="button"
                onClick={() => handleImport(share)}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                <DownloadIcon className="h-3.5 w-3.5" />
                {t('androidShare.import', { defaultValue: 'Import' })}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

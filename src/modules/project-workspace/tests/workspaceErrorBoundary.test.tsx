import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import '@/modules/i18n';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';

test('error details retain the throwing utility stack and retry can restore the chat', () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'trim')");
  error.stack = `${error.name}: ${error.message}\n    at readQueuedMessage (chatDrafts.ts:224:25)`;
  let shouldFail = true;
  function Chat() {
    if (shouldFail) throw error;
    return <div>Chat restored</div>;
  }
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <WorkspaceErrorBoundary showDetails onRetry={() => { shouldFail = false; }}>
        <Chat />
      </WorkspaceErrorBoundary>,
    );
    expect(screen.getByText(/at readQueuedMessage \(chatDrafts.ts:224:25\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByText('Chat restored')).toBeTruthy();
  } finally {
    logged.mockRestore();
  }
});

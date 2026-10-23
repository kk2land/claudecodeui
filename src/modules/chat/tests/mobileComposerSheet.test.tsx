import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { MobileComposerSheet } from '@/modules/chat/composer/MobileComposerSheet';

/** The closed sheet must not build its model list or schedule content at all. */
test('a closed mobile sheet does not invoke its children render function', () => {
  const children = vi.fn(() => null);
  render(
    <MobileComposerSheet
      open={false}
      onOpenChange={() => {}}
      title="Chat settings"
      doneLabel="Done"
    >
      {children}
    </MobileComposerSheet>,
  );
  expect(children).not.toHaveBeenCalled();
});

test('an open mobile sheet renders its children and the supplied close callback really closes', () => {
  const children = vi.fn((close: () => void) => <button type="button" onClick={close}>inside</button>);
  const onOpenChange = vi.fn();
  render(
    <MobileComposerSheet
      open
      onOpenChange={onOpenChange}
      title="Chat settings"
      doneLabel="Done"
    >
      {children}
    </MobileComposerSheet>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'inside' }));
  assert.deepEqual(onOpenChange.mock.calls, [[false]]);
});

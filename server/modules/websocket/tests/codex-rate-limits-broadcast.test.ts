import assert from 'node:assert/strict';
import test from 'node:test';

import { broadcastCodexRateLimits } from '@/modules/websocket/services/codex-rate-limits-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

const snapshot = {
  weekly: { remainingPercent: 75, resetsAt: 1_800_000_000 },
  fiveHour: null,
  updatedAt: 1_700_000_000_000,
  stale: false,
};

test('quota updates reach every open chat socket with no credential fields', () => {
  connectedClients.clear();
  const open = new FakeConnection();
  const closed = new FakeConnection();
  closed.readyState = 3; // CLOSED
  connectedClients.add(open as unknown as Parameters<typeof connectedClients.add>[0]);
  connectedClients.add(closed as unknown as Parameters<typeof connectedClients.add>[0]);
  try {
    broadcastCodexRateLimits({ enabled: true, snapshot });

    assert.equal(open.frames.length, 1);
    assert.deepEqual(open.frames[0], { kind: 'codex_rate_limits_updated', enabled: true, snapshot });
    assert.equal(closed.frames.length, 0);
    // The frame must not leak credentials or account identity.
    const text = JSON.stringify(open.frames[0]);
    assert.ok(!/token|password|credential|email|account/i.test(text));
  } finally {
    connectedClients.clear();
  }
});

test('an account-change clear is broadcast as a null snapshot', () => {
  connectedClients.clear();
  const open = new FakeConnection();
  connectedClients.add(open as unknown as Parameters<typeof connectedClients.add>[0]);
  try {
    broadcastCodexRateLimits({ enabled: true, snapshot: null });
    assert.deepEqual(open.frames[0], { kind: 'codex_rate_limits_updated', enabled: true, snapshot: null });
  } finally {
    connectedClients.clear();
  }
});

test('a throwing socket does not stop later clients from receiving the frame', () => {
  connectedClients.clear();
  const broken = new FakeConnection();
  // A socket that closes between the readyState check and `send` throws here.
  broken.send = () => { throw new Error('WebSocket is not open'); };
  const after = new FakeConnection();
  connectedClients.add(broken as unknown as Parameters<typeof connectedClients.add>[0]);
  connectedClients.add(after as unknown as Parameters<typeof connectedClients.add>[0]);
  try {
    assert.doesNotThrow(() => broadcastCodexRateLimits({ enabled: true, snapshot }));

    // The failing client does not swallow the broadcast for the next one.
    assert.equal(after.frames.length, 1);
    assert.deepEqual(after.frames[0], { kind: 'codex_rate_limits_updated', enabled: true, snapshot });
  } finally {
    connectedClients.clear();
  }
});

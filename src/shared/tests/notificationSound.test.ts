import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Vitest runs from the repository root, so the built asset path is stable here.
const SOUND_FILE = resolve(process.cwd(), 'public/sounds/notification.wav');

// Pins the asset the user approved at 10x loudness; any replacement must be deliberate.
const APPROVED_SHA256 = '3a7014041cc551df0799335e5cc2c250ed44a5a737dcf6f1450d5f0af32bc8bf';

type FakeAudioInstance = {
  src: string;
  volume: number;
  currentTime: number;
  play: ReturnType<typeof vi.fn>;
};

/** Minimal stand-in for the browser audio element; jsdom implements neither playback nor decoding. */
class FakeAudio implements FakeAudioInstance {
  static instances: FakeAudioInstance[] = [];

  src: string;
  volume = 1;
  currentTime = 0;
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  localStorage.clear();
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Imports a fresh copy of the module so the lazily created element does not leak across tests. */
const importSoundHelpers = () => import('@/shared/utils');

test('the shipped chime is the approved mono PCM16 WAV', () => {
  const asset = readFileSync(SOUND_FILE);

  expect(createHash('sha256').update(asset).digest('hex')).toBe(APPROVED_SHA256);
  expect(asset.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(asset.subarray(8, 12).toString('ascii')).toBe('WAVE');
  // fmt chunk: audio format 1 (PCM), 1 channel, 44100 Hz, 16-bit samples.
  expect(asset.readUInt16LE(20)).toBe(1);
  expect(asset.readUInt16LE(22)).toBe(1);
  expect(asset.readUInt32LE(24)).toBe(44100);
  expect(asset.readUInt16LE(34)).toBe(16);
});

test('plays the file at full volume and resolves the base-aware URL', async () => {
  vi.stubEnv('BASE_URL', '/app/');
  const { playNotificationSound } = await importSoundHelpers();

  await playNotificationSound();

  expect(FakeAudio.instances).toHaveLength(1);
  expect(FakeAudio.instances[0].src).toBe('/app/sounds/notification.wav');
  // The WAV already carries the approved loudness; playback must not amplify it further.
  expect(FakeAudio.instances[0].volume).toBe(1);
  expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
});

test('respects the stored preference and lets force bypass it', async () => {
  const { playNotificationSound, setNotificationSoundEnabled } = await importSoundHelpers();

  setNotificationSoundEnabled(false);
  await playNotificationSound();
  expect(FakeAudio.instances).toHaveLength(0);

  await playNotificationSound({ force: true });
  expect(FakeAudio.instances).toHaveLength(1);
  expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
});

test('reuses one element and restarts it for back-to-back notifications', async () => {
  const { playNotificationSound } = await importSoundHelpers();

  await playNotificationSound();
  FakeAudio.instances[0].currentTime = 0.2;
  await playNotificationSound();

  expect(FakeAudio.instances).toHaveLength(1);
  expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(2);
  expect(FakeAudio.instances[0].currentTime).toBe(0);
});

test('swallows playback rejection instead of raising an unhandled rejection', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { playNotificationSound } = await importSoundHelpers();

  class RejectingAudio extends FakeAudio {
    constructor(src: string) {
      super(src);
      this.play = vi.fn(() => Promise.reject(new Error('blocked')));
    }
  }
  vi.stubGlobal('Audio', RejectingAudio);

  await expect(playNotificationSound()).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
});

test('does nothing where the browser has no audio element', async () => {
  vi.stubGlobal('Audio', undefined);
  const { playNotificationSound } = await importSoundHelpers();

  await expect(playNotificationSound()).resolves.toBeUndefined();
});

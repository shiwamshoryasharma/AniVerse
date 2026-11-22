import { afterEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../frontend/src/lib/bridge', () => ({ call: bridge.call, isAniVerse2: true }));
import { applyRenderingChoice as apply } from '../../frontend/src/lib/uiRenderingAction';
afterEach(() => { bridge.call.mockReset(); });

it('persists Accelerated before restarting and shares duplicate clicks as one action', async () => {
  let saved!: () => void;
  const persistence = new Promise<void>(resolve => { saved = resolve; });
  bridge.call.mockImplementation((method: string) => method === 'app.setUiRendering' ? persistence : Promise.resolve());
  const job = { current: null as Promise<void> | null };
  const first = apply(job, 'accelerated', true);
  const duplicate = apply(job, 'accelerated', true);
  expect(duplicate).toBe(first);
  expect(bridge.call.mock.calls).toEqual([['app.setUiRendering', { mode: 'accelerated' }]]);
  saved();
  await first;
  expect(bridge.call.mock.calls).toEqual([
    ['app.setUiRendering', { mode: 'accelerated' }], ['app.restart'],
  ]);
  expect(job.current).toBe(null);
});

it('does not restart after a failed save and permits a later successful attempt', async () => {
  bridge.call.mockRejectedValueOnce(new Error('Preference could not be saved.'));
  const job = { current: null as Promise<void> | null };
  await expect(apply(job, 'accelerated', true)).rejects.toThrow('could not be saved');
  expect(bridge.call.mock.calls).toEqual([['app.setUiRendering', { mode: 'accelerated' }]]);
  expect(job.current).toBe(null);
  bridge.call.mockResolvedValue(undefined);
  await apply(job, 'accelerated', true);
  expect(bridge.call.mock.calls.filter(([method]) => method === 'app.restart')).toHaveLength(1);
});

it('keeps an ordinary Stable selection as a preference update without restarting', async () => {
  bridge.call.mockResolvedValue(undefined);
  await apply({ current: null }, 'stable');
  expect(bridge.call.mock.calls).toEqual([['app.setUiRendering', { mode: 'stable' }]]);
});

it('propagates restart errors to the UI and releases the pending guard', async () => {
  bridge.call.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Restart was refused.'));
  const job = { current: null as Promise<void> | null };
  await expect(apply(job, 'accelerated', true)).rejects.toThrow('Restart was refused');
  expect(job.current).toBe(null);
});
import type { UiRenderingMode } from '../../../app/shared/graphics';
import { call } from './bridge';

/** Save once before an optional explicit restart; concurrent controls share the same pending action. */
export function applyRenderingChoice(
  job: { current: Promise<void> | null },
  mode: UiRenderingMode,
  restart = false,
): Promise<void> {
  if (job.current) return job.current;
  const task = (async () => {
    await call('app.setUiRendering', { mode });
    if (restart) await call('app.restart');
  })();
  job.current = task;
  const complete = () => { if (job.current === task) job.current = null; };
  void task.then(complete, complete);
  return task;
}

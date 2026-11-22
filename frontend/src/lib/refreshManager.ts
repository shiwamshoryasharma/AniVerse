import type { QueryClient } from '@tanstack/react-query';

const manual = new WeakMap<QueryClient, Promise<void>>();
const focus = new WeakMap<QueryClient, { at: number; task: Promise<void>; pending: boolean }>();
const FOCUS_COOLDOWN = 30_000;

export function settingsInitialized(client: QueryClient) {
  return client.getQueryState(['settings'])?.status === 'success';
}

/** The query client owns jobs; repeated triggers join work instead of cancelling IPC it cannot abort. */
export function refreshVisibleQueries(client: QueryClient, visible = !document.hidden): Promise<void> {
  const running = manual.get(client);
  if (running) return running;
  if (!visible || !settingsInitialized(client)) return Promise.resolve();
  const task = client.invalidateQueries({}, { cancelRefetch: false });
  manual.set(client, task);
  const complete = () => { if (manual.get(client) === task) manual.delete(client); };
  void task.then(complete, complete);
  return task;
}

export function refreshSourcesOnFocus(client: QueryClient, visible = !document.hidden, now = Date.now()): Promise<void> {
  if (!visible || !settingsInitialized(client)) return Promise.resolve();
  const previous = focus.get(client);
  if (previous?.pending) { previous.at = now; return previous.task; }
  if (previous && now - previous.at < FOCUS_COOLDOWN) return previous.task;
  const task = client.invalidateQueries({
    predicate: query => query.queryKey[0] === 'sources' ||
      (query.queryKey[0] === 'latest' && query.isStale()),
  }, { cancelRefetch: false });
  const job = { at: now, task, pending: true };
  focus.set(client, job);
  const complete = () => { job.pending = false; };
  void task.then(complete, complete);
  return task;
}

/** The healer retries transient failures once; a server cooldown needs time, not another immediate attempt. */
export function retryQuery(failures: number, error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  return failures < 1 && ['network', 'internal'].includes(code);
}
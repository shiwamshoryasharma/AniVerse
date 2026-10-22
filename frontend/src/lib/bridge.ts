import type { AniverseBridge, EventContract, EventName, RpcInput, RpcMethod, RpcOutput } from '../../../app/shared/rpc';

declare global {
  interface Window {
    aniverse?: AniverseBridge;
  }
}

export class BridgeUnavailableError extends Error {
  code = 'internal' as const;
  constructor() {
    super('AniVerse must run inside its desktop shell (npm run dev / npm start).');
  }
}

export function call<M extends RpcMethod>(method: M, ...input: RpcInput<M> extends void ? [] : [RpcInput<M>]): Promise<RpcOutput<M>> {
  const bridge = window.aniverse;
  if (!bridge) return Promise.reject(new BridgeUnavailableError());
  return bridge.invoke(method, input[0] as RpcInput<M>);
}

export function onEvent<E extends EventName>(event: E, listener: (payload: EventContract[E]) => void): () => void {
  return window.aniverse?.on(event, listener) ?? (() => undefined);
}

export const platform = window.aniverse?.platform ?? 'web';

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorCode(err: unknown): string | null {
  return typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : null;
}

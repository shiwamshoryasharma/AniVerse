import { useEffect, useRef, useState } from 'react';
import type { CastState } from '../../../app/shared/types';
import { call, onEvent } from '../lib/bridge';

const IDLE: CastState = { device: null, status: 'idle', currentTime: 0, duration: 0, title: null, volume: 1, error: null };

export const isCasting = (s: CastState) => !!s.device && s.status !== 'idle' && s.status !== 'error';

/** Live cast state from the main process; the position is advanced locally between updates. */
export function useCastState(): CastState {
  const [state, setState] = useState<CastState>(IDLE);
  const received = useRef({ at: 0, time: 0 });

  useEffect(() => {
    const apply = (s: CastState) => {
      received.current = { at: Date.now(), time: s.currentTime };
      setState(s);
    };
    void call('cast.state').then(apply).catch(() => undefined);
    return onEvent('cast.status', apply);
  }, []);

  useEffect(() => {
    if (state.status !== 'playing') return;
    const t = window.setInterval(() => {
      const { at, time } = received.current;
      setState((s) => ({ ...s, currentTime: Math.min(s.duration || Infinity, time + (Date.now() - at) / 1000) }));
    }, 500);
    return () => window.clearInterval(t);
  }, [state.status]);

  return state;
}

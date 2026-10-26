export interface PlaybackSample {
  at: number;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  totalFrames: number | null;
  droppedFrames: number | null;
}
export interface PlaybackHealth {
  state: 'playing' | 'paused' | 'buffering' | 'stalled' | 'stuttering' | 'ended';
  fps: number | null;
  dropPercent: number | null;
}

/** Frame/clock health only: these browser counters cannot measure lip-sync accuracy. */
export function playbackHealth(previous: PlaybackSample | null, current: PlaybackSample): PlaybackHealth {
  const result: PlaybackHealth = { state: current.ended ? 'ended' : current.paused ? 'paused' : current.readyState < 3 ? 'buffering' : 'playing', fps: null, dropPercent: null };
  if (!previous || current.at <= previous.at || current.currentTime < previous.currentTime) return result;
  const seconds = (current.at - previous.at) / 1000;
  if (current.totalFrames !== null && previous.totalFrames !== null && current.droppedFrames !== null && previous.droppedFrames !== null) {
    const total = current.totalFrames - previous.totalFrames;
    const dropped = current.droppedFrames - previous.droppedFrames;
    if (total < 0 || dropped < 0) return result;
    if (seconds >= 1) {
      result.fps = Math.max(0, total - dropped) / seconds;
      result.dropPercent = total > 0 ? Math.min(100, dropped / total * 100) : 0;
    }
    if (result.state === 'playing' && seconds >= 3 && total === 0) result.state = 'stalled';
    else if (result.state === 'playing' && total >= 20 && dropped / total > 0.08) result.state = 'stuttering';
  }
  if (result.state === 'playing' && seconds >= 3 && current.currentTime - previous.currentTime < 0.05) result.state = 'stalled';
  return result;
}

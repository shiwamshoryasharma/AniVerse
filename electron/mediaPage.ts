/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { ProbeResult } from '../app/shared/types';

export type MediaAction = 'probe' | 'play' | 'pause' | 'seek' | 'resync';

/** Reads/controls the existing player; never reads or replaces its media URL. */
export function mediaPageScript(action: MediaAction = 'probe', value?: number): string {
  return '(' + MEDIA_PAGE.toString() + ')(' + JSON.stringify(action) + ',' + JSON.stringify(value ?? null) + ')';
}

function MEDIA_PAGE(action: MediaAction, value: number | null): Omit<ProbeResult, 'url'> | boolean | null | Promise<boolean> {
  const marked = document.querySelector('[data-aniverse-player]');
  const videos = [...document.querySelectorAll('video')].filter((video) =>
    Number.isFinite(video.duration) && video.duration > 0 &&
    (!marked || marked === video || marked.contains(video)) &&
    video.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    video.getBoundingClientRect().width > 0,
  );
  videos.sort((a, b) => Number(b.duration >= 60) - Number(a.duration >= 60) ||
    Number(!b.paused) - Number(!a.paused) ||
    b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height ||
    b.duration - a.duration);
  const video = videos[0];
  if (!video) return null;
  if (action !== 'probe') {
    if (action === 'pause') video.pause();
    else if (action === 'play') return video.play().then(() => true, () => false);
    else {
      const wasPaused = video.paused;
      const position = action === 'seek' ? value ?? 0 : video.currentTime;
      // Seeking the same element lets its own decoder/audio/subtitle clock resynchronize.
      video.currentTime = Math.max(0, Math.min(video.duration, position));
      if (action === 'resync' && !wasPaused) return video.play().then(() => true, () => false);
    }
    return true;
  }
  const quality = video.getVideoPlaybackQuality?.();
  let bufferedAhead = 0;
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
      bufferedAhead = video.buffered.end(index) - video.currentTime;
      break;
    }
  }
  return {
    currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended,
    video: {
      width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, bufferedAhead,
      totalFrames: quality?.totalVideoFrames ?? null, droppedFrames: quality?.droppedVideoFrames ?? null,
      playbackRate: video.playbackRate,
    },
  };
}

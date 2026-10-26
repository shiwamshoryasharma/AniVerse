import type { MediaSnapshot } from './types';

export interface SceneBookmark {
  id: number;
  media: MediaSnapshot;
  episode: number;
  position: number;
  duration: number;
  sourceId: string | null;
  note: string;
  tags: string[];
  createdAt: number;
}
export type BookmarkInput = Omit<SceneBookmark, 'id' | 'createdAt'> & { id?: number };
export interface SkipRange {
  mediaId: number;
  kind: 'intro' | 'outro';
  start: number;
  end: number;
  enabled: boolean;
  sourceId: string | null;
  duration: number;
}
export interface PlannerCandidate {
  media: MediaSnapshot;
  progress: number;
  available: number;
  minutes: number;
  estimated: boolean;
}
export interface PlanItem {
  media: MediaSnapshot;
  episode: number;
  minutes: number;
  estimated: boolean;
}
export interface WatchPlan {
  budget: number;
  days: { date: string; minutes: number; items: PlanItem[] }[];
  unscheduled: number;
}
export interface LocalMedia {
  id: number;
  name: string;
  bytes: number;
  query: string;
  episode: number | null;
  media: MediaSnapshot | null;
  missing: boolean;
}
export interface PlaybackPoint {
  sessionId: string;
  mediaId: number;
  episode: number;
  sourceId: string | null;
  position: number;
  duration: number;
  paused: boolean;
  totalFrames?: number | null;
  droppedFrames?: number | null;
}
export interface WatchInsights {
  watchedSeconds: number;
  episodes: number;
  daily: { date: string; seconds: number }[];
  sources: { sourceId: string | null; seconds: number; samples: number; dropPercent: number | null }[];
  titles: { title: string; seconds: number }[];
}

export function canAutoSkip(range: SkipRange, duration: number, sourceId: string | null): boolean {
  return (
    Number.isFinite(duration) && range.sourceId === sourceId && range.duration > 0 && Math.abs(range.duration - duration) <= Math.max(5, range.duration * 0.02)
  );
}

export function hideEpisode(episode: number, current: number, watched: Set<number>, enabled: boolean): boolean {
  return enabled && episode > current && !watched.has(episode);
}
export function parseLocalFilename(name: string): { query: string; episode: number | null } {
  const stem = name
    .replace(/\.[^.]+$/, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]/g, ' ');
  const numbered = /\bS(\d{1,2})E(\d{1,4})\b/i.exec(stem);
  const plain = /\s+-\s+(\d{1,4})(?:\s|$)|\b(?:episode|ep)\s*(\d{1,4})\b/i.exec(stem);
  const match = numbered ?? plain;
  let query = (match ? stem.slice(0, match.index) : stem)
    .replace(/\b(?:\d{3,4}p|x26[45]|h\s*26[45]|HEVC|WEB\s*DL|BluRay|AAC|FLAC)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (numbered && Number(numbered[1]) > 1) query += ' Season ' + Number(numbered[1]);
  return { query: query || name.replace(/\.[^.]+$/, ''), episode: match ? Number(numbered ? numbered[2] : (plain?.[1] ?? plain?.[2])) : null };
}
export function buildWatchPlan(candidates: PlannerCandidate[], budget: number, startDate: string): WatchPlan {
  if (!Number.isFinite(budget) || budget < 5 || budget > 360) throw new Error('Choose a daily budget from 5 to 360 minutes.');
  const start = new Date(startDate + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== startDate)
    throw new Error('Choose a valid start date.');
  const queue = candidates.map((entry) => ({ ...entry, next: entry.progress + 1 }));
  let cursor = 0;
  const days = Array.from({ length: 7 }, (_, day) => {
    const date = new Date(start.getTime() + day * 86400000).toISOString().slice(0, 10);
    const items: PlanItem[] = [];
    let minutes = 0;
    while (queue.length) {
      let found = false;
      for (let attempt = 0; attempt < queue.length; attempt++) {
        const entry = queue[cursor++ % queue.length];
        if (entry.next <= entry.available && entry.minutes > 0 && minutes + entry.minutes <= budget) {
          items.push({ media: entry.media, episode: entry.next++, minutes: entry.minutes, estimated: entry.estimated });
          minutes += entry.minutes;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return { date, minutes, items };
  });
  return { budget, days, unscheduled: queue.reduce((total, entry) => total + Math.max(0, entry.available - entry.next + 1), 0) };
}

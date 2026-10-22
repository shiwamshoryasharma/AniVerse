import type { ListStatus, MediaSnapshot } from '../../shared/types';
import type { AniListClient } from '../metadata/anilist';
import { type FetchFn, requestJson } from '../net/http';
import { AppError } from '../util';
import type { SyncPayload } from '../db/store';
import type { EntryState } from './reconcile';

export interface RemoteEntry {
  media: MediaSnapshot;
  status: ListStatus;
  progress: number;
  score: number | null;
  updatedAt: number;
}

export interface PullResult {
  entries: RemoteEntry[];
  favourites: MediaSnapshot[];
}

export interface Profile {
  userId: number;
  userName: string;
  avatar: string | null;
}

/** One remote list service (AniList, MyAnimeList). */
export interface SyncProvider {
  profile(token: string): Promise<Profile>;
  /** Makes the service's entry match `entry` (null = remove it from the list). */
  pushEntry(token: string, ref: SyncPayload, entry: EntryState | null, userId: number | null): Promise<'done' | 'skipped'>;
  pushFavourite(token: string, ref: SyncPayload, favourite: boolean): Promise<'done' | 'skipped'>;
  pull(token: string, userId: number): Promise<PullResult>;
}

const SNAPSHOT_FIELDS = 'id idMal title { userPreferred } coverImage { large } bannerImage format episodes';

interface RawSnap {
  id: number;
  idMal: number | null;
  title: { userPreferred: string };
  coverImage: { large: string | null };
  bannerImage: string | null;
  format: MediaSnapshot['format'];
  episodes: number | null;
}

function toSnapshot(m: RawSnap): MediaSnapshot {
  return { id: m.id, idMal: m.idMal, title: m.title.userPreferred, cover: m.coverImage.large ?? '', banner: m.bannerImage, format: m.format, episodes: m.episodes };
}

/** Custom lists repeat entries: keep one per title, the most recently edited. */
function newestPerTitle(entries: RemoteEntry[]): RemoteEntry[] {
  const byId = new Map<number, RemoteEntry>();
  for (const e of entries) {
    const prev = byId.get(e.media.id);
    if (!prev || e.updatedAt > prev.updatedAt) byId.set(e.media.id, e);
  }
  return [...byId.values()];
}

export class AniListSync implements SyncProvider {
  constructor(private client: AniListClient) {}

  async profile(token: string): Promise<Profile> {
    const data = await this.client.query<{ Viewer: { id: number; name: string; avatar: { medium: string | null } } }>(
      'query { Viewer { id name avatar { medium } } }',
      {},
      { auth: true, token },
    );
    return { userId: data.Viewer.id, userName: data.Viewer.name, avatar: data.Viewer.avatar.medium };
  }

  async pushEntry(token: string, ref: SyncPayload, entry: EntryState | null, userId: number | null): Promise<'done' | 'skipped'> {
    if (!entry) {
      if (!userId) return 'skipped';
      const found = await this.client
        .query<{ MediaList: { id: number } | null }>('query ($mediaId: Int, $userId: Int) { MediaList(mediaId: $mediaId, userId: $userId) { id } }', { mediaId: ref.mediaId, userId }, { auth: true, token })
        .catch((err) => {
          if (err instanceof AppError && err.code === 'not-found') return { MediaList: null };
          throw err;
        });
      if (found.MediaList) {
        await this.client.query('mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }', { id: found.MediaList.id }, { auth: true, token });
      }
      return 'done';
    }
    // scoreRaw (0–100) works whatever score format the user picked on AniList; an unscored
    // AniVerse entry leaves the AniList score untouched.
    const withScore = entry.score !== null;
    await this.client.query(
      `mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus${withScore ? ', $scoreRaw: Int' : ''}) {
        SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status${withScore ? ', scoreRaw: $scoreRaw' : ''}) { id }
      }`,
      { mediaId: ref.mediaId, progress: entry.progress, status: entry.status, ...(withScore ? { scoreRaw: Math.round(entry.score! * 10) } : {}) },
      { auth: true, token },
    );
    return 'done';
  }

  async pushFavourite(token: string, ref: SyncPayload, favourite: boolean): Promise<'done' | 'skipped'> {
    // ToggleFavourite is not idempotent: read the current state first.
    const state = await this.client.query<{ Media: { isFavourite: boolean } }>('query ($id: Int) { Media(id: $id) { isFavourite } }', { id: ref.mediaId }, { auth: true, token });
    if (state.Media.isFavourite !== favourite) {
      await this.client.query('mutation ($animeId: Int) { ToggleFavourite(animeId: $animeId) { anime { pageInfo { total } } } }', { animeId: ref.mediaId }, { auth: true, token });
    }
    return 'done';
  }

  async pull(token: string, userId: number): Promise<PullResult> {
    const data = await this.client.query<{
      MediaListCollection: { lists: { entries: { status: ListStatus; progress: number; score: number | null; updatedAt: number; media: RawSnap }[] }[] };
      User: { favourites: { anime: { nodes: RawSnap[] } } };
    }>(
      `query ($userId: Int) {
        MediaListCollection(userId: $userId, type: ANIME) { lists { entries { status progress score(format: POINT_10_DECIMAL) updatedAt media { ${SNAPSHOT_FIELDS} } } } }
        User(id: $userId) { favourites { anime(perPage: 50) { nodes { ${SNAPSHOT_FIELDS} } } } }
      }`,
      { userId },
      { auth: true, token },
    );
    const entries = data.MediaListCollection.lists
      .flatMap((l) => l.entries)
      .map((e) => ({ media: toSnapshot(e.media), status: e.status, progress: e.progress, score: e.score || null, updatedAt: e.updatedAt }));
    return { entries: newestPerTitle(entries), favourites: data.User.favourites.anime.nodes.map(toSnapshot) };
  }
}

const MAL_API = 'https://api.myanimelist.net/v2';

const TO_MAL: Record<ListStatus, string> = {
  CURRENT: 'watching',
  REPEATING: 'watching',
  COMPLETED: 'completed',
  PAUSED: 'on_hold',
  DROPPED: 'dropped',
  PLANNING: 'plan_to_watch',
};

const FROM_MAL: Record<string, ListStatus> = {
  watching: 'CURRENT',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  dropped: 'DROPPED',
  plan_to_watch: 'PLANNING',
};

export class MalSync implements SyncProvider {
  constructor(
    private fetchFn: FetchFn,
    private anilist: AniListClient,
  ) {}

  async profile(token: string): Promise<Profile> {
    const me = await requestJson<{ id: number; name: string; picture?: string }>(this.fetchFn, {
      url: `${MAL_API}/users/@me`,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { userId: me.id, userName: me.name, avatar: me.picture ?? null };
  }

  async pushEntry(token: string, ref: SyncPayload, entry: EntryState | null): Promise<'done' | 'skipped'> {
    if (!ref.idMal) return 'skipped'; // MAL entries need a MAL id
    const url = `${MAL_API}/anime/${ref.idMal}/my_list_status`;
    if (!entry) {
      await requestJson(this.fetchFn, { url, method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch((err) => {
        if (!(err instanceof AppError && err.code === 'not-found')) throw err;
      });
      return 'done';
    }
    const form: Record<string, string> = {
      status: TO_MAL[entry.status],
      is_rewatching: entry.status === 'REPEATING' ? 'true' : 'false',
      num_watched_episodes: String(entry.progress),
    };
    if (entry.score !== null) form.score = String(Math.min(10, Math.max(0, Math.round(entry.score))));
    await requestJson(this.fetchFn, { url, method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, form });
    return 'done';
  }

  async pushFavourite(): Promise<'done' | 'skipped'> {
    return 'skipped'; // MAL's public API has no favourites endpoint
  }

  async pull(token: string): Promise<PullResult> {
    type Item = { node: { id: number }; list_status: { status: string; num_episodes_watched: number; score: number; updated_at: string; is_rewatching?: boolean } };
    const items: Item[] = [];
    let url: string | null = `${MAL_API}/users/@me/animelist?fields=list_status&limit=500&nsfw=true`;
    for (let i = 0; url && i < 20; i++) {
      const page: { data: Item[]; paging?: { next?: string } } = await requestJson(this.fetchFn, { url, headers: { Authorization: `Bearer ${token}` } });
      items.push(...page.data);
      url = page.paging?.next ?? null;
    }
    // Map MAL ids to AniList media in batches of 50.
    const snapshots = new Map<number, MediaSnapshot>();
    for (let i = 0; i < items.length; i += 50) {
      const ids = items.slice(i, i + 50).map((it) => it.node.id);
      const data = await this.anilist.query<{ Page: { media: RawSnap[] } }>(
        `query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { ${SNAPSHOT_FIELDS} } } }`,
        { ids },
        { ttl: 86400 },
      );
      for (const m of data.Page.media) if (m.idMal) snapshots.set(m.idMal, toSnapshot(m));
    }
    const entries: RemoteEntry[] = [];
    for (const it of items) {
      const media = snapshots.get(it.node.id);
      const status = it.list_status.is_rewatching ? 'REPEATING' : FROM_MAL[it.list_status.status];
      if (!media || !status) continue;
      entries.push({
        media,
        status,
        progress: it.list_status.num_episodes_watched,
        score: it.list_status.score || null,
        updatedAt: Math.floor(Date.parse(it.list_status.updated_at) / 1000),
      });
    }
    return { entries: newestPerTitle(entries), favourites: [] };
  }
}

/** MAL OAuth token exchange / refresh (PKCE "plain", public client — no client secret). */
export async function malToken(fetchFn: FetchFn, form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  try {
    return await requestJson(fetchFn, { url: 'https://myanimelist.net/v1/oauth2/token', method: 'POST', form, retries: 0 });
  } catch (err) {
    // invalid_grant & co. come back as HTTP 400: the code or refresh token is no longer valid.
    const rejected = err instanceof AppError && (err.code === 'unauthorised' || (err.code === 'network' && /responded 400/.test(err.message)));
    if (rejected) throw new AppError('unauthorised', 'MyAnimeList rejected the sign-in. Connect again.');
    throw err;
  }
}

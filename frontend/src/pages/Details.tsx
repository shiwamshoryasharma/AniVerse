import { CalendarClock, Check, ExternalLink, Heart, Play, Star, TvMinimalPlay } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { ListStatus, MediaDetails } from '../../../app/shared/types';
import { hideEpisode } from '../../../app/shared/workspace';
import { SpoilerGuard } from '../components/SpoilerGuard';
import { ErrorState, Loading, SourceIcon } from '../components/common';
import { Select } from '../components/controls';
import { CardRail, MediaCard } from '../components/MediaCard';
import { call } from '../lib/bridge';
import { availableEpisodes, countdown, cx, formatLabel, fuzzyDate, LIST_STATUSES, pendingRelease, seasonLabel, snapshotOf, statusLabel, titleOf } from '../lib/format';
import { useDetails, useLibraryState, useSetScore, useSetStatus, useSettings, useSources, useToggleFavourite } from '../lib/queries';
import { useToast } from '../lib/useToast';

export function DetailsPage() {
  const id = Number(useParams().id);
  const { data, error, refetch } = useDetails(id);
  if (error) {
    return (
      <div className="page">
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (!data) return <Loading />;
  return <Details media={data} />;
}

function Details({ media }: { media: MediaDetails }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const lang = settings.appearance.titleLanguage;
  const { data: state } = useLibraryState(media.id);
  const { data: sources } = useSources();
  const toggleFav = useToggleFavourite();
  const setStatus = useSetStatus();
  const setScore = useSetScore();
  const toast = useToast();
  const [showAllEps, setShowAllEps] = useState(false);
  const title = titleOf(media, lang);
  const snapshot = snapshotOf(media, lang);
  const watched = new Set(state?.progress.filter((p) => p.completed).map((p) => p.episode));
  const total = availableEpisodes(media, Math.max(0, ...(state?.progress.map((p) => p.episode) ?? [0])));
  const nextEpisode = Math.min(Math.max(1, (state?.entry?.progress ?? 0) + 1), Math.max(total, 1));
  const release = total < 1 ? pendingRelease(media) : null;
  const enabledSources = (sources ?? []).filter((s) => s.enabled);
  const officialLinks = media.externalLinks.filter((l) => l.type === 'STREAMING');
  const episodeTitles = new Map<number, string>();
  for (const se of media.streamingEpisodes) {
    const n = Number(se.title.match(/(?:episode|ep)\s*(\d+)/i)?.[1]);
    if (n) episodeTitles.set(n, se.title.replace(/^episode\s*\d+\s*[-:–]\s*/i, ''));
  }
  const epCount = showAllEps ? total : Math.min(total, 48);

  const changeStatus = (status: ListStatus | null) =>
    setStatus.mutate(
      { media: snapshot, status },
      {
        onSuccess: () => toast.push({ level: 'success', message: status ? `Saved as ${LIST_STATUSES.find(([s]) => s === status)![1]}.` : 'Removed from your list.' }),
        onError: (e) => toast.push({ level: 'error', message: e.message }),
      },
    );

  return (
    <div className="page">
      <section className="details-hero">
        <div className="bg" style={{ backgroundImage: `url("${media.banner ?? media.cover}")` }} />
        <div className="details-head">
          <img className="details-cover" src={media.cover} alt="" />
          <div style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <span className="chip accent">{formatLabel(media.format)}</span>
              <span className={cx('chip', media.status === 'RELEASING' && 'ok')}>{statusLabel(media.status)}</span>
              {media.score && (
                <span className="chip">
                  <Star size={11} fill="var(--warn)" color="var(--warn)" /> {(media.score / 10).toFixed(1)}
                </span>
              )}
              {media.episodes && <span className="chip">{media.episodes} episodes</span>}
              {media.duration && <span className="chip">{media.duration} min</span>}
              {media.season && <span className="chip">{seasonLabel(media.season, media.seasonYear)}</span>}
              {media.isAdult && <span className="chip err">18+</span>}
            </div>
            <h1 className="details-title selectable">{title}</h1>
            <div className="details-alt selectable">{[media.title.romaji !== title ? media.title.romaji : null, media.title.native].filter(Boolean).join(' · ')}</div>
            <div className="row wrap" style={{ marginBottom: 16 }}>
              {media.genres.map((g) => (
                <button key={g} className="chip" onClick={() => navigate(`/browse?genres=${encodeURIComponent(g)}`)}>
                  {g}
                </button>
              ))}
            </div>
            <div className="row wrap" style={{ gap: 14 }}>
              {release ? (
                <button className="cta" onClick={() => navigate(`/watch/${media.id}/1`)} title={release.label}>
                  <span className="row">
                    <CalendarClock size={15} /> {release.action}
                  </span>
                </button>
              ) : (
                <button className="cta" disabled={total < 1} onClick={() => navigate(`/watch/${media.id}/${nextEpisode}`)}>
                  <span className="row">
                    <Play size={15} fill="currentColor" /> {state?.progress.length ? `Continue · EP ${nextEpisode}` : 'Watch now'}
                  </span>
                </button>
              )}
              <Select<ListStatus | 'none'>
                ariaLabel="List status"
                size="lg"
                width={180}
                placeholder="Add to list…"
                value={state?.entry?.status ?? null}
                onChange={(v) => changeStatus(v === 'none' ? null : v)}
                options={[
                  ...LIST_STATUSES.map(([v, l]) => ({ value: v, label: l })),
                  ...(state?.entry ? [{ value: 'none' as const, label: 'Remove from list' }] : []),
                ]}
              />
              {state?.entry && (
                <Select<string>
                  ariaLabel="Your score"
                  size="lg"
                  width={130}
                  placeholder="Score…"
                  value={state.entry.score === null ? null : String(state.entry.score)}
                  onChange={(v) =>
                    setScore.mutate(
                      { media: snapshot, score: v === 'none' ? null : Number(v) },
                      {
                        onSuccess: () => toast.push({ level: 'success', message: v === 'none' ? 'Score cleared here.' : `Scored ${v}/10.` }),
                        onError: (e) => toast.push({ level: 'error', message: e.message }),
                      },
                    )
                  }
                  options={[
                    ...[...new Set([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, ...(state.entry.score !== null ? [state.entry.score] : [])])]
                      .sort((a, b) => b - a)
                      .map((n) => ({ value: String(n), label: `★ ${n}` })),
                    { value: 'none', label: 'No score' },
                  ]}
                />
              )}
              <button
                className={cx('btn lg', state?.favourite && 'on')}
                onClick={() => toggleFav.mutate(snapshot, { onError: (e) => toast.push({ level: 'error', message: e.message }) })}
                aria-pressed={!!state?.favourite}
              >
                <Heart size={16} fill={state?.favourite ? 'currentColor' : 'none'} /> {state?.favourite ? 'Favourited' : 'Favourite'}
              </button>
              {media.trailer?.site === 'youtube' && (
                <button className="btn lg ghost" onClick={() => void call('app.openExternal', { url: `https://www.youtube.com/watch?v=${media.trailer!.id}` })}>
                  <TvMinimalPlay size={16} /> Trailer
                </button>
              )}
              <button className="btn lg ghost" onClick={() => void call('app.openExternal', { url: media.siteUrl })}>
                <ExternalLink size={15} /> AniList
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="details-body">
        <div className="stack" style={{ minWidth: 0 }}>
          {media.nextAiring && (
            <div className="card countdown">
              <CalendarClock size={20} color="var(--accent)" />
              <div className="grow">
                <div className="faint" style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  Next episode
                </div>
                <div>
                  Episode {media.nextAiring.episode} · {new Date(media.nextAiring.airingAt * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
              <span className="big">{countdown(media.nextAiring.airingAt)}</span>
            </div>
          )}

          <div className="card card-pad">
            <h3 style={{ marginTop: 0 }}>Synopsis</h3>
            <SpoilerGuard key={media.id} label="Synopsis"><p className="synopsis selectable">{media.description ?? 'No synopsis available.'}</p></SpoilerGuard>
          </div>

          <div className="card card-pad">
            <div className="row between" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Episodes</h3>
              <span className="faint">
                {watched.size} of {total || '?'} watched
              </span>
            </div>
            {total < 1 ? (
              <p className="muted" style={{ margin: 0 }}>
                No episodes have aired yet.
              </p>
            ) : (
              <>
                <div className="ep-list grid-mode" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', padding: 0, overflow: 'visible' }}>
                  {Array.from({ length: epCount }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      className={cx('ep-cell', watched.has(n) && 'watched')}
                      title={hideEpisode(n,nextEpisode,watched,settings.appearance.spoilerShield) ? `Episode ${n}` : episodeTitles.get(n) ?? `Episode ${n}`}
                      onClick={() => navigate(`/watch/${media.id}/${n}`)}
                    >
                      {watched.has(n) ? <Check size={13} /> : n}
                    </button>
                  ))}
                </div>
                {total > epCount && (
                  <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setShowAllEps(true)}>
                    Show all {total} episodes
                  </button>
                )}
              </>
            )}
          </div>

          {media.characters.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginTop: 0 }}>Characters & voice cast</h3>
              <div className="char-grid">
                {media.characters.map((c) => (
                  <div key={c.name} className="char">
                    <div className="side">
                      {c.image && <img src={c.image} alt="" loading="lazy" />}
                      <div>
                        <div style={{ fontWeight: 650 }} className="ellipsis">
                          {c.name}
                        </div>
                        <div className="faint">{c.role[0] + c.role.slice(1).toLowerCase()}</div>
                      </div>
                    </div>
                    {c.voiceActor && (
                      <div className="side right">
                        {c.voiceActor.image && <img src={c.voiceActor.image} alt="" loading="lazy" />}
                        <div>
                          <div style={{ fontWeight: 650 }} className="ellipsis">
                            {c.voiceActor.name}
                          </div>
                          <div className="faint">Japanese</div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="stack">
          <div className="card card-pad">
            <h3 style={{ marginTop: 0 }}>Where to watch</h3>
            {enabledSources.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No sources configured. Add sites to <span className="code">config/streaming-sites.txt</span>.
              </p>
            ) : (
              <div className="row wrap" style={{ gap: 6 }}>
                {enabledSources.map((s) => (
                  <button key={s.id} className="source-btn" onClick={() => navigate(`/watch/${media.id}/${nextEpisode}?source=${s.id}`)} title={s.url}>
                    <SourceIcon source={s} /> {s.name}
                  </button>
                ))}
              </div>
            )}
            {officialLinks.length > 0 && (
              <>
                <div className="faint" style={{ margin: '14px 0 8px', fontSize: 'var(--fs-xs)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  Licensed streaming
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {officialLinks.map((l) => (
                    <button key={l.url} className="source-btn" onClick={() => void call('app.openExternal', { url: l.url })}>
                      <ExternalLink size={12} /> {l.site}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="card card-pad">
            <dl className="facts">
              <dt>Format</dt>
              <dd>{formatLabel(media.format)}</dd>
              <dt>Episodes</dt>
              <dd>{media.episodes ?? (media.nextAiring ? `${media.nextAiring.episode - 1}+` : '—')}</dd>
              <dt>Duration</dt>
              <dd>{media.duration ? `${media.duration} min` : '—'}</dd>
              <dt>Status</dt>
              <dd>{statusLabel(media.status)}</dd>
              <dt>Aired</dt>
              <dd>
                {fuzzyDate(media.startDate)} → {media.status === 'RELEASING' ? 'now' : fuzzyDate(media.endDate)}
              </dd>
              <dt>Season</dt>
              <dd>{seasonLabel(media.season, media.seasonYear) || '—'}</dd>
              <dt>Studios</dt>
              <dd>{media.studios.join(', ') || '—'}</dd>
              <dt>Source</dt>
              <dd>{media.source ? media.source.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—'}</dd>
              <dt>Country</dt>
              <dd>{media.countryOfOrigin ?? '—'}</dd>
              <dt>Popularity</dt>
              <dd>{media.popularity?.toLocaleString() ?? '—'}</dd>
              <dt>Favourites</dt>
              <dd>{media.favourites?.toLocaleString() ?? '—'}</dd>
              {media.synonyms.length > 0 && (
                <>
                  <dt>Also known as</dt>
                  <dd className="selectable">{media.synonyms.slice(0, 4).join(' · ')}</dd>
                </>
              )}
            </dl>
          </div>

          {media.tags.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginTop: 0 }}>Tags</h3>
              <div className="row wrap" style={{ gap: 6 }}>
                {media.tags
                  .filter((t) => !t.isSpoiler)
                  .slice(0, 16)
                  .map((t) => (
                    <span key={t.name} className="chip" title={`${t.rank}% relevance`}>
                      {t.name}
                    </span>
                  ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      {media.relations.length > 0 && (
        <CardRail title="Related">
          {media.relations.map((r) => (
            <MediaCard key={r.media.id} media={r.media} badge={<span className="chip glass">{r.relationType.replace(/_/g, ' ').toLowerCase()}</span>} />
          ))}
        </CardRail>
      )}
      {media.recommendations.length > 0 && (
        <CardRail title="You might also like">
          {media.recommendations.map((m) => (
            <MediaCard key={m.id} media={m} />
          ))}
        </CardRail>
      )}
    </div>
  );
}

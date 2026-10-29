import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Cast, Cloud, History, LayoutDashboard, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { CURRENT_RELEASE, RELEASES, type ChangeIcon, type ReleaseNote } from '../../../app/shared/changelog';
import { call } from '../lib/bridge';
const ICONS = { layout: LayoutDashboard, cast: Cast, cloud: Cloud, sparkles: Sparkles, history: History, shield: ShieldCheck, fix: Wrench } satisfies Record<ChangeIcon, typeof Cast>;
const LABELS = { added: 'Added', improved: 'Improved', fixed: 'Fixed' };
function ReleaseCards({ release, onAction }: { release: ReleaseNote; onAction?: (path: string) => void }) {
  const navigate = useNavigate();
  return <div className="release-cards">{release.items.map((item) => {
    const Icon = ICONS[item.icon];
    return <article className={'release-feature change-' + item.kind} key={item.title}>
      <div className="release-feature-icon"><Icon size={21} /></div><div className="grow">
        <span className="change-kind">{LABELS[item.kind]}</span><h3>{item.title}</h3><p>{item.description}</p>
        {item.action && <button className="release-action" onClick={() => onAction ? onAction(item.action!.path) : navigate(item.action!.path)}>{item.action.label}<ArrowRight size={14} /></button>}
      </div></article>;
  })}</div>;
}
export function ChangelogPage() {
  return <section className="changelog-history"><header className="changelog-heading"><span className="release-mark"><History size={25} /></span><div><h2>Changelog</h2><p>Every update, right here. No browser needed.</p></div></header>
    {RELEASES.map((release) => <article className="release-entry" key={release.version}>
      <header className="release-entry-heading"><span className="release-version">v{release.version}</span><time dateTime={release.date}>{new Date(release.date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</time>
        {release.version === CURRENT_RELEASE.version && <span className="chip accent">Latest</span>}</header>
      <h2>{release.title}</h2><p className="muted">{release.summary}</p><ReleaseCards release={release} /></article>)}
  </section>;
}
export function ReleaseAnnouncements() {
  const query = useQuery({ queryKey: ['changelog'], queryFn: () => call('changelog.state'), staleTime: Infinity });
  const qc = useQueryClient(), navigate = useNavigate(), dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const mark = useMutation({ mutationFn: () => call('changelog.markSeen', { version: query.data!.version }),
    onSuccess: (state) => qc.setQueryData(['changelog'], state) });
  const release = RELEASES.find((entry) => entry.version === query.data?.version);
  const visible = !!query.data?.unread && !dismissed && !!release;
  useEffect(() => {
    if (visible && !dialog.current?.open) dialog.current?.showModal();
    if (!visible && dialog.current?.open) dialog.current.close();
  }, [visible]);
  const close = (path?: string) => {
    setDismissed(true);
    if (query.data) mark.mutate();
    if (path) navigate(path);
  };
  return <>
    <button className={'btn sm whats-new-button ' + (query.data?.unread ? 'has-news' : '')} onClick={() => { if (query.data) mark.mutate(); navigate('/settings/changelog'); }} title="Read the in-app changelog">
      <Sparkles size={15} /><span>What’s new</span>{query.data?.unread && <i aria-label="Unread release notes" />}</button>
    <dialog ref={dialog} className="release-dialog" aria-label="What’s new in AniVerse" onCancel={(event) => { event.preventDefault(); close(); }}>
      {release && <><header className="release-dialog-heading"><div className="row"><span className="release-mark"><Sparkles size={24} /></span><div><span className="release-eyebrow">WHAT’S NEW</span><strong>AniVerse {release.version}</strong></div></div>
        <button className="icon-btn" aria-label="Close release highlights" onClick={() => close()}><X size={20} /></button></header>
        <div className="release-dialog-body"><h1>{release.title}</h1><p className="muted">{release.summary}</p><ReleaseCards release={release} onAction={(path) => close(path)} /></div>
        <footer className="release-dialog-footer"><button className="btn" onClick={() => close('/settings/changelog')}><History size={15} />Full changelog</button><button className="btn primary" onClick={() => close()}>Got it</button></footer></>}
    </dialog>
  </>;
}

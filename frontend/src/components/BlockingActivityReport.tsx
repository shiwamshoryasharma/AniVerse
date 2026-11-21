import { BarChart3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AdblockStats } from '../../../app/shared/types';
import { useSources } from '../lib/queries';
import { Select } from './controls';
import '../styles/blocking-activity.css';

const categories = [
  { value: 'blocked', label: 'Network filters', description: 'Filter-list matches such as ads, trackers and promotions.' },
  { value: 'securityBlocked', label: 'Security rules', description: 'Requests denied by website network protections.' },
  { value: 'popupsBlocked', label: 'Popups', description: 'Attempts to open a new website window.' },
] as const;

type Category = (typeof categories)[number]['value'];
type Column = (typeof categories)[number] & { index: number };
type Row = { id: string; label: string; counts: number[]; total: number };
const allSources = 'all';
const format = new Intl.NumberFormat();

export function BlockingActivityReport({ stats }: { stats: AdblockStats }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="blocking-report">
      <div className="blocking-report-heading">
        <div><h3><BarChart3 size={17} /> Blocking activity</h3><p>Current session</p></div>
        <button type="button" className="btn sm" aria-expanded={open} aria-controls="blocking-report-content"
          onClick={() => setOpen(!open)}>{open ? 'Close report' : 'View report'}</button>
      </div>
      {open && <ActivityDetails stats={stats} />}
    </section>
  );
}

function ActivityDetails({ stats }: { stats: AdblockStats }) {
  const [source, setSource] = useState(allSources);
  const [category, setCategory] = useState<Category | 'all'>('all');
  const { data: sources } = useSources();
  const rows = useMemo(() => {
    const names = new Map(sources?.map(({ id, name }) => [id, name]));
    const ids = new Set(categories.flatMap(({ value }) => Object.keys(stats[value] ?? {})));
    return [...ids].map((id) => {
      const counts = categories.map(({ value }) => stats[value]?.[id] ?? 0);
      return { id, label: names.get(id) ?? id, counts, total: counts.reduce((sum, count) => sum + count, 0) };
    }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }, [sources, stats]);

  const selected = rows.some(({ id }) => id === source) ? source : allSources;
  const columns = categories.map((item, index) => ({ ...item, index }))
    .filter(({ value }) => category === 'all' || value === category);
  const visible = rows.filter(row => selected === allSources || selected === row.id)
    .map(row => ({ ...row, total: columns.reduce((sum, { index }) => sum + row.counts[index], 0) }))
    .filter(row => row.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const total = visible.reduce((sum, row) => sum + row.total, 0);

  return (
    <div id="blocking-report-content" className="blocking-report-content">
      <div className="blocking-report-filters">
        <div>
          <span className="faint">Source</span>
          <Select value={selected} onChange={setSource} ariaLabel="Filter report by source"
            options={[{ value: allSources, label: 'All sources' }, ...rows.map(({ id, label }) => ({ value: id, label }))]} />
        </div>
        <div>
          <span className="faint">Block type</span>
          <Select value={category} onChange={setCategory} ariaLabel="Filter report by category"
            options={[{ value: 'all', label: 'All activity' }, ...categories]} />
        </div>
      </div>
      <p className="blocking-report-total"><strong>{format.format(total)}</strong> blocked actions across {visible.length} {visible.length === 1 ? 'source' : 'sources'}</p>
      <ul className="blocking-report-legend" aria-label="What each block type means">
        {columns.map(({ value, label, description }) => (
          <li key={value} data-category={value}><i aria-hidden="true" /><div><strong>{label}</strong><br />{description}</div></li>
        ))}
      </ul>
      {visible.length ? <>
        <SourceChart rows={visible} columns={columns} />
        <div className="blocking-report-table" tabIndex={0} role="region" aria-label="Blocked activity by source">
          <table>
            <thead><tr><th scope="col">Source</th>{columns.map(({ value, label }) => <th scope="col" key={value}>{label}</th>)}<th scope="col">Total</th></tr></thead>
            <tbody>{visible.map(({ id, label, counts, total: sourceTotal }) => (
              <tr key={id}><th scope="row">{label}</th>{columns.map(({ value, index }) => <td key={value}>{format.format(counts[index])}</td>)}<td>{format.format(sourceTotal)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </> : <p role="status">No blocks match these filters.</p>}
    </div>
  );
}

function SourceChart({ rows, columns }: { rows: Row[]; columns: Column[] }) {
  const interval = Math.max(1, rows[0].total / 4);
  const power = 10 ** Math.floor(Math.log10(interval));
  const step = power * ([1, 2, 5, 10].find(value => value * power >= interval) ?? 10);
  const max = 4 * step;
  return <figure className="blocking-report-chart" aria-label="Blocks by source">
    <figcaption>{rows.length > 8 ? 'Top 8 sources by blocked actions' : 'Blocked actions by source'}</figcaption>
    <ul aria-label="Source totals">
      {rows.slice(0, 8).map(row => (
        <li key={row.id}>
          <span title={row.label}>{row.label}</span>
          <div className="blocking-report-track" aria-hidden="true">
            {columns.map(({ value, label, index }) => (
              <i key={value} data-category={value} title={label + ' · ' + format.format(row.counts[index])}
                style={{ width: (100 * row.counts[index] / max) + '%' }} />
            ))}
          </div>
          <strong>{format.format(row.total)}</strong>
        </li>
      ))}
    </ul>
    <div className="blocking-report-axis" aria-hidden="true"><div>
      {[0, 1, 2, 3, 4].map(index => <span key={index}>{format.format(step * index)}</span>)}
    </div></div>
  </figure>;
}
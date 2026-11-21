import { BarChart3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AdblockStats } from '../../../app/shared/types';
import { useSources } from '../lib/queries';
import { Select } from './controls';
import '../styles/blocking-activity.css';

const categories = [
  { value: 'blocked', label: 'Network filters' },
  { value: 'securityBlocked', label: 'Security rules' },
  { value: 'popupsBlocked', label: 'Popups' },
] as const;

type Category = (typeof categories)[number]['value'];
const allSources = 'all';
const format = new Intl.NumberFormat();

export function BlockingActivityReport({ stats }: { stats: AdblockStats }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="blocking-report">
      <div className="blocking-report-heading">
        <div>
          <h3><BarChart3 size={17} /> Blocking activity</h3>
          <p>Explore requests and popups blocked in this session.</p>
        </div>
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
  const columns = categories.map(({ value, label }, index) => ({ value, label, index }))
    .filter(({ value }) => category === 'all' || value === category);
  const visible = rows.filter(({ id, counts }) => (selected === allSources || selected === id)
    && columns.some(({ index }) => counts[index] > 0));
  const totals = columns.map(({ index }) => visible.reduce((sum, row) => sum + row.counts[index], 0));
  const max = Math.max(1, ...totals);

  return (
    <div id="blocking-report-content" className="blocking-report-content">
      <div className="blocking-report-filters">
        <Select value={selected} onChange={setSource} ariaLabel="Filter report by source"
          options={[{ value: allSources, label: 'All sources' }, ...rows.map(({ id, label }) => ({ value: id, label }))]} />
        <Select value={category} onChange={setCategory} ariaLabel="Filter report by category"
          options={[{ value: 'all', label: 'All activity' }, ...categories]} />
      </div>
      <ul className="blocking-report-chart" aria-label="Blocked activity by category">
        {columns.map(({ value, label }, index) => (
          <li key={value} data-category={value}>
            <span>{label}</span>
            <div className="blocking-report-track" aria-hidden="true"><div style={{ width: (100 * totals[index] / max) + '%' }} /></div>
            <strong>{format.format(totals[index])}</strong>
          </li>
        ))}
      </ul>
      {visible.length ? (
        <div className="blocking-report-table" tabIndex={0} role="region" aria-label="Blocked activity by source">
          <table>
            <thead><tr><th scope="col">Source</th>{columns.map(({ value, label }) => <th scope="col" key={value}>{label}</th>)}</tr></thead>
            <tbody>{visible.map(({ id, label, counts }) => (
              <tr key={id}><th scope="row">{label}</th>{columns.map(({ value, index }) => <td key={value}>{format.format(counts[index])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p role="status">No blocks match these filters.</p>}
    </div>
  );
}
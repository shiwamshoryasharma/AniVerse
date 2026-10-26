import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Palette, Save, Upload, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { call, errorText } from '../lib/bridge';
import { keys } from '../lib/queries';
import { useToast } from '../lib/useToast';
import { ErrorState } from './common';

export function ThemePresets() {
  const [name, setName] = useState('My theme');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const result = useQuery({ queryKey: ['themes'], queryFn: () => call('themes.list') });
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await qc.invalidateQueries({ queryKey: ['themes'] });
    } catch (e) {
      toast.push({ level: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-group">
      <h3>Theme presets</h3>
      <div className="card card-pad stack">
        <div className="workspace-banner violet">
          <Palette />
          <div>
            <h2>Make it feel like yours</h2>
            <p>
              Presets include accent, density, UI font, motion, theater mode and quality preference. Account data, source lists, notes and private paths are
              excluded.
            </p>
          </div>
        </div>
        <div className="row wrap">
          <input className="input grow" aria-label="Theme name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void run(() => call('themes.save', { name }))}>
            <Save size={14} />
            Save current
          </button>
          <button className="btn" disabled={busy} onClick={() => void run(() => call('themes.import'))}>
            <Upload size={14} />
            Import JSON
          </button>
        </div>
        {result.error && <ErrorState error={result.error} onRetry={() => void result.refetch()} />}
        {result.data?.map((t) => (
          <div className="row wrap theme-preset" key={t.id}>
            <span className={'preset-dot ' + t.preset.appearance.accent} />
            <div className="grow">
              <strong>{t.preset.name}</strong>
              <p className="faint">
                {t.preset.appearance.fontFamily} · {t.preset.appearance.density} · {t.preset.player.preferredQuality}
              </p>
            </div>
            <button
              className="btn sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const settings = await call('themes.apply', { id: t.id });
                  qc.setQueryData(keys.settings, settings);
                })
              }
            >
              Apply
            </button>
            <button className="btn sm" disabled={busy} onClick={() => void run(() => call('themes.export', { id: t.id }))}>
              <Download size={14} />
              Export
            </button>
            <button
              className="icon-btn"
              aria-label={'Delete ' + t.preset.name}
              disabled={busy}
              onClick={() => void run(() => call('themes.delete', { id: t.id }))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!result.data?.length && <p className="faint">Choose an appearance in Profile & appearance, then save your first preset.</p>}
      </div>
    </section>
  );
}

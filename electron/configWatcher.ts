import { readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseSitesConfig, type ParsedSitesConfig } from '../app/core/config/sitesConfig';

/** Reads `streaming-sites.txt` and reloads it whenever the file changes on disk. */
export class SitesConfigWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastText = '';

  constructor(
    private file: string,
    private onChange: (parsed: ParsedSitesConfig) => void,
  ) {}

  load(): ParsedSitesConfig {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      return { entries: [], warnings: [`Could not read ${this.file}: ${(err as Error).message}`] };
    }
    this.lastText = text;
    const parsed = parseSitesConfig(text);
    for (const w of parsed.warnings) console.warn(`[config] ${w}`);
    return parsed;
  }

  start() {
    // Watch the directory: editors often replace the file instead of writing in place.
    this.watcher = watch(path.dirname(this.file), (_event, name) => {
      if (name && name.toString() !== path.basename(this.file)) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 300);
    });
  }

  reload(force = false): ParsedSitesConfig | null {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    if (!force && text === this.lastText) return null;
    const parsed = this.load();
    this.onChange(parsed);
    return parsed;
  }

  stop() {
    this.watcher?.close();
  }
}

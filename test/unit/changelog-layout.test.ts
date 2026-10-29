import { describe, expect, it } from 'vitest';
import { Store } from '../../app/core/db/store';
import { ChangelogService } from '../../app/core/changelog';
import { CURRENT_RELEASE, RELEASES } from '../../app/shared/changelog';
import { INTERFACE_STYLES, interfaceStyle } from '../../app/shared/interface';
import pkg from '../../package.json';

describe('bundled release announcements', () => {
  it('requires offline release notes for the version being shipped', () => {
    expect(CURRENT_RELEASE.version).toBe(pkg.version);
    expect(CURRENT_RELEASE.items.length).toBeGreaterThan(0);
    expect(new Set(RELEASES.map((r) => r.version)).size).toBe(RELEASES.length);
    for (const release of RELEASES) for (const item of release.items) {
      expect(['added', 'improved', 'fixed']).toContain(item.kind);
      if (item.action) expect(item.action.path).toMatch(/^\/(?:settings|library|workspace|player|browse)(?:\/|$)/);
    }
  });
  it('announces a new version once per profile and retains acknowledgement after restart', () => {
    const store = new Store(':memory:');
    const service = new ChangelogService(store, '1.5.3');
    expect(service.state()).toMatchObject({ version: '1.5.3', unread: true });
    expect(() => service.markSeen('99.0.0')).toThrow();
    service.markSeen('1.5.3');
    expect(new ChangelogService(store, '1.5.3').state().unread).toBe(false);
    store.setKv('changelog:lastSeen', '1.5.2');
    expect(service.state().unread).toBe(true);
    store.close();
  });
  it('does not break test/custom versions without bundled release notes', () => {
    const store = new Store(':memory:');
    expect(new ChangelogService(store, '90.0.0').state().unread).toBe(false);
    store.close();
  });
});
describe('interface styles select different layouts, independently of accent', () => {
  it('keeps legacy style IDs and the original Classic interface', () => {
    expect(interfaceStyle('classic').layout).toBe('classic');
    expect(interfaceStyle('aurora').layout).toBe('studio');
    expect(interfaceStyle('paper').layout).toBe('cinema');
    expect(interfaceStyle('unknown').layout).toBe('classic');
    expect(new Set(INTERFACE_STYLES.map((s) => s.layout)).size).toBe(3);
  });
});

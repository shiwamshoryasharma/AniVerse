import type { RawSiteOption } from './sitePage';

// Runs in the source page before the audio inspection restores player-only CSS.
export function desktopAudioOptions(raw: RawSiteOption[]): RawSiteOption[] {
  const options = raw.map(option => {
    const el = document.querySelector('[data-aniverse-pick="' + option.pick + '"]');
    const namedServer = el?.tagName === 'BUTTON' && /^Switch to .{1,30} server$/i.test(el.getAttribute('aria-label') ?? '');
    if (!namedServer) return option;
    const active = option.active || (el.classList.contains('bg-primary') && el.classList.contains('text-black'));
    // A separately selectable hard-sub server can coexist with SUB and DUB server groups.
    if (option.kind === 'type' && /^h-?sub$/i.test(option.label)) return { ...option, kind: 'server' as const, group: 'sub', active };
    return { ...option, active };
  });
  const servers = options.filter(option => option.kind === 'server');
  const groups = [...new Set(servers.map(server => server.group).filter((group): group is string => !!group))];
  const current = servers.find(server => server.group && server.active);
  for (const group of groups) {
    const direct = options.find(option => option.kind === 'type' && option.value === group);
    if (direct) {
      if (current?.group === group && !options.some(option => option.kind === 'type' && option.active)) {
        options[options.indexOf(direct)] = { ...direct, active: true };
      }
    } else if (groups.length > 1) {
      const target = servers.find(server => server.group === group && server.value === current?.value)
        ?? servers.find(server => server.group === group);
      if (target) options.push({ ...target, kind: 'type', label: group.toUpperCase(), value: group, active: current?.group === group, group: null });
    }
  }
  return options;
}

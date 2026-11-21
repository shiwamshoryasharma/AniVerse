import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const shared = await readFile(path.join(root, 'app/shared/rpc.ts'), 'utf8');
const syntax = ts.createSourceFile('rpc.ts', shared, ts.ScriptTarget.Latest, true);
const contract = syntax.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'RpcContract');
if (!contract) throw new Error('Shared desktop RPC contract is missing.');
const methods = contract.members.flatMap(member => member.name && ts.isStringLiteral(member.name) ? [member.name.text] : []);

const native = path.join(root, 'native/aniverse2/src');
const files = (await readdir(native, {recursive: true})).filter(name => /\.(rs|js)$/.test(name));
const text = (await Promise.all(files.map(name => readFile(path.join(native, name), 'utf8')))).join('\n');
const mentioned = new Set([...text.matchAll(/"([a-z]+\.[A-Za-z][A-Za-z0-9]*)"/g)].map(match => match[1]));
const bridgeOnly = new Set(['update.migrateToAniVerse2']);
const unrouted = methods.filter(name => !mentioned.has(name) && !bridgeOnly.has(name)).sort();
const limited = new Map([
  ['settings.set', 'The native writer supports a limited settings subset. Migrated fields remain stored.'],
  ['sources.match', 'Rendered website entry matching is supported. Official channel episode matching remains incomplete.'],
  ['privacy.incognito', 'Incognito uses isolated source views. Saved source session management requires exiting incognito.'],
  ['accounts.connect', 'Dedicated AniVerse2 OAuth callbacks are tested offline. New sign-in requires registered public client IDs and live provider checks.'],
  ['accounts.sync', 'Native manual and background sync and migrated credentials passed isolated tests. Live provider mutations were not exercised.'],
  ['cast.devices', 'Native mDNS packet tests passed. Physical LAN discovery has not been validated.'],
  ['cast.start', 'Chrome tab casting is connected through the private pipe. Direct receiver playback, a live TV session and sender-side 4K remain unverified.'],
  ['player.capturePrepare', 'Native capture is scoped to the selected owned WebView and accessible, unprotected video. Opaque iframe and source audio capture remain unsupported.'],
  ['player.upscale', 'Direct readable video is supported. Compatibility capture for protected or cross-origin video is unavailable.'],
  ['adblock.stats', 'Network filter and mandatory denial counters are separate. Ghostery cosmetic rules, scriptlets and replacement behavior remain unported.'],
  ['app.info', 'The UI rendering preference is reported. The legacy adapter and decoder inventory remains incomplete.'],
]);
const groups = Object.fromEntries([...new Set(unrouted.map(method => method.split('.')[0]))]
  .map(group => [group, unrouted.filter(method => method.startsWith(group + '.'))]));
const reports = {};
for (const name of ['aniverse2-rendered-player', 'aniverse2-mp4-validation', 'aniverse2-metadata-validation', 'aniverse2-local-player-validation', 'aniverse2-release-readiness-windows', 'aniverse2-windows-final-qa-installer', 'aniverse2-rendered-catalogue', 'aniverse2-live-redirect', 'aniverse2-live-source', 'aniverse2-native-save-windows', 'aniverse2-migration-followup', 'aniverse2-workspace', 'aniverse2-credentials-runtime', 'aniverse2-source-session-windows', 'aniverse2-source-discovery-followup', 'aniverse2-integrations-native-tests', 'aniverse2-ui-rendering', 'aniverse2-private-title-windows', 'aniverse2-incognito-windows', 'aniverse2-upscale-followup', 'aniverse2-network-adblock-windows', 'aniverse2-windows-cast', 'aniverse2-electron-session-export-windows', 'aniverse2-player-capture-windows', 'aniverse2-website-session-import-windows']) {
  try {
    const result = JSON.parse(await readFile(path.join(root, 'test/artifacts', name + '.json'), 'utf8'));
    reports[name] = result.passed ?? result.pass ?? result.metadataValidation ?? null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    reports[name] = null;
  }
}
const report = {
  productionParityEstablished: false,
  scope: 'Static Windows RPC coverage and recorded targeted runtime checks. A handler name does not establish behavioral parity.',
  sharedDesktopMethods: methods.length,
  electronBridgeOnly: [...bridgeOnly],
  missingNativeMethodLiterals: unrouted.length,
  unrouted: groups,
  limited: Object.fromEntries([...limited].filter(([method]) => !unrouted.includes(method))),
  targetedReports: reports,
  deploymentGaps: [
    'The handoff verifies staged profile contents and the bundled React app can open the copied settings, sources and history. The deployed legacy bridge still lacks an authenticated uninstaller handoff and exclusive cutover lease.',
    'Test fixtures verified a future-bridge export and WebView2 import for eligible HTTPS source cookies. Deployed 2.2.4 cannot supply that archive, and other browser storage remains out of scope.',
    'A signed production installer and update of this candidate have not been validated.',
  ],
};
const directory = path.join(root, 'test/artifacts');
await mkdir(directory, {recursive: true});
await writeFile(path.join(directory, 'aniverse2-production-parity.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({contract: methods.length, unrouted: unrouted.length, groups: Object.keys(groups)}, null, 2));
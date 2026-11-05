// Compile the pinned upstream DNS rules without network access. Source identities are never read.
// Download a reviewed snapshot into test/cache, then: node scripts/prepare-android-adfilter.mjs <snapshot.txt>
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=process.argv[2];if(!input)throw Error('Provide the reviewed upstream snapshot file under test/cache.');
const file=path.resolve(input),cache=path.join(root,'test/cache')+path.sep;
if(!file.startsWith(cache))throw Error('Keep fetched filter snapshots under this checkout test/cache.');
const raw=readFileSync(file),sha=createHash('sha256').update(raw).digest('hex');
const expected='4c5ce6f4d96ac3830c5327c1cf675b7bd7335838e17da8d3b2936d7730abf229';
if(sha!==expected)throw Error('Snapshot differs from the reviewed pin. Review the upstream change and update this pin explicitly.');
const upstream=raw.toString('utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('!'));
const custom=readFileSync(path.join(root,'config/filters.txt'),'utf8').split(/\r?\n/).map(line=>line.trim());
const disabled=new Set(upstream.filter(line=>line.endsWith('$badfilter')).map(line=>line.slice(0,-10)));
const rules=new Set();let skipped=0;
for(const line of [...upstream,...custom]){
 if(!line||line.startsWith('!')||line.startsWith('##')||disabled.has(line)||line.endsWith('$badfilter'))continue;
 const match=line.match(/^(@@)?\|\|([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\^(\$important)?$/);
 if(!match){skipped++;continue;}
 rules.add((match[1]?'-':match[3]?'!':'+')+match[2].toLowerCase());
}
const assets=path.join(root,'android/app/src/main/assets');mkdirSync(assets,{recursive:true});
writeFileSync(path.join(assets,'ad-domains.bin'),gzipSync([...rules].sort().join('\n')+'\n',{level:9}));
writeFileSync(path.join(assets,'ad-cosmetics.css'),custom.filter(line=>line.startsWith('##')).map(line=>line.slice(2)).join(',\n')+' { display:none !important; visibility:hidden !important; pointer-events:none !important; }\n');
console.log(JSON.stringify({sourceSHA256:sha,entries:rules.size,omittedRules:skipped}));

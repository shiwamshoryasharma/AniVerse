import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function prepareSecurity(){
 const target=path.join(root,'test/cache/rust-security');
 const env={...process.env,CARGO_TARGET_DIR:target,CARGO_HOME:path.join(root,'test/cache/cargo'),CARGO_INCREMENTAL:'0',
   RUSTFLAGS:'-C link-arg=--max-memory=8388608 -C link-arg=-zstack-size=262144'};
 execFileSync('cargo',['build','--locked','--manifest-path',path.join(root,'native/security/Cargo.toml'),'--target','wasm32-unknown-unknown','--release'],{cwd:root,env,stdio:'inherit',windowsHide:true});
 const bytes=readFileSync(path.join(target,'wasm32-unknown-unknown/release/aniverse_security.wasm'));
 const output=path.join(root,'dist/electron');mkdirSync(output,{recursive:true});
 copyFileSync(path.join(target,'wasm32-unknown-unknown/release/aniverse_security.wasm'),path.join(output,'security.wasm'));
 const metadata=JSON.parse(execFileSync('cargo',['metadata','--offline','--locked','--format-version','1','--manifest-path',path.join(root,'native/security/Cargo.toml')],{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true}));
 const notices=['AniVerse embedded Rust policy dependency notices\nCargo.lock pins the exact source versions. Build-time dependencies are included conservatively.\n'];
 for(const dependency of metadata.packages.filter(item=>item.name!=='aniverse-security')){
  const directory=path.dirname(dependency.manifest_path);
  const licenses=readdirSync(directory).filter(name=>/^(licen[cs]e|copying|copyright)/i.test(name)&&!name.endsWith('.toml'));
  if(dependency.license_file&&existsSync(path.resolve(directory,dependency.license_file)))licenses.push(dependency.license_file);
  const texts=[...new Set(licenses)].map(name=>readFileSync(path.resolve(directory,name),'utf8'));
  if(!texts.length)throw Error('Missing dependency license: '+dependency.name);
  notices.push('\n=== '+dependency.name+' '+dependency.version+' · '+dependency.license+' ===\n'+texts.join('\n'));
 }
 writeFileSync(path.join(output,'security-LICENSES.txt'),notices.join('\n'));
 writeFileSync(path.join(output,'security-manifest.json'),JSON.stringify({abi:1,sha256:createHash('sha256').update(bytes).digest('hex'),maxInputBytes:16384,maxMemoryBytes:8388608})+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareSecurity();

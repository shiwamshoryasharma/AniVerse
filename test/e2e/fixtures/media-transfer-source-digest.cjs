const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function workerSourceDigest(source) {
  const names = ['native/media-transfer/Cargo.toml','native/media-transfer/Cargo.lock',
    'native/security/Cargo.toml','native/security/Cargo.lock','native/security/src/lib.rs'];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(source,relative),{withFileTypes:true})) {
      const name = relative + '/' + entry.name;
      if(entry.isDirectory()) walk(name);
      else if(entry.isFile() && entry.name.endsWith('.rs')) names.push(name);
    }
  };
  walk('native/media-transfer/src');
  names.sort();
  const hash=createHash('sha256');
  for(const name of names){hash.update(name);hash.update('\0');hash.update(fs.readFileSync(path.join(source,name)));hash.update('\0');}
  return {sha256:hash.digest('hex'),algorithm:'sha256 of sorted relative path, NUL, exact file bytes, NUL',files:names};
}
module.exports={workerSourceDigest};
if(require.main===module) console.log(JSON.stringify(workerSourceDigest(path.resolve(process.argv[2]||path.join(__dirname,'source')))));

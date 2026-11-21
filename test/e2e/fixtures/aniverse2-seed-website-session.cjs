const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const cache = fs.realpathSync(path.resolve(__dirname, '../../cache/aniverse2'));
const cwd = fs.realpathSync(process.env.ANIVERSE2_COOKIE_FIXTURE);
const attempt = fs.realpathSync(process.env.ANIVERSE2_COOKIE_ATTEMPT);
const nonce = process.env.ANIVERSE2_COOKIE_NONCE;
const fixturePath = path.relative(cache, cwd).split(path.sep);
const attemptPath = path.relative(cwd, attempt).split(path.sep);
if (fixturePath.length !== 2 || !fixturePath[0].startsWith('desktop-') || fixturePath[1] !== 'legacy' ||
    attemptPath.length !== 2 || attemptPath[0] !== 'windows-migration' || !attemptPath[1].startsWith('attempt-') ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(nonce)) {
  throw new Error('Refusing to use a non-test migration path.');
}
const identity = 'f'.repeat(32);
app.setPath('userData', cwd);
app.setPath('sessionData', cwd);
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Fixture needs the Windows local credential vault.');
  fs.writeFileSync(path.join(cwd, 'profile.id'), identity);
  const packets = {};
  const packet = (origin, source) => ({
    schema:1, nonce, source, origin, cookies:[{
      name:'auth_cookie_fixture',value:'synthetic-scope-fixture',path:'/',httpOnly:true,expires:Date.now()/1000+604800,sameSite:'Lax',
    }],
  });
  const seal = (record) => 'enc2:' + safeStorage.encryptString(identity + '\n' + JSON.stringify(record)).toString('base64');
  packets['sample-test'] = seal(packet('https://www.sample.test', 'sample-test'));
  packets['sample-test-2'] = seal(packet('https://wrong-host.test', 'sample-test-2'));
  packets['recipe-test'] = seal(packet('https://recipe.test', 'recipe-test'));
  fs.writeFileSync(path.join(attempt,'website-sessions.json'), JSON.stringify(packets));
  app.quit();
}).catch((error) => { console.error(error.message); app.exit(1); });

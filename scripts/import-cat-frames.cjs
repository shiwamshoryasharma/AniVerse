// Imports the six running-cat drawings (01.png … 06.png, transparent PNGs) from a
// folder into frontend/src/assets/cat/ as frame-01.webp … frame-06.webp, downscaled
// and re-sequenced into gallop order (see GAIT).
// Run: npx electron scripts/import-cat-frames.cjs <folder>   (CAT_SHEET=<png> also writes a contact sheet)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 400;
const OUT = path.join(__dirname, '..', 'frontend', 'src', 'assets', 'cat');
// The drawings' numbering is not the stride order: 02/04 are both "front paws landing" and
// 03/06 both "stretched out", so 1→6 rocks back and forth. One gallop stride is
// push-off (01) → full stretch (03) → reach (06) → landing (04, 02) → gathered (05) → 01 …
const GAIT = ['01', '03', '06', '04', '02', '05'];

app.whenReady().then(async () => {
  const dir = path.resolve(process.argv[process.argv.length - 1]);
  const files = GAIT.map((n) => path.join(dir, `${n}.png`));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`missing frames: ${missing.join(', ')}`);
    app.exit(1);
    return;
  }
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const sources = files.map((f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
  const { frames, sheet } = await win.webContents.executeJavaScript(`(async () => {
    const S = ${SIZE};
    const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('could not decode a frame')); i.src = src; });
    const canvas = () => { const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; return [c, g]; };
    const drawings = await Promise.all(${JSON.stringify(sources)}.map(load));
    const out = [];
    drawings.forEach((img) => {
      const [c, g] = canvas();
      g.drawImage(img, 0, 0, S, S);
      out.push(c);
    });
    const sheet = document.createElement('canvas');
    sheet.width = 6 * 160; sheet.height = 160;
    const gs = sheet.getContext('2d');
    gs.fillStyle = '#07080b'; gs.fillRect(0, 0, sheet.width, sheet.height);
    out.forEach((c, i) => gs.drawImage(c, (i % 6) * 160, Math.floor(i / 6) * 160, 160, 160));
    return { frames: out.map((c) => c.toDataURL('image/webp', 0.9).split(',')[1]), sheet: sheet.toDataURL('image/png').split(',')[1] };
  })()`);
  fs.mkdirSync(OUT, { recursive: true });
  // Write-then-rename so a running Vite dev server never reads a half-written frame.
  frames.forEach((b64, i) => {
    const file = path.join(OUT, `frame-${String(i + 1).padStart(2, '0')}.webp`);
    fs.writeFileSync(`${file}.tmp`, Buffer.from(b64, 'base64'));
    fs.renameSync(`${file}.tmp`, file);
  });
  if (process.env.CAT_SHEET) fs.writeFileSync(process.env.CAT_SHEET, Buffer.from(sheet, 'base64'));
  console.log(`wrote ${frames.length} frames to ${OUT}`);
  app.quit();
});

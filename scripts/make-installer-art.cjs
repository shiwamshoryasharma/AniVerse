// Installer artwork for the NSIS setup (build/installer.nsh).
//
//   npx electron scripts/make-installer-art.cjs --import <6 images…>
//       copies wallpapers into assets/installer/wallpaper-1..6.jpg (the source of truth, committed)
//   npx electron scripts/make-installer-art.cjs
//       renders build/installer/*.bmp from those wallpapers (run by `npm run dist`)
//
// Outputs (24-bit BMP, the only format NSIS can show):
//   welcome-N.bmp  full-page wallpaper for the welcome/finish pages, with the AniVerse
//                  wordmark and a dark fade at the bottom where the page text sits
//   header-N.bmp   strip for the header of the inner pages
//   sidebar.bmp    compile-time default (the installer swaps in a random wallpaper at run time)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ASSETS = path.join(root, 'assets', 'installer');
const OUT = path.join(root, 'build', 'installer');
const COUNT = 6;
// NSIS page sizes at 96 DPI (welcome/finish page 497x314, header image 150x57), rendered at 1.5x.
const WELCOME = { w: 746, h: 471 };
const HEADER = { w: 225, h: 86 };
const SIDEBAR = { w: 246, h: 471 };
// Horizontal focus (0 = left, 1 = right) so each character stays in frame.
const FOCUS = [0.4, 0.45, 0.6, 0.38, 0.4, 0.5];

/** 24-bit bottom-up BMP from RGBA pixels. */
function bmp(width, height, rgba) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * height);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * height, 34);
  buf.writeInt32LE(3780, 38);
  buf.writeInt32LE(3780, 42);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      buf[dst + x * 3] = rgba[s + 2];
      buf[dst + x * 3 + 1] = rgba[s + 1];
      buf[dst + x * 3 + 2] = rgba[s];
    }
  }
  return buf;
}

const writeAtomic = (file, data) => {
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const run = (code) => win.webContents.executeJavaScript(code);
  const imports = process.argv.slice(process.argv.indexOf('--import') + 1).filter((a) => !a.startsWith('--'));

  if (process.argv.includes('--import')) {
    if (imports.length !== COUNT) throw new Error(`--import needs exactly ${COUNT} images`);
    fs.mkdirSync(ASSETS, { recursive: true });
    for (const [i, file] of imports.entries()) {
      const src = `data:image/png;base64,${fs.readFileSync(path.resolve(file)).toString('base64')}`;
      const jpg = await run(`new Promise((resolve) => { const img = new Image(); img.onload = () => {
        const w = Math.min(1600, img.width), h = Math.round(img.height * w / img.width);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.9).split(',')[1]); }; img.src = ${JSON.stringify(src)}; })`);
      writeAtomic(path.join(ASSETS, `wallpaper-${i + 1}.jpg`), Buffer.from(jpg, 'base64'));
    }
    console.log(`imported ${COUNT} wallpapers into ${ASSETS}`);
    app.quit();
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(root, 'build', 'icon.png')).toString('base64')}`;
  for (let i = 1; i <= COUNT; i++) {
    const file = path.join(ASSETS, `wallpaper-${i}.jpg`);
    if (!fs.existsSync(file)) throw new Error(`missing ${file} (run with --import first)`);
    const src = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
    const out = await run(`(async () => {
      const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = s; });
      const [img, logo] = await Promise.all([load(${JSON.stringify(src)}), load(${JSON.stringify(icon)})]);
      const BG = 'rgba(13,14,23,';
      const cover = (g, w, h, fx, fy) => {
        const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
        g.drawImage(img, (img.width - sw) * fx, (img.height - sh) * fy, sw, sh, 0, 0, w, h);
      };
      const pixels = (c) => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
      const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; return [c, g]; };

      // Welcome / finish page
      const W = ${WELCOME.w}, H = ${WELCOME.h};
      const [wc, wg] = canvas(W, H);
      cover(wg, W, H, ${JSON.stringify(FOCUS)}[${i - 1}], 0.4);
      let gr = wg.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, BG + '0.6)'); gr.addColorStop(0.2, BG + '0)'); gr.addColorStop(0.4, BG + '0)');
      gr.addColorStop(0.64, BG + '0.74)'); gr.addColorStop(0.84, BG + '0.95)'); gr.addColorStop(1, BG + '1)');
      wg.fillStyle = gr; wg.fillRect(0, 0, W, H);
      gr = wg.createLinearGradient(0, 0, W * 0.7, 0);
      gr.addColorStop(0, BG + '0.45)'); gr.addColorStop(1, BG + '0)');
      wg.fillStyle = gr; wg.fillRect(0, H * 0.5, W, H * 0.5);
      // wordmark: icon + "Ani" white + "Verse" accent, like the app header
      const L = Math.round(H * 0.085), x0 = Math.round(W * 0.055), y0 = Math.round(H * 0.06);
      wg.drawImage(logo, x0, y0, L, L);
      wg.font = '800 ' + Math.round(L * 0.78) + 'px "Segoe UI", sans-serif'; wg.textBaseline = 'middle';
      wg.fillStyle = '#ffffff'; wg.fillText('Ani', x0 + L * 1.25, y0 + L / 2);
      const ani = wg.measureText('Ani').width;
      const vg = wg.createLinearGradient(x0 + L * 1.25 + ani, 0, x0 + L * 1.25 + ani + L * 2.4, 0);
      vg.addColorStop(0, '#a78bfa'); vg.addColorStop(1, '#60a5fa');
      wg.fillStyle = vg; wg.fillText('Verse', x0 + L * 1.25 + ani, y0 + L / 2);
      // accent bar above the title
      const bar = wg.createLinearGradient(x0, 0, x0 + W * 0.09, 0);
      bar.addColorStop(0, '#8b5cf6'); bar.addColorStop(1, '#4f7cff');
      wg.fillStyle = bar; wg.fillRect(x0, Math.round(H * 0.555), Math.round(W * 0.09), Math.max(3, Math.round(H * 0.008)));

      // Header strip, fading into the header colour on the left
      const [hc, hg] = canvas(${HEADER.w}, ${HEADER.h});
      cover(hg, ${HEADER.w}, ${HEADER.h}, ${JSON.stringify(FOCUS)}[${i - 1}], 0.35);
      gr = hg.createLinearGradient(0, 0, ${HEADER.w} * 0.55, 0);
      gr.addColorStop(0, BG + '1)'); gr.addColorStop(1, BG + '0)');
      hg.fillStyle = gr; hg.fillRect(0, 0, ${HEADER.w}, ${HEADER.h});

      const out = { welcome: pixels(wc), header: pixels(hc) };
      if (${i} === 2) {
        const [sc, sg] = canvas(${SIDEBAR.w}, ${SIDEBAR.h});
        cover(sg, ${SIDEBAR.w}, ${SIDEBAR.h}, 0.42, 0.4);
        gr = sg.createLinearGradient(0, 0, 0, ${SIDEBAR.h});
        gr.addColorStop(0.55, BG + '0)'); gr.addColorStop(1, BG + '0.9)');
        sg.fillStyle = gr; sg.fillRect(0, 0, ${SIDEBAR.w}, ${SIDEBAR.h});
        out.sidebar = pixels(sc);
      }
      return out;
    })()`);
    writeAtomic(path.join(OUT, `welcome-${i}.bmp`), bmp(WELCOME.w, WELCOME.h, out.welcome));
    writeAtomic(path.join(OUT, `header-${i}.bmp`), bmp(HEADER.w, HEADER.h, out.header));
    if (out.sidebar) writeAtomic(path.join(OUT, 'sidebar.bmp'), bmp(SIDEBAR.w, SIDEBAR.h, out.sidebar));
  }
  console.log(`rendered installer art for ${COUNT} wallpapers into ${OUT}`);
  app.quit();
});

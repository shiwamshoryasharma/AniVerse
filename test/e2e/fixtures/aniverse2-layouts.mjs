import assert from 'node:assert/strict';

export async function checkLayouts(context, page) {
  await page.evaluate(() => { location.hash = '#/settings/themes'; });
  const group = page.getByRole('group', { name: 'Interface layouts' });
  await group.waitFor();
  assert.equal(await group.getByRole('button').count(), 5);
  const initial = group.getByRole('button', { pressed: true });
  const active = (await initial.getAttribute('class')).split(' ').find(
    name => ['classic', 'aurora', 'paper', 'dock', 'atlas'].includes(name),
  );
  assert.ok(active, 'The migrated layout should be selected.');

  const select = async (name) => {
    await group.locator('button.theme-style.' + name).click();
    await page.waitForFunction(() => document.querySelector('.theme-style.selected')?.getAttribute('aria-pressed') === 'true');
  };
  const cdp = await context.newCDPSession(page);
  const resize = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.waitForFunction(expected => innerWidth === expected, width);
  };
  const bounds = () => page.evaluate(() => {
    const rail = document.querySelector('.app .rail').getBoundingClientRect();
    const main = document.querySelector('.app .main').getBoundingClientRect();
    const close = document.querySelector('.tauri-window-controls button:last-child')?.getBoundingClientRect();
    return {
      docked: rail.top >= main.bottom - 1 && rail.bottom <= innerHeight + 1,
      rightRail: rail.left >= main.right - 1 && rail.right <= innerWidth + 1,
      mainFits: main.left >= -1 && main.right <= innerWidth + 1 && main.bottom <= innerHeight + 1,
      controlsFit: close?.right <= innerWidth + 1,
    };
  });

  try {
    await resize(1440, 900);
    await select('dock');
    await page.locator('.app.layout-dock').waitFor();
    assert.ok((await bounds()).docked, 'Dock should occupy its own row under the page.');
    await page.reload();
    await group.locator('button.theme-style.dock[aria-pressed="true"]').waitFor();
    await page.locator('.app.layout-dock').waitFor();
    await resize(640, 480);
    const dock = await bounds();
    assert.ok(dock.docked && dock.mainFits && dock.controlsFit, JSON.stringify(dock));

    await resize(1440, 900);
    await select('atlas');
    await page.locator('.app.layout-atlas').waitFor();
    assert.ok((await bounds()).rightRail, 'Atlas should put navigation to the right of the page.');
    await resize(640, 480);
    const atlas = await bounds();
    assert.ok(atlas.rightRail && atlas.mainFits && atlas.controlsFit, JSON.stringify(atlas));
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await select(active);
    await group.locator('button.theme-style.' + active + '[aria-pressed="true"]').waitFor();
  }
}

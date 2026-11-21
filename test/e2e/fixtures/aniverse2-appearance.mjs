import assert from 'node:assert/strict';

const THEMES = [
  ['dark', 'Dark', 'dark', '#101217'],
  ['light', 'Light', 'light', '#f5f7fb'],
  ['github-dimmed', 'GitHub Dimmed', 'dark', '#22272e'],
  ['vscode', 'VS Code Dark+', 'dark', '#1e1e1e'],
];

export async function checkAppearance(context, page) {
  await page.evaluate(() => { location.hash = '#/settings/themes'; });
  const themes = page.getByRole('group', { name: 'AniVerse2 themes' });
  const layouts = page.getByRole('group', { name: 'Interface layouts' });
  const profile = page.locator('.profile-chip');
  const rail = page.getByRole('navigation', { name: 'Main', exact: true });
  const chooseTheme = async (id, name) => {
    const button = themes.getByRole('button', { name, exact: true });
    await button.click();
    assert.equal(await page.locator('html').getAttribute('data-aniverse2-theme'), id);
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
  };
  const chooseLayout = async (id, layout) => {
    await layouts.locator('button.theme-style.' + id).click();
    await page.locator('.app.layout-' + layout).waitFor();
    await layouts.locator('button.theme-style.' + id + '[aria-pressed="true"]').waitFor();
    assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'light');
  };
  const cdp = await context.newCDPSession(page);
  const resize = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
  };
  const evidence = { palettes: {}, verticalNavigation: {}, horizontalNavigation: {} };

  try {
    await resize(1440, 900);
    for (const [id, name, scheme, base] of THEMES) {
      await chooseTheme(id, name);
      await profile.click();
      await page.getByRole('menu').waitFor();
      const colors = await measurePalette(page);
      await profile.click();
      assert.equal(colors.scheme, scheme, name + ' native colour scheme');
      assert.equal(colors.base, base, name + ' page token');
      for (const [surface, value] of Object.entries(colors.contrast)) {
        assert.ok(value >= 4.5, name + ' ' + surface + ' contrast was ' + value);
      }
      evidence.palettes[id] = colors;
    }
    await chooseTheme('light', 'Light');
    await page.getByText('Custom colours', { exact: true }).click();
    await page.getByRole('group', { name: 'Header colour palette' }).getByRole('button', { name: 'Ink', exact: true }).click();
    await page.reload();
    await themes.getByRole('button', { name: 'Light', exact: true, pressed: true }).waitFor();
    assert.equal(await page.locator('.topbar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(23, 32, 54)');
    await page.getByRole('button', { name: 'Reset colours' }).click();
    await themes.getByRole('button', { name: 'Ion', exact: true, pressed: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-av2-custom'), null);
    evidence.themeAndCustomHeaderPersist = true;
    await chooseTheme('light', 'Light');

    await chooseLayout('classic', 'classic');
    const expand = page.getByRole('button', { name: 'Expand sidebar' });
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible()) await collapse.click();
    await expand.waitFor();
    evidence.verticalNavigation.classic = await measureVerticalRail(page, 'left');
    await expand.click();
    await collapse.waitFor();
    await page.waitForFunction(() => document.querySelector('.app.layout-classic .rail').getBoundingClientRect().width >= 100);
    evidence.verticalNavigation.classicExpanded = await measureVerticalRail(page, 'left');
    assert.ok(evidence.verticalNavigation.classicExpanded > evidence.verticalNavigation.classic * 1.5);
    await collapse.click();

    for (const [id, layout, side] of [['aurora', 'studio', 'left'], ['atlas', 'atlas', 'right']]) {
      await chooseLayout(id, layout);
      evidence.verticalNavigation[layout] = await measureVerticalRail(page, side);
    }
    for (const [id, layout] of [['paper', 'cinema'], ['dock', 'dock']]) {
      await chooseLayout(id, layout);
      await measureHorizontalRail(page, layout);
      evidence.horizontalNavigation[layout] = true;
    }

    await resize(640, 480);
    for (const [id, layout, side] of [['classic', 'classic', 'left'], ['aurora', 'studio', 'left'], ['atlas', 'atlas', 'right']]) {
      await chooseLayout(id, layout);
      await measureVerticalRail(page, side);
    }
    await resize(640, 320);
    await chooseLayout('classic', 'classic');
    const random = rail.getByRole('button', { name: 'Random anime', exact: true });
    await random.press('Tab');
    const settings = rail.getByRole('link', { name: 'Settings', exact: true });
    await page.waitForFunction(() => {
      const nav = document.querySelector('.rail');
      const focused = document.activeElement;
      const target = focused?.getBoundingClientRect();
      return nav.contains(focused) && focused.title === 'Settings' && target?.bottom <= nav.getBoundingClientRect().bottom + 1 && nav.scrollTop > 0;
    });
    await settings.press('Enter');
    await page.waitForURL('**/#/settings');
    evidence.compactKeyboardNavigation = true;
    return evidence;
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

async function measurePalette(page) {
  return page.evaluate(async () => {
    const root = getComputedStyle(document.documentElement);
    const samples = {
      window: '.main .page-title', header: '.topbar .brand .word', rail: '.rail a:not(.active)',
      card: '.av2-appearance h3', aside: '.settings-nav button.active',
      button: '.av2-appearance-head > button', menu: '.topbar .menu button', input: 'input[aria-label="Theme name"]',
    };
    // Theme switches can transition both text and background colours on buttons.
    const pending = document.getAnimations().filter(animation => animation instanceof CSSTransition);
    await Promise.race([
      Promise.allSettled(pending.map(transition => transition.finished)),
      new Promise(resolve => setTimeout(resolve, 350)),
    ]);
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const light = ([r, g, b]) => [r, g, b].map(value => {
      const x = value / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const fill = (color) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
    };
    const contrast = Object.fromEntries(Object.entries(samples).map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!element) throw Error('Missing appearance sample ' + selector);
      const stack = [];
      for (let node = element; node; node = node.parentElement) stack.unshift(getComputedStyle(node).backgroundColor);
      fill('white');
      stack.forEach(fill);
      const bg = light(ctx.getImageData(0, 0, 1, 1).data);
      fill(getComputedStyle(element).color);
      const fg = light(ctx.getImageData(0, 0, 1, 1).data);
      return [name, Math.round((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) * 100) / 100];
    }));
    return { scheme: root.colorScheme, base: root.getPropertyValue('--bg').trim(), contrast };
  });
}

async function measureVerticalRail(page, side) {
  const bounds = await measureBounds(page);
  assert.equal(bounds.orientation, 'column');
  assert.ok(bounds.width >= 24 && bounds.width <= 350, 'Navigation width ' + bounds.width);
  assert.ok(bounds.radius >= 12 && bounds.shadow !== 'none', 'Vertical rail has floating treatment');
  assert.ok(bounds.top > bounds.headerBottom && bounds.bottom < bounds.appBottom);
  assert.ok(side === 'left' ? bounds.left > 0 && bounds.right < bounds.mainLeft
    : bounds.left > bounds.mainRight && bounds.right < bounds.appRight);
  assert.ok(bounds.mainRight <= bounds.appRight + 1 && bounds.mainLeft >= 0);
  return bounds.width;
}

async function measureHorizontalRail(page, layout) {
  const bounds = await measureBounds(page);
  assert.equal(bounds.orientation, 'row');
  assert.ok(layout === 'cinema' ? bounds.bottom <= bounds.mainTop + 1 : bounds.top >= bounds.mainBottom - 1);
}

function measureBounds(page) {
  return page.evaluate(async () => {
    const appElement = document.querySelector('.app');
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    appElement.getBoundingClientRect();
    const tracks = appElement.getAnimations().filter(animation => animation.transitionProperty === 'grid-template-columns');
    await Promise.race([
      Promise.allSettled(tracks.map(animation => animation.finished)),
      new Promise(resolve => setTimeout(resolve, 350)),
    ]);
    const nav = rect('.app > .rail');
    const main = rect('.app > .main');
    const app = rect('.app');
    const style = getComputedStyle(document.querySelector('.app > .rail'));
    return { top: nav.top, bottom: nav.bottom, left: nav.left, right: nav.right, width: nav.width,
      headerBottom: rect('.app > .topbar').bottom, mainTop: main.top, mainBottom: main.bottom,
      mainLeft: main.left, mainRight: main.right, appRight: app.right, appBottom: app.bottom,
      radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow, orientation: style.flexDirection };
  });
}

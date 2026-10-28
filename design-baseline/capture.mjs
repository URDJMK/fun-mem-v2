// usage: node capture.mjs <demo base url> <signed-out base url> <out dir> (see README.md)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [base, outBase, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

const widths = { desktop: 1440, mobile: 390 }; // desktop at 1x, mobile at 2x like a phone
const browser = await chromium.launch({ channel: 'chrome' });

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200); // entrance animations
}

async function shoot(page, name, label) {
  const file = `${out}/${name}--${label}.png`;
  // a full-page shot draws fixed bars (a phone's tabs, the floating transcript) where the first
  // screen ends, over the content; with the window as tall as the page they sit at its end,
  // where scrolling down shows them
  const size = page.viewportSize();
  const tall = await page.evaluate(() => document.documentElement.scrollHeight);
  if (tall > size.height) {
    await page.setViewportSize({ width: size.width, height: tall });
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: file });
  await page.setViewportSize(size);
  console.log('saved', file, page.url());
}

async function firstHref(page, re) {
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  return hrefs.find((h) => re.test(h));
}

for (const [label, width] of Object.entries(widths)) {
  const opts = {
    viewport: { width, height: label === 'mobile' ? 844 : 900 },
    deviceScaleFactor: label === 'mobile' ? 2 : 1,
    reducedMotion: 'reduce',
  };

  // signed out (a dev server with demo mode off: demo mode signs in on /sign-in)
  const outCtx = await browser.newContext(opts);
  const outPage = await outCtx.newPage();
  await outPage.goto(`${outBase}/`);
  await settle(outPage);
  await shoot(outPage, '01-landing', label);
  await outPage.goto(`${outBase}/sign-in`);
  await settle(outPage);
  await shoot(outPage, '02-sign-in', label);
  await outCtx.close();

  // signed in (demo session)
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => localStorage.setItem('firepit-demo-signed-in', '1'));
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await settle(page);
  await shoot(page, '03-projects', label);
  const archive = (await firstHref(page, /^\/a\/[^/]+\/?$/))?.replace(/\/$/, '');
  if (!archive) throw new Error('no archive link on /');

  await page.goto(`${base}/new-archive`);
  await settle(page);
  await shoot(page, '04-new-project', label);

  const pages = [
    ['05-home', ''],
    ['06-interviews', '/interviews'],
    ['07-interview-import', '/interviews/new'],
    ['08-stories', '/stories'],
    ['10-story-new', '/stories/new'],
    ['11-people', '/people'], // opens the first person
    ['12-timeline', '/timeline'],
    ['13-ask', '/ask'],
    ['14-members', '/members'],
    ['15-settings', '/settings'],
  ];
  for (const [name, path] of pages) {
    await page.goto(`${base}${archive}${path}`);
    await settle(page);
    await shoot(page, name, label);
    if (path === '/stories') {
      // click, not goto: the demo archive gets fresh ids on every full page load
      const story = await firstHref(page, new RegExp(`^${archive}/stories/(?!new$)[^/]+$`));
      if (!story) throw new Error('no story link on /stories');
      await page.click(`a[href="${story}"]`);
      await page.waitForURL(`**${story}`);
      await settle(page);
      await shoot(page, '09-story', label);
    }
  }

  // the live interview, with no microphone: `?simulate` (lib/live-sim.ts, dev only) speaks a
  // scripted interview through the recorder's own surface. The coach's model is cut off, so
  // the question bank stands in and the shot is the same every run with no API call.
  await ctx.route('**/demo/interview/**', (r) => r.abort());
  await page.goto(`${base}${archive}?simulate`);
  await settle(page);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.waitForTimeout(2000);
  await shoot(page, '16-interview-setup', label);
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await page.waitForTimeout(8000);
  await shoot(page, '17-interview-live', label);
  await ctx.close();
}
await browser.close();

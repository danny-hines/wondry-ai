// Headless screenshot of a generated page, for the vision judge. Playwright is
// lazy-imported so the rest of the app (and the Pi) never needs it — if Playwright or
// its Chromium isn't installed, screenshotPage returns null and the judge falls back
// to reading the page source as text. Install for vision evals with:
//   npm i -D playwright  &&  npx playwright install chromium
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { artifactPath } from './generator.js';

let browserP = null;
async function getBrowser() {
  if (!browserP) {
    browserP = (async () => {
      const { chromium } = await import('playwright');   // throws if not installed
      return chromium.launch({ args: ['--no-sandbox'] });
    })();
  }
  return browserP;
}

// Returns { base64, mediaType } of a full-page PNG, or null if rendering isn't
// possible (no Playwright/Chromium, missing file, or a render error).
export async function screenshotPage(artifactId, { width = 900, height = 1200, settleMs = 1200 } = {}) {
  const file = artifactPath(artifactId);
  if (!fs.existsSync(file)) return null;
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({ viewport: { width, height } });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(settleMs);              // let JS/animations settle
    const buf = await page.screenshot({ fullPage: true });
    return { base64: buf.toString('base64'), mediaType: 'image/png' };
  } catch { return null; }
  finally { try { await page?.close(); } catch {} }
}

export async function renderingAvailable() {
  try { await getBrowser(); return true; } catch { return false; }
}
export async function closeBrowser() {
  try { const b = await browserP; await b?.close(); } catch {}
  browserP = null;
}

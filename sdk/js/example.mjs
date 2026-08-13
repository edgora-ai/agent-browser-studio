// Agent Browser Studio — Playwright drop-in example.
//
// Swap the import, keep the rest of your Playwright code. This launches (or
// attaches to) a managed profile with the C++-level fingerprint engine and
// returns a real Playwright Browser connected over CDP.
//
//   AGENT_BROWSER_API_TOKEN=my-token node sdk/js/example.mjs
import { connectPlaywright } from './agent-browser.mjs';

const baseUrl = process.env.AGENT_BROWSER_BASE_URL || 'http://127.0.0.1:26582';
const token = process.env.AGENT_BROWSER_API_TOKEN || '';

const handle = await connectPlaywright({
  baseUrl,
  token,
  name: 'js-demo',
  platform: 'windows',
  locale: 'en-US',
  timezone: 'America/New_York',
  fingerprintSeed: 4242,
});

try {
  const page = await handle.browser.newPage();
  await page.goto('https://example.com');
  const title = await page.title();
  const ua = await page.evaluate(() => navigator.userAgent);
  const webdriver = await page.evaluate(() => navigator.webdriver);
  console.log('title     :', title);
  console.log('userAgent :', ua);
  console.log('webdriver :', webdriver);
  console.log('cdpPort   :', handle.cdpPort);
  await page.screenshot({ path: 'sdk-js-demo.png' });
} finally {
  await handle.stop();
}


import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

export function createOutputDir(name) {
  const output = process.argv[2] ?? (process.env.CITY_LABS_TEST_OUTPUT
    ? path.join(process.env.CITY_LABS_TEST_OUTPUT, name)
    : fs.mkdtempSync(path.join(os.tmpdir(), `city-labs-${name}-`)));
  fs.mkdirSync(output, { recursive: true });
  return output;
}

export function launchBrowser() {
  const args = process.env.CITY_LABS_SOFTWARE_WEBGL === '1'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
  return chromium.launch({ headless: true, channel: 'chromium', args });
}

export async function captureFailure(page, output, error) {
  try { fs.writeFileSync(path.join(output, 'failure.txt'), error.stack ?? String(error)); } catch {}
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
}

import { expect, test } from '@playwright/test';
import { signIn } from './support';

/**
 * R-E1: a deep link lands on its target once the page settles, and in-app links and Back
 * navigate without loading the document (from the R-E1 review).
 */
test('a settings deep link lands on its section, and links and Back never reload the document', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page);
  await page.waitForURL(/\/workspaces\/[^/]+$/);
  const workspace = new URL(page.url()).pathname.split('/')[2];
  let loads = 0;
  page.on('load', () => loads++);

  await page.goto(`/workspaces/${workspace}/settings#execution-capacity`);
  loads = 0;
  await page.getByText('Workstation', { exact: false }).first().waitFor();
  await page.waitForTimeout(3000);
  const box = await page.locator('#execution-capacity').boundingBox();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('execution-capacity');

  expect(box!.y).toBeLessThan(200);

  // In-place navigation from a content link: no document load; where does the target land?
  await page.goto(`/workspaces/${workspace}/roadmaps`);
  const link = page.getByRole('link', { name: 'Manage agent profiles for future runs' });
  await link.scrollIntoViewIfNeeded();
  loads = 0;
  await link.click();
  await page.waitForURL(/settings#roadmap-agent-profiles$/);
  await page.waitForTimeout(3000);
  const target = await page.locator('#roadmap-agent-profiles').boundingBox();
  expect(loads).toBe(0);
  expect(target!.y).toBeLessThan(200);
  // Back returns to the roadmaps page without a document load.
  await page.goBack();
  await page.waitForTimeout(1000);
  expect(loads).toBe(0);
});

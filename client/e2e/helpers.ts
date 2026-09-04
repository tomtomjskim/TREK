import type { Page } from '@playwright/test';

/**
 * Dismiss the system-notice modal(s) (SystemNoticeHost), which greet a freshly
 * seeded user on first load and cover the dashboard — the backdrop swallows
 * clicks aimed at anything underneath, `.add-trip-card` included.
 *
 * The host renders asynchronously (after the notices fetch), so wait for the
 * notice dialog before deciding there is nothing to clear. Every lookup is
 * scoped INSIDE the dialog — an unscoped /next/i can match dashboard buttons
 * (carousel arrows) and satisfy the wait before the modal even mounts.
 *
 * A notice closes one of two ways depending on its shape:
 *  - CTA-bearing notices (e.g. the thank-you/support modal) only offer the
 *    X button (`aria-label="Dismiss"`), shown on the last page.
 *  - CTA-less notices show an "OK" button that pages forward and dismisses on
 *    the last page.
 * Multi-page notices are paged through via the pager's Next button first.
 * Dismissal is persisted server-side per user, so clearing once keeps it
 * cleared for every later spec in the run (shared test DB).
 */
export async function dismissSystemNotices(page: Page, appearTimeoutMs = 3_000): Promise<void> {
  // System notices own deterministic notice-* accessible ids. Restricting the
  // locator keeps unrelated product dialogs (for example Create Trip) out of
  // this helper when a route opens one before the notice fetch settles.
  const dialog = page
    .locator('[role="dialog"][aria-labelledby^="notice-title-"][aria-describedby^="notice-body-"]')
    .first();
  await dialog.waitFor({ state: 'visible', timeout: appearTimeoutMs }).catch(() => {});

  // Clear up to a handful of queued notices.
  for (let notice = 0; notice < 4 && (await dialog.isVisible().catch(() => false)); notice++) {
    // A release notice shares the same deterministic accessible ids but has a
    // dedicated close control. Check it inside the single dialog loop so a
    // release that mounts near the appearance timeout cannot escape between two
    // serial waits and leave its overlay over the page.
    const releaseClose = dialog.locator('.rn-close');
    if (await releaseClose.isVisible().catch(() => false)) {
      await releaseClose.click();
      await page.waitForTimeout(400);
      continue;
    }

    const next = dialog.getByRole('button', { name: /next/i });
    for (let i = 0; i < 8 && (await next.isVisible().catch(() => false)); i++) {
      if (!(await next.isEnabled().catch(() => false))) break;
      await next.click();
    }
    const dismiss = dialog.getByRole('button', { name: 'Dismiss', exact: true });
    const ok = dialog.getByRole('button', { name: 'OK', exact: true });
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    else if (await ok.isVisible().catch(() => false)) await ok.click();
    else break;
    // Exit animation + the next queued notice mounting.
    await page.waitForTimeout(400);
  }

  await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
}

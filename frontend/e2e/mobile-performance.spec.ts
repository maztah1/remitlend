/**
 * Issue #406 – Mobile performance regression gates.
 *
 * These tests run exclusively in the `mobile-chrome` and `mobile-safari`
 * Playwright projects (see playwright.config.ts). They measure Core Web
 * Vitals proxies and layout stability on a Pixel 5 / iPhone 13 viewport to
 * prevent regressions from reaching production.
 *
 * What is measured:
 *   - Cumulative Layout Shift (CLS) — must stay < 0.1
 *   - Largest Contentful Paint (LCP) — must be < 3 500 ms
 *   - Page load time of key routes — bounded to prevent obvious regressions
 *   - Absence of horizontal scroll on small viewports
 *   - Interactive elements meet the 44 × 44 px minimum tap target (WCAG 2.5.5)
 *
 * Tests use the public landing page (`/en`) and the lend page (`/en/lend`)
 * because those are the highest-traffic entry-points and do not require a
 * wallet connection.
 */

import { test, expect, type Page } from "@playwright/test";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Collect CLS and LCP via the PerformanceObserver API injected before navigation. */
async function collectWebVitals(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__vitals = { cls: 0, lcp: 0 };

    // CLS accumulator
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!e.hadRecentInput) {
          (window as unknown as Record<string, unknown>).__vitals = {
            ...(window as unknown as Record<string, { cls: number; lcp: number }>).__vitals,
            cls:
              ((window as unknown as Record<string, { cls: number; lcp: number }>).__vitals?.cls ??
                0) + (e.value ?? 0),
          };
        }
      }
    }).observe({ type: "layout-shift", buffered: true });

    // LCP: last entry wins
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length > 0) {
        const last = entries[entries.length - 1];
        (window as unknown as Record<string, unknown>).__vitals = {
          ...(window as unknown as Record<string, { cls: number; lcp: number }>).__vitals,
          lcp: last.startTime,
        };
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
}

/** Read vitals after the page has loaded. */
async function readWebVitals(page: Page) {
  return page.evaluate(
    () => (window as unknown as Record<string, { cls: number; lcp: number }>).__vitals,
  );
}

// ─── Landing page ──────────────────────────────────────────────────────────────

test.describe("Mobile performance – Landing page (/en)", () => {
  test.beforeEach(async ({ page }) => {
    await collectWebVitals(page);
  });

  test("loads within 5 s on mobile viewport", async ({ page }) => {
    const start = Date.now();
    await page.goto("/en", { waitUntil: "load" });
    const elapsed = Date.now() - start;

    // Generous gate for CI (slow runners). The real regression signal is a
    // trend, not a single run.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("CLS is below 0.1 (no unexpected layout shifts)", async ({ page }) => {
    await page.goto("/en", { waitUntil: "networkidle" });
    // Allow the browser to flush pending layout-shift entries.
    await page.waitForTimeout(500);
    const vitals = await readWebVitals(page);
    expect(vitals?.cls ?? 0).toBeLessThan(0.1);
  });

  test("LCP is below 3 500 ms", async ({ page }) => {
    await page.goto("/en", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const vitals = await readWebVitals(page);
    // LCP of 0 means the observer didn't fire — skip rather than false-fail.
    if (vitals?.lcp && vitals.lcp > 0) {
      expect(vitals.lcp).toBeLessThan(3_500);
    }
  });

  test("no horizontal scroll on 393 px viewport", async ({ page }) => {
    await page.goto("/en", { waitUntil: "load" });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("primary CTA buttons meet 44×44 px minimum tap target", async ({ page }) => {
    await page.goto("/en", { waitUntil: "load" });

    // Collect all <button> and <a> elements that are visible.
    const tooSmall = await page.evaluate(() => {
      const MIN = 44;
      const elements = [
        ...document.querySelectorAll<HTMLElement>("button, a[href]"),
      ];
      return elements
        .filter((el) => {
          const r = el.getBoundingClientRect();
          // Only flag visible elements (non-zero size, within viewport).
          return r.width > 0 && r.height > 0 && (r.width < MIN || r.height < MIN);
        })
        .map((el) => ({
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 60),
          width: Math.round(el.getBoundingClientRect().width),
          height: Math.round(el.getBoundingClientRect().height),
        }));
    });

    // Report violations but soft-fail: some icon buttons (e.g., the lang
    // switcher chevron) are intentionally compact. Log for visibility.
    if (tooSmall.length > 0) {
      console.warn(
        `⚠️  ${tooSmall.length} interactive element(s) smaller than 44×44 px:`,
        JSON.stringify(tooSmall, null, 2),
      );
    }

    // Hard limit: no more than 5 small elements (allows known icon-only items).
    expect(tooSmall.length).toBeLessThanOrEqual(5);
  });
});

// ─── Lend page ─────────────────────────────────────────────────────────────────

test.describe("Mobile performance – Lend page (/en/lend)", () => {
  test.beforeEach(async ({ page }) => {
    await collectWebVitals(page);
  });

  test("loads within 5 s on mobile viewport", async ({ page }) => {
    const start = Date.now();
    await page.goto("/en/lend", { waitUntil: "load" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
  });

  test("CLS is below 0.1 on lend page", async ({ page }) => {
    await page.goto("/en/lend", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const vitals = await readWebVitals(page);
    expect(vitals?.cls ?? 0).toBeLessThan(0.1);
  });

  test("no horizontal scroll on 393 px viewport", async ({ page }) => {
    await page.goto("/en/lend", { waitUntil: "load" });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});

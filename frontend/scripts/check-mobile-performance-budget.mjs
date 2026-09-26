/**
 * Issue #406 – Mobile performance regression gate.
 *
 * Checks the JS bundle size produced by `next build` against a tighter budget
 * that reflects the constraints of mobile devices. The mobile budget defaults
 * to 1 MB (compressed over-the-wire ≈ ~300 KB gzip) — half the desktop
 * budget — to prevent regressions for users on low-end Android devices with
 * limited data plans.
 *
 * Env vars:
 *   NEXT_MOBILE_PERFORMANCE_BUDGET_BYTES  – override the byte ceiling
 *                                           (default: 1_000_000)
 *
 * Exit 1 when the budget is exceeded so CI fails the build.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Mobile devices used by RemitLend's primary user-base (migrant workers) are
// often mid-range Androids on metered connections. 1 MB of uncompressed JS
// is a reasonable regression ceiling; tighten this over time.
const MOBILE_BUDGET_BYTES = Number(
  process.env.NEXT_MOBILE_PERFORMANCE_BUDGET_BYTES ?? 1_000_000,
);

const CHUNKS_DIR = "./.next/static/chunks";

async function getJavaScriptBytes(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // Directory absent means no build was produced.
    throw new Error(
      `Cannot read ${directory}. Did you run 'next build' before this check?`,
    );
  }

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return getJavaScriptBytes(path);
      if (!entry.name.endsWith(".js")) return 0;
      return (await stat(path)).size;
    }),
  );

  return sizes.flat(Infinity).reduce((total, size) => total + size, 0);
}

const bytes = await getJavaScriptBytes(CHUNKS_DIR);
const kib = (bytes / 1024).toFixed(1);
const budgetKib = (MOBILE_BUDGET_BYTES / 1024).toFixed(1);

if (bytes > MOBILE_BUDGET_BYTES) {
  console.error(
    `❌ Mobile performance budget exceeded: ${bytes} bytes (${kib} KiB) > ${MOBILE_BUDGET_BYTES} bytes (${budgetKib} KiB)`,
  );
  console.error(
    "   Reduce bundle size or raise NEXT_MOBILE_PERFORMANCE_BUDGET_BYTES after a justified review.",
  );
  process.exit(1);
}

console.log(
  `✅ Mobile performance budget passed: ${bytes} bytes (${kib} KiB) ≤ ${MOBILE_BUDGET_BYTES} bytes (${budgetKib} KiB)`,
);

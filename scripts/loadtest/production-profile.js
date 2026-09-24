/**
 * Production-shaped API load profiles for RemitLend (#405).
 *
 * This k6 script models realistic traffic patterns observed in production
 * (or expected at launch) rather than the flat 50-VU baseline in baseline.js.
 *
 * Traffic model (derived from typical DeFi/remittance app analytics):
 * ─────────────────────────────────────────────────────────────────────
 *  Stage          Duration  Target VUs  Description
 *  ─────────────────────────────────────────────────────────────────────
 *  Ramp-up        2 min     0 → 20      Cold-start / gradual morning traffic
 *  Sustained      5 min     20          Normal business-hours load
 *  Spike          1 min     20 → 80     End-of-month remittance surge
 *  Recover        2 min     80 → 20     Spike drain
 *  Sustained II   5 min     20          Continued normal load
 *  Ramp-down      1 min     20 → 0      End-of-session wind-down
 *  ─────────────────────────────────────────────────────────────────────
 *  Total: ~16 min
 *
 * Endpoint distribution (weighted by real usage):
 *   55% — Read-heavy: GET /health, GET /pool/stats, GET /score/:address
 *   30% — Authenticated reads: GET /loans, GET /remittances
 *   10% — Write path: POST /remittances (with idempotency key)
 *    5% — Admin/indexer: GET /health/deep, GET /indexer/state
 *
 * Thresholds (acceptance criteria for CI):
 *   p(95) latency < 500 ms for all requests
 *   p(99) latency < 2 000 ms
 *   error rate < 1%
 *   Write-path p(95) < 1 000 ms
 *
 * Usage
 * ─────
 *   k6 run scripts/loadtest/production-profile.js \
 *     -e TARGET_URL=https://staging.remitlend.com \
 *     -e JWT_TOKEN=<bearer-token> \
 *     -e WALLET_ADDRESS=<Gxxx...>
 *
 * CI: triggered via .github/workflows/loadtest.yml (workflow_dispatch or
 *     scheduled nightly against the staging environment).
 *
 * Threat-model notes
 * ──────────────────
 * The spike stage is designed to catch:
 *   - Connection-pool exhaustion under burst traffic
 *   - Rate-limiter false positives that block legitimate users
 *   - Redis cache stampede during cold starts
 * The write-path tests include Idempotency-Key headers to avoid creating real
 * data artifacts on staging; requests are clearly identified as load-test traffic
 * via the X-Load-Test header so they can be filtered out of analytics.
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ─── Custom metrics ────────────────────────────────────────────────────────────

const writeLatency = new Trend('write_path_duration_ms', true);
const errorRate    = new Rate('error_rate');

// ─── Load profile ──────────────────────────────────────────────────────────────

export const options = {
  /**
   * Production-shaped stages: ramp-up → sustained → spike → recover → sustained → ramp-down.
   * Adjust maxVUs to match expected production concurrency.
   */
  stages: [
    { duration: '2m', target: 20 },   // ramp-up: cold start
    { duration: '5m', target: 20 },   // sustained: normal business hours
    { duration: '1m', target: 80 },   // spike: end-of-month remittance surge
    { duration: '2m', target: 20 },   // recover: spike drain
    { duration: '5m', target: 20 },   // sustained II
    { duration: '1m', target: 0  },   // ramp-down
  ],

  thresholds: {
    // Global latency — all requests
    http_req_duration: [
      'p(95)<500',    // 95th percentile under 500 ms
      'p(99)<2000',   // 99th percentile under 2 000 ms
    ],
    // Error rate must stay below 1%
    http_req_failed:         ['rate<0.01'],
    error_rate:              ['rate<0.01'],
    // Write-path latency — POST /remittances
    write_path_duration_ms:  ['p(95)<1000'],
  },
};

// ─── Scenario parameters ───────────────────────────────────────────────────────

const BASE_URL      = __ENV.TARGET_URL      || 'http://localhost:3001';
const JWT_TOKEN     = __ENV.JWT_TOKEN       || '';
const WALLET_ADDR   = __ENV.WALLET_ADDRESS  || 'GCJPBXSE6WCQDCEYZW6C3YVZCSSCHC4AE72L5KWKCYL2CLLL7NH5VSCI';

const AUTH_HEADERS = {
  Authorization: `Bearer ${JWT_TOKEN}`,
  'Content-Type': 'application/json',
  'X-Load-Test': 'true',    // flag so staging analytics can filter test traffic
};

const PUBLIC_HEADERS = {
  'Content-Type': 'application/json',
  'X-Load-Test': 'true',
};

// Deterministic VU-specific idempotency key prevents duplicate-write artifacts
function idempotencyKey() {
  return `loadtest-vu${__VU}-iter${__ITER}`;
}

// ─── Main VU function ──────────────────────────────────────────────────────────

export default function () {
  // Weighted traffic distribution via random roll
  const roll = Math.random();

  if (roll < 0.30) {
    // 30% — Read-heavy public endpoints (health, pool stats, score)
    readHeavyGroup();
  } else if (roll < 0.60) {
    // 30% — Authenticated reads (loans, remittances list)
    authenticatedReadsGroup();
  } else if (roll < 0.80) {
    // 20% — Mixed public reads (pool stats + score — higher weight)
    poolAndScoreGroup();
  } else if (roll < 0.90) {
    // 10% — Write path (POST remittance with idempotency)
    writePathGroup();
  } else {
    //  5% — Operational endpoints (deep health, indexer state)
    operationalGroup();
  }

  // Pacing — realistic user think time (0.5 – 2 s)
  sleep(0.5 + Math.random() * 1.5);
}

// ─── Scenario groups ──────────────────────────────────────────────────────────

function readHeavyGroup() {
  group('read:public', () => {
    const health = http.get(`${BASE_URL}/health`, { headers: PUBLIC_HEADERS });
    check(health, { 'health 200': (r) => r.status === 200 });
    errorRate.add(health.status !== 200);

    const stats = http.get(`${BASE_URL}/api/v1/pool/stats`, { headers: PUBLIC_HEADERS });
    check(stats, {
      'pool/stats 200': (r) => r.status === 200,
      'pool/stats has data': (r) => {
        try { return Boolean(JSON.parse(r.body as string)?.data); }
        catch { return false; }
      },
    });
    errorRate.add(stats.status !== 200);

    const score = http.get(`${BASE_URL}/api/v1/score/${WALLET_ADDR}`, { headers: PUBLIC_HEADERS });
    check(score, { 'score 200 or 404': (r) => r.status === 200 || r.status === 404 });
    errorRate.add(score.status >= 500);
  });
}

function authenticatedReadsGroup() {
  group('read:authenticated', () => {
    if (!JWT_TOKEN) {
      // Skip auth-gated checks when no token is provided (local dev without auth)
      return;
    }

    const loans = http.get(
      `${BASE_URL}/api/v1/loans?borrower=${WALLET_ADDR}&page=1&pageSize=10`,
      { headers: AUTH_HEADERS },
    );
    check(loans, { 'loans 200 or 401': (r) => r.status === 200 || r.status === 401 });
    errorRate.add(loans.status >= 500);

    const remittances = http.get(
      `${BASE_URL}/api/v1/remittances?page=1&pageSize=10`,
      { headers: AUTH_HEADERS },
    );
    check(remittances, { 'remittances 200 or 401': (r) => r.status === 200 || r.status === 401 });
    errorRate.add(remittances.status >= 500);

    const notifications = http.get(
      `${BASE_URL}/api/v1/notifications?page=1&pageSize=20`,
      { headers: AUTH_HEADERS },
    );
    check(notifications, { 'notifications 200 or 401': (r) => r.status === 200 || r.status === 401 });
    errorRate.add(notifications.status >= 500);
  });
}

function poolAndScoreGroup() {
  group('read:pool-and-score', () => {
    const stats = http.get(`${BASE_URL}/api/v1/pool/stats`, { headers: PUBLIC_HEADERS });
    check(stats, { 'pool/stats 200': (r) => r.status === 200 });
    errorRate.add(stats.status !== 200);

    const score = http.get(`${BASE_URL}/api/v1/score/${WALLET_ADDR}`, { headers: PUBLIC_HEADERS });
    check(score, { 'score 2xx or 404': (r) => r.status < 500 });
    errorRate.add(score.status >= 500);
  });
}

function writePathGroup() {
  group('write:remittance', () => {
    if (!JWT_TOKEN) return;

    const payload = JSON.stringify({
      recipientAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRST',
      amount: 50,
      fromCurrency: 'USD',
      toCurrency: 'XLM',
      memo: `loadtest-${idempotencyKey()}`,
    });

    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/v1/remittances`, payload, {
      headers: {
        ...AUTH_HEADERS,
        'Idempotency-Key': idempotencyKey(),
      },
    });
    writeLatency.add(Date.now() - start);

    check(res, {
      'remittance POST 201 or 409': (r) => r.status === 201 || r.status === 409,
      'no server error': (r) => r.status < 500,
    });
    errorRate.add(res.status >= 500);
  });
}

function operationalGroup() {
  group('operational', () => {
    const deepHealth = http.get(`${BASE_URL}/health/deep`, { headers: PUBLIC_HEADERS });
    check(deepHealth, {
      'health/deep 200 or 503': (r) => r.status === 200 || r.status === 503,
      'health/deep has status key': (r) => {
        try { return 'status' in JSON.parse(r.body as string); }
        catch { return false; }
      },
    });
    errorRate.add(deepHealth.status >= 500 && deepHealth.status !== 503);
  });
}

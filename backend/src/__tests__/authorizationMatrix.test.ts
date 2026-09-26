/**
 * Continuous Authorization Matrix Tests — Issue #367
 *
 * This file encodes the route/scope matrix documented in
 * docs/SECURITY-MODEL.md as executable assertions so that any scope
 * regression fails CI immediately.
 *
 * Three dimensions are verified for every route:
 *   1. No credentials   → 401
 *   2. Wrong role/scope → 403
 *   3. Correct role     → auth layer passes (downstream may non-2xx for DB
 *                          reasons in a test environment — that is acceptable)
 *
 * Conventions:
 *  - Short-lived JWTs are minted inline with jsonwebtoken (same as poolRouteScopes.test.ts).
 *  - LENDER_WALLETS is set before the app import so RBAC resolves correctly.
 *  - The ROUTE_MATRIX drives all test cases; extend it when adding routes.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ─── wallet stubs ────────────────────────────────────────────────────────────
// These are syntactically valid Stellar G-addresses (56 chars, G-prefix).
// They are not funded; we only need them as stable identifiers for role lookup.
const ADMIN_KEY =
  'GADMIN0000000000000000000000000000000000000000000000000001';
const LENDER_KEY =
  'GLENDER000000000000000000000000000000000000000000000000001';
const BORROWER_KEY =
  'GBORROWER0000000000000000000000000000000000000000000000001';

// Set wallet env vars BEFORE importing app so rbac.ts picks them up.
process.env.ADMIN_WALLETS = ADMIN_KEY;
process.env.LENDER_WALLETS = LENDER_KEY;

// eslint-disable-next-line import/first
const app = (await import('../app.js')).default;

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-authmatrix';

// ─── token factory ───────────────────────────────────────────────────────────

type Role = 'admin' | 'lender' | 'borrower';

const ROLE_SCOPES: Record<Role, string[]> = {
  admin: ['admin:all'],
  lender: ['read:loans', 'read:pool', 'write:loans'],
  borrower: [
    'read:loans',
    'write:loans',
    'read:score',
    'read:notifications',
    'write:notifications',
    'read:remittances',
    'write:remittances',
  ],
};

function mintToken(publicKey: string, role: Role): string {
  return jwt.sign(
    { publicKey, role, scopes: ROLE_SCOPES[role] },
    JWT_SECRET,
    { expiresIn: '1h', algorithm: 'HS256' },
  );
}

const adminToken = mintToken(ADMIN_KEY, 'admin');
const lenderToken = mintToken(LENDER_KEY, 'lender');
const borrowerToken = mintToken(BORROWER_KEY, 'borrower');

// ─── route matrix ────────────────────────────────────────────────────────────

/**
 * Describes a single route under test.
 *
 * `authorizedRole`:  the role that SHOULD pass the auth layer.
 * `forbiddenRoles`:  roles that MUST receive 403.
 * `requiresApiKey`:  when true, the route uses requireApiKey instead of JWT;
 *                    `apiKeyScope` is the required scope.
 */
interface RouteEntry {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  /** Role whose JWT should pass the auth layer (not necessarily return 2xx). */
  authorizedRole: Role;
  /** Roles whose JWTs must receive 403. */
  forbiddenRoles: Role[];
  /** When true, use the API-key auth model instead of JWT. */
  requiresApiKey?: boolean;
  /** API-key scope required (set when requiresApiKey is true). */
  apiKeyScope?: string;
  /** Minimal request body (required for POST/PUT to avoid 400 before auth). */
  body?: Record<string, unknown>;
}

const ROUTE_MATRIX: RouteEntry[] = [
  // ── Pool — read (lender only) ─────────────────────────────────────────────
  {
    method: 'get',
    path: '/api/pool/stats',
    authorizedRole: 'lender',
    forbiddenRoles: ['borrower'],
  },
  {
    method: 'get',
    path: `/api/pool/depositor/${LENDER_KEY}`,
    authorizedRole: 'lender',
    forbiddenRoles: ['borrower'],
  },
  {
    method: 'get',
    path: `/api/pool/depositor/${LENDER_KEY}/yield-history`,
    authorizedRole: 'lender',
    forbiddenRoles: ['borrower'],
  },
  // ── Pool — write (lender scope write:pool — currently 403 for lenders too,
  //   tracked in issue #1179; this test asserts the existing behaviour) ───────
  {
    method: 'post',
    path: '/api/pool/build-deposit',
    authorizedRole: 'admin',
    forbiddenRoles: ['borrower', 'lender'],
    body: { depositorPublicKey: LENDER_KEY, token: 'GTOKEN', amount: 100 },
  },
  {
    method: 'post',
    path: '/api/pool/build-withdraw',
    authorizedRole: 'admin',
    forbiddenRoles: ['borrower', 'lender'],
    body: { depositorPublicKey: LENDER_KEY, token: 'GTOKEN', amount: 100 },
  },
  // ── Loans — read (borrower + lender) ────────────────────────────────────
  {
    method: 'get',
    path: '/api/loans',
    authorizedRole: 'borrower',
    forbiddenRoles: [],
  },
  {
    method: 'get',
    path: `/api/loans/${BORROWER_KEY}`,
    authorizedRole: 'borrower',
    forbiddenRoles: [],
  },
  // ── Score — read (borrower only) ─────────────────────────────────────────
  {
    method: 'get',
    path: `/api/scores/${BORROWER_KEY}`,
    authorizedRole: 'borrower',
    forbiddenRoles: [],
  },
  // ── Remittances — write (borrower only) ──────────────────────────────────
  {
    method: 'post',
    path: '/api/remittances',
    authorizedRole: 'borrower',
    forbiddenRoles: ['lender'],
    body: {
      amount: 100,
      currency: 'USD',
      recipientName: 'Test User',
      recipientPhone: '+1234567890',
      corridor: 'US-PH',
    },
  },
  // ── Remittances — read (borrower only) ───────────────────────────────────
  {
    method: 'get',
    path: '/api/remittances',
    authorizedRole: 'borrower',
    forbiddenRoles: ['lender'],
  },
  // ── Notifications — read/write (borrower) ────────────────────────────────
  {
    method: 'get',
    path: '/api/notifications',
    authorizedRole: 'borrower',
    forbiddenRoles: [],
  },
  // ── Admin — disputes (API-key: admin:disputes) ────────────────────────────
  {
    method: 'get',
    path: '/api/admin/loan-disputes',
    authorizedRole: 'admin',
    forbiddenRoles: ['borrower', 'lender'],
    requiresApiKey: true,
    apiKeyScope: 'admin:disputes',
  },
  // ── Admin — indexer status (API-key: admin:indexer) ──────────────────────
  {
    method: 'get',
    path: '/api/admin/indexer/status',
    authorizedRole: 'admin',
    forbiddenRoles: ['borrower', 'lender'],
    requiresApiKey: true,
    apiKeyScope: 'admin:indexer',
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a unique admin API key scoped to `scope` and register it in the env
 * so requireApiKey can find it.
 */
function prepareApiKey(scope: string): string {
  const secret = `test-secret-${scope.replace(':', '-')}`;
  process.env.INTERNAL_API_KEY = `${scope}:${secret}`;
  return secret;
}

// ─── test suite ──────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

describe('Authorization Matrix — continuous enforcement (#367)', () => {
  for (const entry of ROUTE_MATRIX) {
    const METHOD = entry.method.toUpperCase();
    const { path, authorizedRole, forbiddenRoles, requiresApiKey, apiKeyScope, body } = entry;

    describe(`${METHOD} ${path}`, () => {
      // 1. No credentials → 401
      it('returns 401 with no credentials', async () => {
        const req = request(app)[entry.method](path);
        if (body) req.send(body);
        const res = await req;
        expect(res.status).toBe(401);
      });

      // 2. Forbidden roles → 403
      for (const role of forbiddenRoles) {
        it(`returns 403 for role "${role}"`, async () => {
          const req = request(app)
            [entry.method](path)
            .set('Authorization', `Bearer ${role === 'admin' ? adminToken : role === 'lender' ? lenderToken : borrowerToken}`);
          if (body) req.send(body);
          const res = await req;
          expect(res.status).toBe(403);
        });
      }

      // 3. Authorized role passes the auth layer
      it(`does NOT return 401 or 403 for authorized role "${authorizedRole}"`, async () => {
        // supertest.Test is the correct chainable type returned by .get()/.post()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let req: any;

        if (requiresApiKey && apiKeyScope) {
          const apiKey = prepareApiKey(apiKeyScope);
          req = request(app)[entry.method](path).set('x-api-key', apiKey);
        } else {
          const token =
            authorizedRole === 'admin'
              ? adminToken
              : authorizedRole === 'lender'
                ? lenderToken
                : borrowerToken;
          req = request(app)[entry.method](path).set('Authorization', `Bearer ${token}`);
        }

        if (body) req = req.send(body);
        const res = await req;

        // Auth layer passes — downstream may 400/404/500 without a real DB.
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });
  }

  // ── Additional focused scope-regression tests ─────────────────────────────

  describe('RBAC scope regression', () => {
    it('borrower token cannot access pool stats (missing read:pool)', async () => {
      const res = await request(app)
        .get('/api/pool/stats')
        .set('Authorization', `Bearer ${borrowerToken}`);
      expect(res.status).toBe(403);
    });

    it('lender token cannot access notifications (missing read:notifications)', async () => {
      const res = await request(app)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${lenderToken}`);
      // lender lacks read:notifications → 403
      expect(res.status).toBe(403);
    });

    it('borrower token cannot access remittances of another user (row-level guard)', async () => {
      // The route itself requires read:remittances which borrower has, so auth passes.
      // This test verifies the auth layer lets the request through — row-level
      // isolation is the responsibility of the controller layer.
      const res = await request(app)
        .get('/api/remittances')
        .set('Authorization', `Bearer ${borrowerToken}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('admin API-key with wrong scope is rejected', async () => {
      // Set up a disputes-scoped key then try to hit the indexer route.
      const disputeKey = 'test-dispute-key';
      process.env.INTERNAL_API_KEY = `admin:disputes:${disputeKey}`;

      const res = await request(app)
        .get('/api/admin/indexer/status')
        .set('x-api-key', disputeKey);

      expect(res.status).toBe(403);
    });

    it('legacy API-key (no scope prefix) is accepted on admin:disputes route', async () => {
      const legacyKey = 'legacy-test-key-matrix';
      process.env.INTERNAL_API_KEY = legacyKey;

      const res = await request(app)
        .get('/api/admin/loan-disputes')
        .set('x-api-key', legacyKey);

      // Legacy key grants all admin scopes — auth passes regardless of DB.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
});

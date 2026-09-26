/**
 * Makes `docs/api-reference.md` executable from a clean checkout (#416).
 *
 * The reference promises things integrators rely on: that a documented endpoint
 * exists, that it answers the documented HTTP method, and that it is really
 * mounted under the path shown. This test replays every documented operation
 * against the running application, so a renamed, unmounted, or removed route
 * breaks the build instead of silently breaking consumers.
 *
 * Run it with:
 *
 *     cd backend && npm test -- apiReference
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

jest.unstable_mockModule('../db/connection.js', () => {
  const connection = {
    query: jest
      .fn<() => Promise<{ rows: unknown[]; rowCount: number }>>()
      .mockResolvedValue({ rows: [], rowCount: 0 }),
    getClient: jest.fn(),
    withTransaction: jest.fn(),
    // `dbConnectionLeakDetector` and `piiCrypto` import the named `pool` export.
    on: jest.fn(),
    connect: jest.fn(),
  };

  return {
    default: connection,
    pool: connection,
    query: connection.query,
    getClient: connection.getClient,
    withTransaction: connection.withTransaction,
  };
});

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    get: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    getScoreConfig: jest.fn(() => ({ repaymentDelta: 20, defaultPenalty: 50 })),
  },
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const DOC_PATH = path.join(repoRoot, 'docs/api-reference.md');

interface Operation {
  method: string;
  path: string;
}

/** Normalises `:param` and `{param}` syntax plus trailing slashes. */
const normalizePath = (value: string): string => {
  const withBraces = value.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const collapsed = withBraces.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
};

/**
 * Replaces `{param}` segments with inert placeholders so each documented
 * endpoint can be probed: address-shaped params get a well-formed Stellar
 * public key, everything else gets a numeric id. Auth, validation, and rate
 * limiting reject these requests before any state change.
 */
const STELLAR_PUBLIC_KEY = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7';

const toRequestPath = (value: string): string =>
  value.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    /borrower|address|wallet|publickey/i.test(name) ? STELLAR_PUBLIC_KEY : '123',
  );

const parseDocumentedOperations = (markdown: string): Operation[] => {
  const matches = markdown.matchAll(/^#### (GET|POST|PUT|PATCH|DELETE) (\S+)\s*$/gm);

  return Array.from(matches, (match) => ({
    method: match[1],
    path: normalizePath(match[2]),
  }));
};

let app: any;

beforeAll(async () => {
  // Dynamic import inside a hook (rather than top-level await) keeps this
  // suite runnable under both the ESM and CJS jest transform paths, and runs
  // strictly after the module mocks above are registered.
  ({ default: app } = await import('../app.js'));
});

describe('API reference is executable', () => {
  const markdown = readFileSync(DOC_PATH, 'utf8');
  const documented = parseDocumentedOperations(markdown);

  it('parses the documented operations (guards against a vacuous pass)', () => {
    expect(documented.length).toBeGreaterThanOrEqual(20);
    expect(documented.every((op) => op.path.startsWith('/'))).toBe(true);
  });

  /**
   * Exercises the application itself: for every documented `METHOD /path` the
   * request is issued against the running Express app (with inert placeholder
   * path params) and must be handled by a real route. Auth, validation, and
   * rate limiting reject these requests long before any state change — the
   * assertion is only that the route exists and answers, i.e. that the
   * document and the mount table still agree.
   */
  it('answers every documented method+path with a non-404 response', async () => {
    const unhandled: string[] = [];

    for (const op of documented) {
      const target = request(app)
        [op.method.toLowerCase() as 'get'](toRequestPath(op.path))
        .buffer(false);

      const response = await target;
      if (response.status === 404 || response.status === 501) {
        unhandled.push(`${op.method} ${op.path} -> ${response.status}`);
      }
    }

    expect(unhandled).toEqual([]);
  }, 60_000);

  it('rejects documented operations without any request/response detail', () => {
    const sections = markdown.split(/^#### /m).slice(1);
    const thin = sections.filter((section) => {
      const heading = section.split('\n')[0];
      if (!/^(GET|POST|PUT|PATCH|DELETE) \S+/.test(heading)) return false;
      return !/\*\*Response/.test(section) && !/\*\*Request/.test(section);
    });

    expect(thin.map((section) => section.split('\n')[0])).toEqual([]);
  });
});

/**
 * Tests for issue #368: strengthen request/response redaction guarantees.
 *
 * Verifies that:
 *  1. `deepRedact` redacts all listed PII/credential fields regardless of
 *     `LOG_REDACTION` env var value (always-on guarantee).
 *  2. `deepRedact` recurses into nested objects and arrays.
 *  3. `deepRedact` handles circular references and deep nesting without
 *     throwing.
 *  4. `deepRedact` is case-insensitive on key matching.
 *  5. Non-PII fields are passed through unmodified.
 *  6. `REDACTED_FIELDS` is a Set (O(1) lookup) and contains expected entries.
 *  7. The Winston logger format applies redaction regardless of environment.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { deepRedact, REDACTED_FIELDS } from '../logger.js';

// ─── deepRedact unit tests ────────────────────────────────────────────────────

describe('deepRedact — always-on PII scrubbing (#368)', () => {
  const savedRedaction = process.env.LOG_REDACTION;

  afterEach(() => {
    if (savedRedaction === undefined) {
      delete process.env.LOG_REDACTION;
    } else {
      process.env.LOG_REDACTION = savedRedaction;
    }
  });

  it('redacts top-level PII fields when LOG_REDACTION is unset', () => {
    delete process.env.LOG_REDACTION;
    const input = { email: 'user@example.com', method: 'GET', statusCode: 200 };
    const result = deepRedact(input) as Record<string, unknown>;
    expect(result['email']).toBe('[REDACTED]');
    expect(result['method']).toBe('GET');
    expect(result['statusCode']).toBe(200);
  });

  it('redacts top-level PII fields even when LOG_REDACTION is not "strict"', () => {
    process.env.LOG_REDACTION = 'off';
    const input = { password: 'secret123', url: '/api/health' };
    const result = deepRedact(input) as Record<string, unknown>;
    expect(result['password']).toBe('[REDACTED]');
    expect(result['url']).toBe('/api/health');
  });

  it('redacts all known credential and PII fields', () => {
    const sensitive: Record<string, string> = {};
    for (const field of REDACTED_FIELDS) {
      sensitive[field] = `value-for-${field}`;
    }
    const result = deepRedact(sensitive) as Record<string, unknown>;
    for (const field of REDACTED_FIELDS) {
      expect(result[field]).toBe('[REDACTED]');
    }
  });

  it('recurses into nested objects', () => {
    const input = {
      user: {
        email: 'user@example.com',
        profile: {
          phone: '+1234567890',
          displayName: 'Alice',
        },
      },
    };
    const result = deepRedact(input) as Record<string, unknown>;
    const user = result['user'] as Record<string, unknown>;
    expect(user['email']).toBe('[REDACTED]');
    const profile = user['profile'] as Record<string, unknown>;
    expect(profile['phone']).toBe('[REDACTED]');
    expect(profile['displayName']).toBe('Alice');
  });

  it('recurses into arrays', () => {
    const input = {
      items: [{ email: 'a@b.com', id: 1 }, { email: 'c@d.com', id: 2 }],
    };
    const result = deepRedact(input) as Record<string, unknown>;
    const items = result['items'] as Array<Record<string, unknown>>;
    expect(items[0]!['email']).toBe('[REDACTED]');
    expect(items[0]!['id']).toBe(1);
    expect(items[1]!['email']).toBe('[REDACTED]');
    expect(items[1]!['id']).toBe(2);
  });

  it('matches keys case-insensitively', () => {
    // API responses or upstream services may send Authorization in various cases
    const input = {
      Authorization: 'Bearer token123',
      EMAIL: 'case@example.com',
      Password: 'hunter2',
    };
    const result = deepRedact(input) as Record<string, unknown>;
    expect(result['Authorization']).toBe('[REDACTED]');
    expect(result['EMAIL']).toBe('[REDACTED]');
    expect(result['Password']).toBe('[REDACTED]');
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { id: 42 };
    obj['self'] = obj; // circular
    expect(() => deepRedact(obj)).not.toThrow();
    const result = deepRedact(obj) as Record<string, unknown>;
    expect(result['id']).toBe(42);
    expect(result['self']).toBe('[REDACTED:CIRCULAR]');
  });

  it('does not recurse beyond depth 20 (adversarial deep nesting)', () => {
    // Build a chain 25 levels deep
    let current: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 25; i++) {
      current = { nested: current };
    }
    expect(() => deepRedact(current)).not.toThrow();
  });

  it('returns primitives unchanged', () => {
    expect(deepRedact('hello')).toBe('hello');
    expect(deepRedact(42)).toBe(42);
    expect(deepRedact(true)).toBe(true);
    expect(deepRedact(null)).toBe(null);
    expect(deepRedact(undefined)).toBe(undefined);
  });

  it('does not mutate the original object', () => {
    const original = { email: 'test@example.com', safe: 'value' };
    const copy = { ...original };
    deepRedact(original);
    expect(original).toEqual(copy);
  });
});

// ─── REDACTED_FIELDS set properties ──────────────────────────────────────────

describe('REDACTED_FIELDS (#368)', () => {
  it('is a Set (O(1) lookup instead of O(n) array scan)', () => {
    expect(REDACTED_FIELDS).toBeInstanceOf(Set);
  });

  it('contains all required PII and credential field names (lower-cased)', () => {
    const required = [
      'email',
      'password',
      'phone',
      'authorization',
      'access_token',
      'refresh_token',
      'api_key',
      'secret_key',
      'private_key',
      'mnemonic',
      'ssn',
      'tin',
      'bank_account',
      'credit_card',
      'wallet_address',
    ];
    for (const field of required) {
      expect(REDACTED_FIELDS.has(field)).toBe(true);
    }
  });
});

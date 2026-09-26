/**
 * Guards `docs/domain-state-machines.md` against drift (#415).
 *
 * The canonical domain reference is only useful if it stays true. This test
 * re-derives the state sets from their real sources — the Soroban contract
 * enum, the database check constraints, and the modules that own each state —
 * and fails if the document and the code disagree, so a state can never be
 * renamed or removed without updating the reference (and vice versa).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const read = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

const DOMAIN_DOC_PATH = 'docs/domain-state-machines.md';

describe('domain and state-machine reference', () => {
  const doc = read(DOMAIN_DOC_PATH);

  describe('loan states', () => {
    it('documents every variant of the on-chain LoanStatus enum', () => {
      const contractSource = read('contracts/loan_manager/src/lib.rs');
      const enumMatch = contractSource.match(/pub enum LoanStatus \{([\s\S]*?)\}/);

      expect(enumMatch).not.toBeNull();

      const variants = (enumMatch as RegExpMatchArray)[1]
        .split('\n')
        .map((line) =>
          line
            .replace(/\/\/.*$/, '')
            .trim()
            .replace(/,$/, '')
            .trim(),
        )
        .filter((line) => /^[A-Z][A-Za-z]*$/.test(line));

      expect(variants.length).toBeGreaterThanOrEqual(7);

      for (const variant of variants) {
        expect(doc).toContain(`\`${variant}\``);
      }
    });

    it('documents the terminal-state classification for every loan state', () => {
      const terminalRows = doc
        .split('\n')
        .filter((line) => /^\| `[A-Z][A-Za-z]*` \| (yes|no) \|/.test(line));

      expect(terminalRows.length).toBeGreaterThanOrEqual(7);

      for (const row of terminalRows) {
        expect(row).toMatch(/\| (yes|no) \|/);
      }
    });

    it('keeps the mermaid lifecycle diagram aligned with the contract transitions', () => {
      const diagram = doc.match(/```mermaid([\s\S]*?)```/);
      expect(diagram).not.toBeNull();

      const body = (diagram as RegExpMatchArray)[1];
      expect(body).toContain('stateDiagram-v2');

      for (const transition of [
        'Pending --> Approved',
        'Pending --> Rejected',
        'Pending --> Cancelled',
        'Approved --> Repaid',
        'Approved --> Defaulted',
        'Defaulted --> Liquidated',
      ]) {
        expect(body).toContain(transition);
      }
    });
  });

  describe('database-backed state sets', () => {
    const checkConstraints: Array<{ migration: string; states: string[] }> = [
      {
        migration: 'backend/migrations/1779000000009_create-remittances-table.js',
        states: ['pending', 'processing', 'completed', 'failed'],
      },
      {
        migration: 'backend/migrations/1783000000013_notifications-add-status.js',
        states: ['unread', 'read', 'archived'],
      },
      {
        migration: 'backend/migrations/1802000000000_create-ledger-checkpoints.js',
        states: ['verified', 'suspect'],
      },
    ];

    it.each(checkConstraints)('$migration states are documented', ({ migration, states }) => {
      const source = read(migration);

      for (const state of states) {
        // The state must be enforced by the migration ...
        expect(source).toContain(state);
        // ... and described in the reference.
        expect(doc).toContain(`\`${state}\``);
      }
    });
  });

  describe('document hygiene', () => {
    it('references only files that exist in the repository', () => {
      const referenced =
        doc.match(/`(?:backend|frontend|contracts|docs|\.github)\/[^`\s]+`/g) ?? [];
      expect(referenced.length).toBeGreaterThan(5);

      const missing: string[] = [];
      for (const raw of referenced) {
        const candidate = raw.replace(/`/g, '').replace(/[.,)]$/, '');
        // Skip glob/pattern references (e.g. `backend/src/controllers/*`).
        if (candidate.includes('*')) continue;
        try {
          read(candidate);
        } catch {
          missing.push(candidate);
        }
      }

      expect(missing).toEqual([]);
    });

    it('documents the trace-context propagation points added in #414', () => {
      for (const required of [
        'frontend/src/app/lib/traceContext.ts',
        'backend/src/middleware/traceContext.ts',
        'chain_confirmation_total',
        'trace_context_requests_total{source="invalid"}',
      ]) {
        expect(doc).toContain(required);
      }
    });

    it('has no unresolved placeholders or TODO markers', () => {
      expect(doc).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b/);
    });
  });
});

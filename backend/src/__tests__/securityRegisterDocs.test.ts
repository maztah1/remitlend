/**
 * Structural validation for `docs/SECURITY-ASSUMPTIONS.md` (#417).
 *
 * A register is only trustworthy if every entry is explicit and verifiable:
 * a unique id, a named owner, an allowed status, a review date, and a
 * verification reference that actually resolves in this repository. This test
 * enforces those invariants so the register cannot degrade into prose that
 * silently stops matching reality.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const read = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

const REGISTER_PATH = 'docs/SECURITY-ASSUMPTIONS.md';
const ALLOWED_STATUS = new Set(['validated', 'monitored', 'accepted', 'mitigated', 'open']);

interface RegisterRow {
  id: string;
  cells: string[];
}

const parseTable = (doc: string, header: string, idPrefix: 'A' | 'L'): RegisterRow[] => {
  const section = doc.split(header)[1] ?? '';

  return section
    .split('\n')
    .filter((line) => new RegExp(`^\\| ${idPrefix}-\\d+ \\|`).test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { id: cells[0], cells };
    });
};

describe('security assumptions and limitations register', () => {
  const doc = read(REGISTER_PATH);

  it('declares ownership, cadence, and enforcement up front', () => {
    expect(doc).toContain('**Owner:**');
    expect(doc).toContain('**Review cadence:**');
    expect(doc).toContain('securityRegisterDocs.test.ts');
  });

  it('keeps a threat model with enforced controls for each asset', () => {
    const threatModelRows = doc
      .split('## Threat model in one page')[1]
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'));

    // header + one row per asset class
    expect(threatModelRows.length).toBeGreaterThanOrEqual(8);
    expect(doc).toContain('Trust boundaries:');
  });

  describe('assumptions', () => {
    const rows = parseTable(doc, '## Assumptions', 'A');

    it('registers a non-trivial number of assumptions', () => {
      expect(rows.length).toBeGreaterThanOrEqual(6);
    });

    it('uses unique, sequential A-n ids', () => {
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id, index) => expect(id).toBe(`A-${index + 1}`));
    });

    it('fills every required column of every assumption', () => {
      for (const { id, cells } of rows) {
        expect(cells).toHaveLength(8);
        const [_, assumption, boundary, rationale, verification, owner, status, reviewBy] = cells;

        expect(id).toMatch(/^A-\d+$/);
        expect(assumption.length).toBeGreaterThan(10);
        expect(boundary.length).toBeGreaterThan(2);
        expect(rationale.length).toBeGreaterThan(10);
        expect(verification.length).toBeGreaterThan(3);
        expect(owner.length).toBeGreaterThan(2);
        expect(ALLOWED_STATUS.has(status)).toBe(true);
        expect(reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('references verification artefacts that exist in the repository', () => {
      const missing: string[] = [];

      for (const { cells } of rows) {
        const verification = cells[4] ?? '';
        const referencedPaths = verification.match(/`([^`]+)`/g) ?? [];
        expect(referencedPaths.length).toBeGreaterThan(0);

        for (const raw of referencedPaths) {
          const candidate = raw.replace(/`/g, '');
          // Only repo paths are resolvable; identifiers/globs are allowed as-is.
          if (!/^(backend|frontend|contracts|docs|\.github)\//.test(candidate)) continue;
          try {
            read(candidate);
          } catch {
            missing.push(`${cells[0]} -> ${candidate}`);
          }
        }
      }

      expect(missing).toEqual([]);
    });
  });

  describe('limitations', () => {
    const rows = parseTable(doc, '## Limitations (accepted risks)', 'L');

    it('registers a non-trivial number of limitations', () => {
      expect(rows.length).toBeGreaterThanOrEqual(5);
    });

    it('uses unique, sequential L-n ids', () => {
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id, index) => expect(id).toBe(`L-${index + 1}`));
    });

    it('states an impact and a compensating control for every limitation', () => {
      for (const { id, cells } of rows) {
        expect(cells).toHaveLength(8);
        const [, limitation, impact, control, , owner, status, reviewBy] = cells;

        expect(id).toMatch(/^L-\d+$/);
        expect(limitation.length).toBeGreaterThan(10);
        expect(impact.length).toBeGreaterThan(10);
        expect(control.length).toBeGreaterThan(10);
        expect(owner.length).toBeGreaterThan(2);
        expect(ALLOWED_STATUS.has(status)).toBe(true);
        expect(reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('marks limitations with no planned fix as accepted', () => {
      const accepted = new Set(
        rows.filter((row) => row.cells[6] === 'accepted').map((row) => row.id),
      );
      expect(accepted.size).toBeGreaterThan(0);
    });
  });

  it('keeps the non-goals and change process documented', () => {
    expect(doc).toContain('## Explicit non-goals');
    expect(doc).toContain('## Changing this register');
    expect(doc).toContain('npm test -- securityRegisterDocs');
  });

  it('links the register from the repository security policy', () => {
    expect(read('SECURITY.md')).toContain('docs/SECURITY-ASSUMPTIONS.md');
  });
});

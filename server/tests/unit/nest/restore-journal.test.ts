import {
  assertNoInterruptedRestore,
  beginRestoreJournal,
  markRestoreJournal,
} from '../../../src/nest/backup/restore-journal';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-restore-journal-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('restore crash journal', () => {
  it('fails boot closed when a non-committed restore journal remains', () => {
    const root = tempRoot();
    const journal = path.join(root, 'restore-journal-test');
    beginRestoreJournal(journal, 'test');
    markRestoreJournal(journal, 'db-swapped');

    expect(() => assertNoInterruptedRestore(root)).toThrow(/interrupted backup restore/i);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it('reaps a committed journal as post-commit garbage', () => {
    const root = tempRoot();
    const journal = path.join(root, 'restore-journal-test');
    beginRestoreJournal(journal, 'test');
    markRestoreJournal(journal, 'committed');

    expect(() => assertNoInterruptedRestore(root)).not.toThrow();
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('fails closed on an unreadable or legacy journal with no valid marker', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'restore-journal-unknown'));

    expect(() => assertNoInterruptedRestore(root)).toThrow(/unknown restore journal/i);
  });
});

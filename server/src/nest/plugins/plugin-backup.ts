import fs from 'node:fs';
import path from 'node:path';
import { pluginsCodeRoot, pluginsDataRoot } from './paths';

/**
 * Backup/restore of the plugin trees (#plugins). A TREK backup archives travel.db +
 * uploads + the encryption key, but a plugin's per-plugin SQLite file (its ONLY copy
 * of the user data it holds) and its installed code live in separate trees — without
 * these, a restored instance has the `plugins` rows but none of their data or code.
 *
 * The tricky half is restore: the HOST holds each plugin DB open (better-sqlite3), so
 * overwriting those files live is unsafe (and on Windows, locked). Instead restore
 * STAGES the extracted trees next to the live ones, and this module swaps them in at
 * the next boot BEFORE the runtime opens anything — the same "applies on restart" model
 * the bundled encryption key already uses. No plugin quiesce, no swap under open
 * handles, no new admin setup.
 */

const STAGE_SUFFIX = '.restore';

function dataStaging(): string { return pluginsDataRoot() + STAGE_SUFFIX; }
function codeStaging(): string { return pluginsCodeRoot() + STAGE_SUFFIX; }

/** Remove every published or incomplete staging tree. Restore owns this on a
 * failed DB/object transaction so a later boot can never apply abandoned data. */
export function discardStagedPluginTrees(): void {
  const failures: unknown[] = [];
  for (const target of [dataStaging(), codeStaging()]) {
    for (const candidate of [target, target + '.tmp']) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
      } catch (err) {
        failures.push(err);
      }
    }
  }
  if (failures.length) throw new Error('Failed to discard staged plugin restore trees.', { cause: failures[0] });
}

/**
 * Copy the plugin trees an archive extracted (under `extractDir/plugins-data` and
 * `.../plugins-code`) into staging dirs beside the live trees. cpSync (not rename) so
 * it works even when the plugin volumes sit on a different filesystem than the extract
 * dir. A no-op for a backup that carries no plugin trees (older archives). Returns true
 * if anything was staged (so restore can tell the admin a restart is needed to finish).
 *
 * Staging is made atomic with a `.tmp` sibling: the (interruptible) copy lands in
 * `<root>.restore.tmp`, and only a fully-copied tree is renamed to `<root>.restore`.
 * The rename is same-directory (same filesystem), so it's atomic. Without this a copy
 * that dies partway — disk full, OOM, a crash — would leave a PARTIAL `.restore`, and
 * the next boot's swap deletes every live plugin dir not present in it: data loss, even
 * though the restore reported success. A leftover `.tmp` is inert (the apply path only
 * looks for `.restore`) and is cleared on the next staging.
 */
export function stageExtractedPluginTrees(extractDir: string): boolean {
  const pairs: Array<[string, string]> = [
    [path.join(extractDir, 'plugins-data'), dataStaging()],
    [path.join(extractDir, 'plugins-code'), codeStaging()],
  ];
  const present = pairs.filter(([from]) => fs.existsSync(from));
  if (present.length === 0) return false;

  try {
    // A plugin archive commonly contains both trees. Do not publish either
    // `.restore` until every source tree has copied to its inert sibling: a
    // failure while copying code must never leave data staged for a later boot
    // to apply as a seemingly successful restore.
    discardStagedPluginTrees();
    for (const [from, to] of present) {
      fs.cpSync(from, to + '.tmp', { recursive: true });
    }
    // The individual same-directory renames are atomic. If publication of a
    // later tree fails, the catch below rolls every published sibling back so
    // no partial `.restore` can be applied on the next boot.
    for (const [, to] of present) {
      fs.renameSync(to + '.tmp', to);
    }
    return true;
  } catch (err) {
    const cleanupErrors: unknown[] = [];
    try { discardStagedPluginTrees(); } catch (cleanupErr) { cleanupErrors.push(cleanupErr); }
    if (cleanupErrors.length > 0) {
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin restore staging failed (${original}); rollback cleanup also failed.`, { cause: err });
    }
    throw err;
  }
}

/**
 * Replace the CONTENTS of `live` with `staged`, entry by entry — never renaming the
 * root itself, because a root that is a bind/volume mount point can't be renamed
 * (EBUSY) or moved across a filesystem (EXDEV). Existing DEV-LINK entries in `live`
 * (a plugin dir symlinked/junctioned to an author's source, which the backup deliberately
 * excluded) are preserved, so a same-instance backup→restore round trip doesn't destroy
 * them. Same-fs renames where possible, copy+remove for the cross-fs case.
 */
function copyContents(live: string, staged: string): void {
  fs.mkdirSync(live, { recursive: true });
  const realLive = fs.realpathSync(live);
  const stagedNames = new Set(fs.readdirSync(staged));
  // COPY (not move) each staged entry over the live one, leaving `staged` intact until the
  // very end. This is the key to crash-safety: `staged` stays the complete source of truth
  // for the whole operation, so if the process dies mid-swap (power loss, OOM, an exit-hook
  // throw) the next boot re-runs swapContents and re-copies everything correctly — nothing
  // is ever left half-deleted. (A move/rename would empty `staged` as it went, so a retry
  // could no longer restore an already-moved entry it had just deleted from `live`.)
  for (const name of stagedNames) {
    const to = path.join(live, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(staged, name), to, { recursive: true });
  }
  // Remove live entries NOT in the backup (plugins uninstalled since it was taken), keeping
  // dev-links (realpath points outside the root). Safe now that every backup entry is in place.
  for (const name of fs.readdirSync(live)) {
    if (stagedNames.has(name)) continue;
    const p = path.join(live, name);
    let real: string;
    try { real = fs.realpathSync(p); } catch { real = p; }
    if (real !== p && !real.startsWith(realLive + path.sep)) continue; // dev-link → keep
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function rollbackSnapshot(live: string): string { return `${live}.pre-restore`; }

function snapshotLiveTree(live: string, snapshot: string): void {
  fs.rmSync(snapshot, { recursive: true, force: true });
  if (fs.existsSync(live)) fs.cpSync(live, snapshot, { recursive: true });
  else fs.mkdirSync(snapshot, { recursive: true });
}

export interface PluginRestoreTransaction {
  /** The live plugin trees now carrying restored bytes. */
  readonly labels: readonly string[];
  /** Restore every live tree from the pre-restore snapshots and remove stale staging. */
  rollback(): void;
  /**
   * Commit the restored pair. Staging removal is the rollback-safe pre-commit step;
   * snapshot removal runs only after the commit point as best-effort garbage cleanup.
   */
  commitCleanup(): void;
}

type PluginTreePair = [label: string, live: string, staged: string];

function discardStagingArtifacts(pending: PluginTreePair[]): void {
  for (const [, , staged] of pending) fs.rmSync(staged, { recursive: true, force: true });
}

function discardCommittedSnapshots(snapshots: string[]): void {
  // Deleting two independent filesystem trees has no all-or-nothing primitive. Once
  // staging is gone, the restored DB/uploads are already committed and a later snapshot
  // deletion failure cannot safely trigger a pair rollback: an earlier snapshot may have
  // been removed. Keep any orphan for operator cleanup and never report this as a failed
  // restore transaction.
  for (const snapshot of snapshots) fs.rmSync(snapshot, { recursive: true, force: true });
}

function transactionFor(pending: PluginTreePair[], snapshots: string[]): PluginRestoreTransaction {
  let state: 'active' | 'committed' | 'rolled-back' = 'active';

  const requireActive = (action: string): void => {
    if (state !== 'active') throw new Error(`Plugin restore transaction cannot ${action} after it was ${state}.`);
  };

  return {
    labels: pending.map(([label]) => label),
    commitCleanup: () => {
      requireActive('commit cleanup');
      try {
        discardStagingArtifacts(pending);
      } catch (err) {
        throw new Error('Plugin restore staging cleanup failed; rollback receipt remains usable.', { cause: err });
      }
      state = 'committed';
      try {
        discardCommittedSnapshots(snapshots);
      } catch (err) {
        console.error('[plugins] restore committed but pre-restore snapshot cleanup failed; retaining orphan for operator cleanup:', err);
      }
    },
    rollback: () => {
      requireActive('roll back');
      const rollbackErrors: unknown[] = [];
      for (let i = pending.length - 1; i >= 0; i--) {
        try { copyContents(pending[i][1], snapshots[i]); } catch (err) { rollbackErrors.push(err); }
      }
      if (rollbackErrors.length) {
        throw new Error('Plugin restore rollback could not restore both live trees; rollback artifacts were retained.', { cause: rollbackErrors[0] });
      }
      try {
        discardStagingArtifacts(pending);
      } catch (err) {
        throw new Error('Plugin restore rollback restored the live trees but could not discard stale staging.', { cause: err });
      }
      state = 'rolled-back';
      try {
        discardCommittedSnapshots(snapshots);
      } catch (err) {
        console.error('[plugins] restore rollback completed but pre-restore snapshot cleanup failed; retaining orphan for operator cleanup:', err);
      }
    },
  };
}

/**
 * Apply staged plugin trees but retain the staged bytes and the exact pre-restore
 * snapshots as a receipt. The restore coordinator must call `commitCleanup` only after
 * its database and upload phases succeed; otherwise it calls `rollback` so the plugin
 * data/code pair returns with the core transaction.
 */
export function applyStagedPluginTreesTransaction(): PluginRestoreTransaction | null {
  const pairs: PluginTreePair[] = [
    ['plugins-data', pluginsDataRoot(), dataStaging()],
    ['plugins-code', pluginsCodeRoot(), codeStaging()],
  ];
  const pending = pairs.filter(([, , staged]) => fs.existsSync(staged));
  if (!pending.length) return null;
  const snapshots = pending.map(([, live]) => rollbackSnapshot(live));
  const snapshotted: PluginTreePair[] = [];
  try {
    for (let i = 0; i < pending.length; i++) {
      snapshotLiveTree(pending[i][1], snapshots[i]);
      snapshotted.push(pending[i]);
    }
    for (const [, live, staged] of pending) copyContents(live, staged);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    for (let i = snapshotted.length - 1; i >= 0; i--) {
      const snapshot = rollbackSnapshot(snapshotted[i][1]);
      try { copyContents(snapshotted[i][1], snapshot); } catch (rollbackErr) { rollbackErrors.push(rollbackErr); }
    }
    if (rollbackErrors.length) {
      throw new Error('Plugin restore apply failed and rollback could not restore both live trees; staging was retained for quarantine.', { cause: err });
    }
    try {
      discardCommittedSnapshots(snapshots);
    } catch (cleanupErr) {
      console.error('[plugins] restore apply failed and live trees were restored, but pre-restore snapshot cleanup failed; retaining orphan for operator cleanup:', cleanupErr);
    }
    throw new Error('Plugin restore apply failed; both live trees were restored and staging was retained.', { cause: err });
  }

  return transactionFor(pending, snapshots);
}

/**
 * Compatibility wrapper for boot reconciliation. Boot owns no broader restore
 * transaction, so it applies and commits cleanup as one operation. A staging cleanup
 * failure rolls back while the receipt still has both pre-restore trees. Snapshot
 * cleanup happens after the irreversible commit point and is best-effort by contract.
 */
export function applyStagedPluginTrees(): string[] {
  const transaction = applyStagedPluginTreesTransaction();
  if (!transaction) return [];
  try {
    transaction.commitCleanup();
  } catch (err) {
    try {
      transaction.rollback();
    } catch (rollbackErr) {
      throw new Error('Plugin restore cleanup failed and boot reconciliation could not roll back both live trees.', { cause: rollbackErr });
    }
    throw err;
  }
  return [...transaction.labels];
}

// A restore can't swap the plugin trees while the runtime holds their DB handles open,
// and it must NOT leave the swap for an arbitrary future boot (by then the live data has
// diverged, so applying stale staged data would silently revert it and resurrect erased
// rows). So the runtime registers an applier here that QUIESCES the plugins (closing the
// handles) and applies the swap right away; the restore calls it the moment it finishes
// staging. If the runtime isn't up, staging simply waits for the boot reconcile — with no
// running plugins, there is nothing to diverge.
type StagedRestoreApplier = () => PluginRestoreTransaction | Promise<PluginRestoreTransaction>;

let applier: StagedRestoreApplier | null = null;
export function setStagedRestoreApplier(fn: StagedRestoreApplier | null): void {
  applier = fn;
}
export async function applyStagedRestoreNow(): Promise<boolean> {
  if (!applier) return false;
  try {
    const transaction = await applier();
    transaction.commitCleanup();
    return true;
  } catch (err) {
    console.error('[plugins] immediate staged-restore apply failed; will retry on next boot:', err);
    return false;
  }
}

/**
 * Transactional restore callers must distinguish "no live runtime" from an
 * applier that started swapping trees and then failed (including cleanup). The
 * historical boolean helper deliberately remains best-effort for noncritical
 * callers; this strict variant returns the receipt without cleanup so the caller
 * can atomically commit or roll back its DB, uploads, and plugin trees together.
 */
export async function applyStagedRestoreNowStrict(): Promise<PluginRestoreTransaction | null> {
  // No registered runtime means no plugin process or DB handle needs quiescing
  // (for example when plugins are disabled). Apply directly but still return the
  // same receipt so the broader DB/uploads restore owns commit versus rollback.
  return applier ? applier() : applyStagedPluginTreesTransaction();
}

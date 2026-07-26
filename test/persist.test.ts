// Session persistence (autosave/restore) against fake-indexeddb.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  saveSession,
  loadSession,
  clearSession,
  recordRecent,
  listRecents,
  getRecentBytes,
  setRecentPinned,
  removeRecent,
  clearRecents,
} from '../src/viewer/persist';

// persist.ts memoizes its DB connection, so isolate tests by clearing the
// stores rather than swapping the global factory
beforeEach(async () => {
  await clearSession();
  await clearRecents();
});

describe('session persistence', () => {
  it('round-trips a snapshot', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await saveSession({ bytes, fileName: 'doc.pdf', savedAt: 1234 });
    const s = await loadSession();
    expect(s).not.toBeNull();
    expect([...s!.bytes]).toEqual([1, 2, 3, 4]);
    expect(s!.fileName).toBe('doc.pdf');
    expect(s!.savedAt).toBe(1234);
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadSession()).toBeNull();
  });

  it('overwrites on repeated saves (single slot)', async () => {
    await saveSession({ bytes: new Uint8Array([1]), fileName: 'a.pdf', savedAt: 1 });
    await saveSession({ bytes: new Uint8Array([2, 2]), fileName: 'b.pdf', savedAt: 2 });
    const s = await loadSession();
    expect(s!.fileName).toBe('b.pdf');
    expect(s!.bytes.length).toBe(2);
  });

  it('clearSession removes the snapshot', async () => {
    await saveSession({ bytes: new Uint8Array([1]), fileName: 'a.pdf', savedAt: 1 });
    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it('rejects an empty-bytes snapshot on load (integrity guard)', async () => {
    await saveSession({ bytes: new Uint8Array(0), fileName: 'a.pdf', savedAt: 1 });
    expect(await loadSession()).toBeNull();
  });
});

describe('recent files', () => {
  const bytesA = new Uint8Array([1, 1, 1]);
  const bytesB = new Uint8Array([2, 2, 2, 2]);

  it('records, lists (newest first), and round-trips bytes', async () => {
    await recordRecent(bytesA, { name: 'a.pdf', pageCount: 1 });
    await new Promise((r) => setTimeout(r, 5)); // distinct openedAt timestamps
    await recordRecent(bytesB, { name: 'b.pdf', pageCount: 2 });
    const list = await listRecents();
    expect(list.map((m) => m.name)).toEqual(['b.pdf', 'a.pdf']);
    expect(list[1].size).toBe(3);
    const got = await getRecentBytes(list[0].hash);
    expect([...got!]).toEqual([...bytesB]);
  });

  it('same bytes update in place (content-hashed key), keeping pin state', async () => {
    await recordRecent(bytesA, { name: 'a.pdf', pageCount: 1 });
    const [first] = await listRecents();
    await setRecentPinned(first.hash, true);
    await recordRecent(bytesA, { name: 'renamed.pdf', pageCount: 1 });
    const list = await listRecents();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('renamed.pdf');
    expect(list[0].pinned).toBe(true);
  });

  it('evicts oldest unpinned past the count cap; pinned survive', async () => {
    await recordRecent(new Uint8Array([9, 9]), { name: 'pinned.pdf', pageCount: 1 }, { maxCount: 3, maxBytes: 1e9 });
    const [pinnedEntry] = await listRecents();
    await setRecentPinned(pinnedEntry.hash, true);
    for (let i = 0; i < 5; i++) {
      await recordRecent(
        new Uint8Array([i, i + 1, i + 2, 7]),
        { name: `f${i}.pdf`, pageCount: 1 },
        { maxCount: 3, maxBytes: 1e9 },
      );
    }
    const list = await listRecents();
    expect(list.length).toBe(3);
    expect(list.some((m) => m.name === 'pinned.pdf')).toBe(true);
    expect(list.some((m) => m.name === 'f4.pdf')).toBe(true); // just-written is exempt
    // evicted entries lost their bytes too (meta and bytes never drift)
    for (const gone of ['f0.pdf', 'f1.pdf']) {
      expect(list.some((m) => m.name === gone)).toBe(false);
    }
  });

  it('evicts by total size cap', async () => {
    const big = (n: number) => new Uint8Array(100).fill(n);
    await recordRecent(big(1), { name: 'x1.pdf', pageCount: 1 }, { maxCount: 100, maxBytes: 250 });
    await recordRecent(big(2), { name: 'x2.pdf', pageCount: 1 }, { maxCount: 100, maxBytes: 250 });
    await recordRecent(big(3), { name: 'x3.pdf', pageCount: 1 }, { maxCount: 100, maxBytes: 250 });
    const list = await listRecents();
    expect(list.length).toBe(2);
    expect(list.some((m) => m.name === 'x1.pdf')).toBe(false);
  });

  it('removeRecent deletes meta and bytes', async () => {
    await recordRecent(bytesA, { name: 'a.pdf', pageCount: 1 });
    const [m] = await listRecents();
    await removeRecent(m.hash);
    expect(await listRecents()).toHaveLength(0);
    expect(await getRecentBytes(m.hash)).toBeNull();
  });
});

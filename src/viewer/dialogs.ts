// Overlay UI that isn't a page: the previously-opened-files dialog (thumbtack
// button), the session-restore bar, and the "?" help tips.

import {
  loadSession,
  clearSession,
  listRecents,
  getRecentBytes,
  setRecentPinned,
  removeRecent,
  clearRecents,
  type SessionSnapshot,
} from './persist';
import { $, pagesEl, toast } from './ui';
import { doc } from './state';
import { fmtSize } from './util';
import { recentsEnabled, setRecentsEnabled } from './prefs';
import { openBytes, DOCUMENT_OPENED_EVENT } from './open-save';

// ---------- previously opened files ----------

let recentsDialog: HTMLDivElement | null = null;

function closeRecentsDialog(): void {
  recentsDialog?.remove();
  recentsDialog = null;
}

export async function openRecentsDialog(): Promise<void> {
  closeRecentsDialog();
  const backdrop = document.createElement('div');
  backdrop.className = 'recents-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeRecentsDialog();
  });

  const panel = document.createElement('div');
  panel.className = 'recents-panel';
  const title = document.createElement('h2');
  title.textContent = 'Recent files';
  panel.append(title);

  const list = document.createElement('div');
  list.className = 'recents-list';
  const entries = await listRecents().catch(() => []);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'recents-empty';
    empty.textContent = recentsEnabled() ? 'No recent files yet.' : 'Remembering recent files is turned off.';
    list.append(empty);
  }
  for (const m of entries) {
    const row = document.createElement('div');
    row.className = 'recents-row';
    const thumb = document.createElement('img');
    thumb.className = 'recents-thumb';
    if (m.thumb) thumb.src = m.thumb;
    thumb.alt = '';
    const info = document.createElement('div');
    info.className = 'recents-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'recents-name';
    nameEl.textContent = m.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'recents-meta';
    metaEl.textContent = `${m.pageCount} page${m.pageCount === 1 ? '' : 's'} · ${fmtSize(m.size)} · ${new Date(m.openedAt).toLocaleDateString()}`;
    info.append(nameEl, metaEl);
    const pinBtn = document.createElement('button');
    pinBtn.className = 'recents-pin' + (m.pinned ? ' pinned' : '');
    pinBtn.textContent = '★';
    pinBtn.title = m.pinned ? 'Unpin (pinned files are never auto-removed)' : 'Pin (never auto-remove)';
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await setRecentPinned(m.hash, !m.pinned).catch(() => {});
      void openRecentsDialog(); // rebuild with fresh state
    });
    const rmBtn = document.createElement('button');
    rmBtn.className = 'recents-remove';
    rmBtn.textContent = '✕';
    rmBtn.title = 'Remove from recents';
    rmBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeRecent(m.hash).catch(() => {});
      void openRecentsDialog();
    });
    row.append(thumb, info, pinBtn, rmBtn);
    row.addEventListener('click', async () => {
      const bytes = await getRecentBytes(m.hash).catch(() => null);
      closeRecentsDialog();
      if (bytes) await openBytes(bytes, m.name);
      else toast('This file is no longer cached — open it from disk instead.', 'warn', 5000);
    });
    list.append(row);
  }
  panel.append(list);

  const footer = document.createElement('div');
  footer.className = 'recents-footer';
  const rememberLabel = document.createElement('label');
  const rememberChk = document.createElement('input');
  rememberChk.type = 'checkbox';
  rememberChk.checked = recentsEnabled();
  rememberChk.addEventListener('change', () => setRecentsEnabled(rememberChk.checked));
  rememberLabel.append(rememberChk, document.createTextNode(' Remember recent files'));
  const clearBtn = document.createElement('button');
  clearBtn.className = 'recents-clear';
  clearBtn.textContent = 'Clear all';
  clearBtn.addEventListener('click', async () => {
    await clearRecents().catch(() => {});
    void openRecentsDialog();
  });
  footer.append(rememberLabel, clearBtn);
  panel.append(footer);

  backdrop.append(panel);
  document.body.append(backdrop);
  recentsDialog = backdrop;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recentsDialog) closeRecentsDialog();
});

// ---------- help tips ----------
// The ? button cycles through short tips in the toast (same pattern as the
// sibling product PDF Mana).

const HELP_TIPS = [
  'Tip: click any paragraph and just type — the words reflow to fit, nothing else shifts.',
  'Tip: ⌘/Ctrl+Enter applies an edit, Esc cancels it.',
  'Tip: select some text in the edit box first to color just those words.',
  'Tip: on scanned PDFs, click a highlighted word to patch-fix it in place.',
  'Tip: drag an image to move it; click it, then press Delete to remove it.',
  'Tip: the ✕ at an edit box corner deletes the whole paragraph.',
  'Tip: Save PDF never overwrites your original — it always writes a new file.',
  'Tip: drop a PDF anywhere on the page to open it.',
  'Tip: ⌘/Ctrl+Z undoes any edit; your history survives until you close the tab.',
  'Tip: the Show boxes switch outlines everything the editor detected on the page.',
];
let tipIndex = 0;
$<HTMLButtonElement>('btn-help').addEventListener('click', () => {
  toast(HELP_TIPS[tipIndex], 'info', 6000);
  tipIndex = (tipIndex + 1) % HELP_TIPS.length;
});

// ---------- session restore offer ----------

let restoreBar: HTMLDivElement | null = null;

function removeRestoreBar(): void {
  restoreBar?.remove();
  restoreBar = null;
}

// opening a file supersedes any pending restore offer
document.addEventListener(DOCUMENT_OPENED_EVENT, removeRestoreBar);

function offerRestore(s: SessionSnapshot): void {
  const bar = document.createElement('div');
  bar.className = 'restore-bar';
  const msg = document.createElement('span');
  const when = new Date(s.savedAt).toLocaleString();
  msg.textContent = `You have unsaved edits to "${s.fileName}" from ${when}.`;
  const restoreBtn = document.createElement('button');
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', async () => {
    removeRestoreBar();
    await openBytes(s.bytes, s.fileName);
    doc.dirty = true; // the restored edits are still unsaved
    toast('Session restored — remember to Save As.', 'info', 5000);
  });
  const discardBtn = document.createElement('button');
  discardBtn.className = 'secondary';
  discardBtn.textContent = 'Discard';
  discardBtn.addEventListener('click', async () => {
    // await the clear BEFORE dismissing, so a fast reload can't resurrect the offer
    await clearSession().catch(() => {});
    removeRestoreBar();
  });
  bar.append(msg, restoreBtn, discardBtn);
  document.body.insertBefore(bar, pagesEl);
  restoreBar = bar;
}

/** Offer to restore unsaved edits from a previous session (crash/closed tab). */
export function offerRestoreIfAny(): void {
  void loadSession()
    .then((s) => {
      if (s && !doc.currentBytes) offerRestore(s);
    })
    .catch(() => {});
}

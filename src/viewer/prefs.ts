// localStorage-backed UI preferences. Keys keep the original editpdf working
// name so existing users' settings survive the PDF Edna rebrand.

const SHOW_BOXES_KEY = 'editpdf-show-boxes';
const REMEMBER_RECENTS_KEY = 'editpdf-remember-recents';

export function getShowBoxes(): boolean {
  try {
    return localStorage.getItem(SHOW_BOXES_KEY) === '1';
  } catch {
    return false;
  }
}

export function setShowBoxes(on: boolean): void {
  try {
    localStorage.setItem(SHOW_BOXES_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

export function recentsEnabled(): boolean {
  try {
    return localStorage.getItem(REMEMBER_RECENTS_KEY) !== '0';
  } catch {
    return false;
  }
}

export function setRecentsEnabled(on: boolean): void {
  try {
    localStorage.setItem(REMEMBER_RECENTS_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

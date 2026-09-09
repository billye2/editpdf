// MV3 service worker: the toolbar button opens the viewer in a new tab.
//
// Privacy: the extension has NO host permissions and never intercepts
// navigations. PDFs are opened via the toolbar button, file picker, and
// drag-and-drop only — PDF Edna is an editor, not a replacement viewer.

const VIEWER = chrome.runtime.getURL('viewer.html');

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: VIEWER });
});

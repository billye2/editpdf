// MV3 service worker: best-effort redirect of .pdf navigations to the viewer,
// plus the toolbar button to open the viewer directly.
//
// Privacy: the extension ships with NO standing host permissions. The redirect
// rule (which requires host access) is installed only while the user has
// granted the optional <all_urls> permission — offered as a one-click opt-in
// on the viewer's start screen. Without it, everything still works via the
// toolbar button, file picker, and drag-and-drop.

const VIEWER = chrome.runtime.getURL('viewer.html');
const RULE_ID = 1;

async function syncRedirectRule(): Promise<void> {
  try {
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: granted
        ? [
            {
              id: RULE_ID,
              priority: 1,
              action: {
                type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
                redirect: { regexSubstitution: `${VIEWER}?file=\\0` },
              },
              condition: {
                regexFilter: '^https?://.*\\.pdf(\\?.*)?$',
                resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
              },
            },
          ]
        : [],
    });
  } catch (e) {
    console.warn('EditPDF: could not sync redirect rule', e);
  }
}

chrome.runtime.onInstalled.addListener(() => void syncRedirectRule());
chrome.runtime.onStartup.addListener(() => void syncRedirectRule());
chrome.permissions.onAdded.addListener(() => void syncRedirectRule());
chrome.permissions.onRemoved.addListener(() => void syncRedirectRule());

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: VIEWER });
});

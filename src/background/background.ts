// MV3 service worker: best-effort redirect of .pdf navigations to the viewer,
// plus the toolbar button to open the viewer directly.

const VIEWER = chrome.runtime.getURL('viewer.html');

chrome.runtime.onInstalled.addListener(() => {
  void chrome.declarativeNetRequest
    .updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
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
      ],
    })
    .catch((e: unknown) => console.warn('EditPDF: could not install redirect rule', e));
});

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: VIEWER });
});

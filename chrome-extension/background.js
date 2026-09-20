chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-chat' });
  } catch (error) {
    console.debug('Couch is unavailable on this tab.', error);
  }
});

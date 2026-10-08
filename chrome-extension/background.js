chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-chat' });
    return;
  } catch (error) {
    console.debug('Couch is not injected on this tab yet.');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['keyboard-guard.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['couch-shared.js', 'socket.io.js', 'content.js']
    });
  } catch (error) {
    console.debug('Couch is unavailable on this tab.', error);
  }
});

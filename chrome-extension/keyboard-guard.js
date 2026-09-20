(() => {
  function isCouchEditableEvent(event) {
    const path = event.composedPath();
    const isCouchControl = path.some((node) =>
      node instanceof HTMLElement && node.id === 'watch-party-host'
    );
    const isEditable = path.some((node) =>
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLElement && node.isContentEditable)
    );

    return isCouchControl && isEditable;
  }

  function stopPageShortcut(event) {
    if (isCouchEditableEvent(event)) {
      event.stopImmediatePropagation();
    }
  }

  window.addEventListener('keydown', stopPageShortcut, true);
  window.addEventListener('keyup', stopPageShortcut, true);
})();

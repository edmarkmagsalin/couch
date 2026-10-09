const emojiSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function isSingleEmoji(text) {
  const trimmedText = String(text ?? '').trim();
  if (!trimmedText || !emojiSegmenter) return false;

  const segments = [...emojiSegmenter.segment(trimmedText)];
  if (segments.length !== 1) return false;

  return /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u.test(segments[0].segment);
}

function formatTimestamp(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const secondsText = String(remainingSeconds).padStart(2, '0');

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
    : `${minutes}:${secondsText}`;
}

function createChatResizer(handle, host, { initialHeight, onCommit = () => {} } = {}) {
  const minimumHeight = 70;
  const maximumHeight = () => Math.max(minimumHeight, Math.min(480, window.innerHeight - 220));
  const clampHeight = (height) => Math.min(maximumHeight(), Math.max(minimumHeight, height));
  const configuredHeight = Number.parseFloat(
    getComputedStyle(host).getPropertyValue('--couch-chat-height')
  );
  const startingHeight = Number.isFinite(initialHeight)
    ? initialHeight
    : Number.isFinite(configuredHeight)
      ? configuredHeight
      : 130;
  let height = clampHeight(startingHeight);
  let dragStartY = 0;
  let dragStartHeight = height;
  let isResizing = false;

  function applyHeight(nextHeight, persist = false) {
    height = clampHeight(nextHeight);
    host.style.setProperty('--couch-chat-height', `${height}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(height)));
    handle.setAttribute('aria-valuemax', String(maximumHeight()));
    if (persist) onCommit(height);
  }

  function finishResize() {
    if (!isResizing) return;
    isResizing = false;
    applyHeight(height, true);
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    isResizing = true;
    dragStartY = event.clientY;
    dragStartHeight = height;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (isResizing) applyHeight(dragStartHeight + event.clientY - dragStartY);
  });
  handle.addEventListener('pointerup', finishResize);
  handle.addEventListener('pointercancel', finishResize);
  handle.addEventListener('keydown', (event) => {
    const increments = { ArrowDown: 10, ArrowUp: -10, PageDown: 40, PageUp: -40 };
    if (event.key === 'Home') {
      event.preventDefault();
      applyHeight(minimumHeight, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      applyHeight(maximumHeight(), true);
    } else if (increments[event.key]) {
      event.preventDefault();
      applyHeight(height + increments[event.key], true);
    }
  });
  window.addEventListener('resize', () => applyHeight(height));

  handle.setAttribute('aria-valuemin', String(minimumHeight));
  applyHeight(height);

  return {
    setHeight(nextHeight) {
      if (Number.isFinite(nextHeight)) applyHeight(nextHeight);
    }
  };
}

globalThis.CouchShared = Object.freeze({ isSingleEmoji, formatTimestamp, createChatResizer });

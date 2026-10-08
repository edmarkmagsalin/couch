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

globalThis.CouchShared = Object.freeze({ isSingleEmoji, formatTimestamp });

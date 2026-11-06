import { io } from 'socket.io-client';
import remotePanelStyles from './remote-panel.css?url';

const API_URL = import.meta.env.API_URL;
const CouchShared = window.CouchShared;
const hostContainer = document.getElementById('couch-root');
hostContainer.classList.add('embedded');
const shadow = hostContainer.attachShadow({ mode: 'open' });
const theme = localStorage.getItem('couch_remote_theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;

async function initializeRemote() {
  const response = await fetch('panel.html');
  if (!response.ok) throw new Error(`Panel template request failed: ${response.status}`);

  const panelMarkup = await response.text();
  shadow.innerHTML = `
    <link rel="stylesheet" href="/panel.css">
    <link rel="stylesheet" href="${remotePanelStyles}">
    ${panelMarkup
      .replaceAll('__COUCH_LOGO_URL__', '/assets/couch.svg')
      .replaceAll('__COUCH_LINK_URL__', '/assets/link.svg')
      .replaceAll('__COUCH_USERS_URL__', '/assets/users.svg')
      .replaceAll('__COUCH_ERASER_URL__', '/assets/eraser.svg')
      .replaceAll('__COUCH_LOGOUT_URL__', '/assets/logout.svg')}
  `;

  const socket = io(API_URL);
  const status = document.getElementById('connection-status');
  const compactView = shadow.getElementById('compact-view');
  const compactMessages = shadow.getElementById('compact-messages');
  const chatResizeHandle = shadow.getElementById('chat-resize-handle');
  const viewToggleButton = shadow.getElementById('view-toggle-btn');
  const chatContainer = shadow.getElementById('chat-container');
  const lobby = shadow.getElementById('lobby');
  const shareRoomButton = shadow.getElementById('share-room-btn');
  const usernameInput = shadow.getElementById('username-input');
  const createRoomButton = shadow.getElementById('create-room-btn');
  const joinRoomForm = shadow.getElementById('join-room-form');
  const joinRoomInput = shadow.getElementById('join-room-input');
  const joinRoomButton = shadow.getElementById('join-room-btn');
  const joinError = shadow.getElementById('join-error');
  const roomLoading = shadow.getElementById('room-loading-message');
  const displayRoomId = shadow.getElementById('display-room-id');
  const typingIndicator = shadow.getElementById('typing-indicator');
  const roomUsersToggle = shadow.getElementById('room-users-toggle');
  const roomUsersCount = shadow.getElementById('room-users-count');
  const roomUsersPanel = shadow.getElementById('room-users-panel');
  const roomUsersList = shadow.getElementById('room-users-list');
  const clearChatButton = shadow.getElementById('clear-chat-btn');
  const leaveRoomButton = shadow.getElementById('leave-room-btn');
  const messageList = shadow.getElementById('messages');
  const chatForm = shadow.getElementById('chat-form');
  const chatInput = shadow.getElementById('chat-input');
  const replyComposer = shadow.getElementById('reply-composer');
  const replyComposerSender = shadow.getElementById('reply-composer-sender');
  const replyComposerText = shadow.getElementById('reply-composer-text');
  const replyCancelButton = shadow.getElementById('reply-cancel-btn');
  const emojiBar = shadow.getElementById('emoji-bar');
  const timestampButton = shadow.getElementById('timestamp-btn');
  const themeToggle = document.getElementById('theme-toggle');
  const controllerHint = document.getElementById('controller-hint');
  const seekButtons = document.getElementById('remote-seek-buttons');
  const currentTimeInput = document.getElementById('remote-current-time');
  const resetTimeButton = document.getElementById('remote-reset-time');
  const currentTimeError = document.getElementById('remote-current-time-error');
  const playbackStatusLabel = document.getElementById('remote-playback-status');
  const playbackToggle = document.getElementById('remote-toggle-playback');
  const syncPlaybackButton = document.getElementById('remote-sync-playback');
  const syncPlaybackStatus = document.getElementById('remote-sync-status');
  let syncToastTimer = null;

  function showSyncToast(message, timeoutMs = 2200) {
    syncPlaybackStatus.textContent = message;
    syncPlaybackStatus.classList.add('visible');
    if (syncToastTimer) clearTimeout(syncToastTimer);
    syncToastTimer = setTimeout(() => {
      syncPlaybackStatus.classList.remove('visible');
    }, timeoutMs);
  }
  const volumeSlider = document.getElementById('remote-volume');
  const volumeValue = document.getElementById('remote-volume-value');
  const volumePresets = document.getElementById('remote-volume-presets');
  const volumeStatus = document.getElementById('remote-volume-status');
  const themeColor = document.querySelector('meta[name="theme-color"]');

  const urlUsername = new URLSearchParams(window.location.search).get('username')?.trim() || '';
  const urlRoomCode = new URLSearchParams(window.location.search).get('roomCode')?.trim().toLowerCase() || '';
  let username = urlUsername || localStorage.getItem('couch_username')?.trim() || '';
  if (!username) {
    username = `Guest-${Math.random().toString(36).substring(2, 7)}`;
    localStorage.setItem('couch_username', username);
  }
  const roomCodeFromUrl = urlRoomCode;
  function maybeAutoJoinFromUrl() {
    if (!urlUsername || !urlRoomCode || currentRoom || isRoomJoined || joiningRoomId) return;
    submitRoomRequest(urlRoomCode, 'join');
  }
  let currentRoom = null;
  let isRoomJoined = false;
  let currentHost = null;
  let playback = { status: 'paused', timestamp: 0, updatedAt: Date.now() };
  let lastPlaybackEventAt = playback.updatedAt;
  let hasRestoredPlayback = false;
  let isEditingCurrentTime = false;
  let isCompactView = false;
  let hasRemoteVideo = false;
  let isSyncingPlayback = false;
  let playbackSyncRequestId = 0;
  let hasReceivedVolumeState = false;
  let chatHistoryClearedAt = 0;
  let joiningRoomId = null;
  let replyTarget = null;
  const seenReceiptsSent = new Set();
  const messageSeenBy = new WeakMap();

  function setReplyTarget(message, focusInput = true) {
    replyTarget = message;
    replyComposer.hidden = !message;
    chatContainer.classList.toggle('has-reply-composer', Boolean(message));
    if (message) {
      replyComposerSender.textContent = message.sender;
      replyComposerText.textContent = message.text;
      if (focusInput) chatInput.focus();
    }
  }

  function canMarkMessagesSeen() {
    return Boolean(
      currentRoom
      && isRoomJoined
      && socket.connected
      && !document.hidden
      && !isCompactView
      && chatContainer.classList.contains('remote-expanded')
    );
  }

  function markMessageSeen(row) {
    const messageId = row.dataset.serverMessageId;
    if (
      !messageId
      || row.dataset.messageSender === username
      || row.classList.contains('system')
      || !canMarkMessagesSeen()
    ) {
      return;
    }

    const receiptKey = `${currentRoom}\0${messageId}`;
    if (seenReceiptsSent.has(receiptKey)) return;
    seenReceiptsSent.add(receiptKey);
    socket.emit('message-seen', { roomId: currentRoom, messageId });
  }

  function scheduleVisibleMessageSeenScan() {
    requestAnimationFrame(() => {
      if (!canMarkMessagesSeen()) return;
      for (const row of messageList.children) {
        messageSeenObserver.unobserve(row);
        messageSeenObserver.observe(row);
      }
    });
  }

  function renderMessageSeenIndicator(row, seenBy, isSent = true) {
    const names = [...new Set((Array.isArray(seenBy) ? seenBy : [])
      .filter((name) => typeof name === 'string' && name && name !== username))];
    messageSeenBy.set(row, names);
    const content = row.querySelector('.message-content');
    if (content) {
      content.title = [
        row.dataset.messageTimestampTitle,
        names.length > 0 ? `Seen by ${names.join(', ')}` : ''
      ].filter(Boolean).join('\n');
    }
    let indicator = row.querySelector('.message-status-icon');
    if (!isSent) {
      indicator?.remove();
      return;
    }
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'message-status-icon';
      content?.append(indicator);
    }
    CouchShared.setMessageStatusIcon(indicator, names.length > 0 ? 'seen' : 'sent');
  }

  const messageSeenObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) markMessageSeen(entry.target);
    }
  }, { root: messageList, threshold: 0.1 });

  const chatResizer = CouchShared.createChatResizer(chatResizeHandle, hostContainer, {
    initialHeight: 180,
    onCommit: (height) => localStorage.setItem('couch_remote_chat_height', String(height))
  });
  const savedChatHeight = Number(localStorage.getItem('couch_remote_chat_height'));
  if (Number.isFinite(savedChatHeight) && savedChatHeight > 0) {
    chatResizer.setHeight(savedChatHeight);
  }

  usernameInput.value = username;
  joinRoomInput.value = roomCodeFromUrl;
  timestampButton.title = 'Share current playback timestamp';
  applyTheme(theme);

  function formatTimeDigits(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, -2)}:${digits.slice(-2)}`;
    return `${digits.slice(0, -4)}:${digits.slice(-4, -2)}:${digits.slice(-2)}`;
  }

  function applyTimeFormatting(input) {
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, '').length;
    const formatted = formatTimeDigits(input.value);
    if (formatted !== input.value) {
      input.value = formatted;
      const nextCaret = getCaretAfterDigits(formatted, digitsBeforeCaret);
      input.setSelectionRange(nextCaret, nextCaret);
    }
    return input.value;
  }

  function getCaretAfterDigits(value, digitCount) {
    if (digitCount === 0) return 0;
    let seen = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (/\d/.test(value[index])) seen += 1;
      if (seen === digitCount) return index + 1;
    }
    return value.length;
  }

  const savedSessionValue = localStorage.getItem('couch_remote_session');
  if (savedSessionValue) {
    try {
      const savedSession = JSON.parse(savedSessionValue);
      const isValidSession = savedSession
        && typeof savedSession === 'object'
        && (savedSession.roomId === null || typeof savedSession.roomId === 'string')
        && ['playing', 'paused'].includes(savedSession.status)
        && Number.isFinite(savedSession.timestamp)
        && savedSession.timestamp >= 0
        && Number.isFinite(savedSession.savedAt)
        && Number.isFinite(savedSession.actionAt);

      if (!isValidSession) {
        console.warn('Saved Couch Remote session data is invalid; starting a new session.');
      } else {
        const now = Date.now();
        const elapsed = savedSession.status === 'playing' ? (now - savedSession.savedAt) / 1000 : 0;
        const restoredTimestamp = Math.max(0, savedSession.timestamp + elapsed);
        playback = {
          status: savedSession.status,
          timestamp: restoredTimestamp,
          updatedAt: now
        };
        lastPlaybackEventAt = savedSession.actionAt;
      }
    } catch (error) {
      console.error('Could not restore Couch Remote session:', error);
    }
  }

  const formatTime = CouchShared.formatTimestamp;

  function currentTimestamp() {
    const elapsed = isRoomJoined && playback.status === 'playing'
      ? (Date.now() - playback.updatedAt) / 1000
      : 0;
    return Math.max(0, playback.timestamp + elapsed);
  }

  function persistSession() {
    const timestamp = currentTimestamp();
    localStorage.setItem('couch_remote_session', JSON.stringify({
      roomId: null,
      status: playback.status,
      timestamp,
      savedAt: Date.now(),
      actionAt: lastPlaybackEventAt
    }));
  }
  persistSession();

  function emitVideoAction(action, timestamp) {
    if (!currentRoom || !isRoomJoined || !socket.connected) return;
    const eventName = action === 'play' ? 'play-video' : action === 'pause' ? 'pause-video' : 'seek-video';
    const time = Math.max(0, Number(timestamp) || 0);
    socket.emit(eventName, { roomId: currentRoom, timestamp: time }, (result) => {
      if (Number.isFinite(result?.updatedAt) && result.updatedAt >= lastPlaybackEventAt) {
        lastPlaybackEventAt = result.updatedAt;
        persistSession();
      }
    });
    socket.emit('video-action', { roomId: currentRoom, action, timestamp: time });
  }

  function setPlayback(state, timestamp, actionAt = Date.now()) {
    playback = { status: state, timestamp: Math.max(0, Number(timestamp) || 0), updatedAt: Date.now() };
    lastPlaybackEventAt = Number.isFinite(actionAt) ? actionAt : Date.now();
    persistSession();
    renderTimeline();
  }

  function renderTimeline() {
    const timestamp = currentTimestamp();
    if (!isEditingCurrentTime) currentTimeInput.value = formatTime(timestamp);
    const isPlaying = isRoomJoined && playback.status === 'playing';
    playbackStatusLabel.textContent = isPlaying ? 'Playing' : 'Paused';
    playbackToggle.classList.toggle('is-secondary', isPlaying);
    playbackToggle.setAttribute('aria-label', isPlaying ? 'Pause playback' : 'Start playback');
    playbackToggle.setAttribute('aria-pressed', String(isPlaying));
    const iconMarkup = isPlaying
      ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5h3v14H8zm5 0h3v14h-3z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    playbackToggle.innerHTML = iconMarkup;
  }

  function seekTo(timestamp) {
    currentTimeError.textContent = '';
    isEditingCurrentTime = false;
    setPlayback(playback.status, timestamp);
    emitVideoAction('seek', timestamp);
  }

  function submitCurrentTime(value = currentTimeInput.value) {
    const timestamp = CouchShared.parseTimestamp(value);
    if (timestamp === null) {
      currentTimeError.textContent = 'Enter a time in M:SS or H:MM:SS format.';
      return;
    }

    seekTo(timestamp);
    currentTimeInput.blur();
  }

  function updateButtons() {
    const connected = socket.connected;
    const hasUsername = usernameInput.value.trim().length > 0;
    createRoomButton.disabled = !connected || !hasUsername;
    joinRoomButton.disabled = !connected || !hasUsername || !joinRoomInput.value.trim();
    chatInput.disabled = !connected || !isRoomJoined || currentRoom === null;
    const canControl = connected && isRoomJoined && currentRoom !== null;
    for (const button of seekButtons.querySelectorAll('button')) {
      button.disabled = !canControl;
    }
    currentTimeInput.disabled = !canControl;
    playbackToggle.disabled = !canControl;
    syncPlaybackButton.disabled = !canControl || isSyncingPlayback;
    timestampButton.disabled = !canControl;
    controllerHint.hidden = canControl;
    controllerHint.textContent = connected
      ? 'Join a room to control playback.'
      : 'Connect to Couch and join a room to control playback.';
    volumeSlider.disabled = !connected || !isRoomJoined || currentRoom === null || !hasRemoteVideo;
    for (const button of volumePresets.querySelectorAll('button')) {
      button.disabled = volumeSlider.disabled;
    }
    if (!connected || !isRoomJoined || currentRoom === null) {
      volumeStatus.textContent = 'Join a room with the same username as Couch on your video to adjust its volume.';
    } else if (!hasReceivedVolumeState) {
      volumeStatus.textContent = 'Waiting for Couch to find a video using the same username.';
    } else if (!hasRemoteVideo) {
      volumeStatus.textContent = 'No video found in Couch. Open a video using the same username.';
    }
  }

  function applyTheme(nextTheme) {
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('couch_remote_theme', nextTheme);
    themeColor.content = nextTheme === 'light' ? '#f3f5f7' : '#090909';
    const nextLabel = nextTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.textContent = nextTheme === 'dark' ? 'Light mode' : 'Dark mode';
    themeToggle.setAttribute('aria-label', nextLabel);
  }

  function appendTextWithHighlightedUsernames(element, text, usernames) {
    element.replaceChildren();
    const alternatives = [...new Set(usernames.filter(roomUsername => (
      typeof roomUsername === 'string' && roomUsername
    )))]
      .sort((first, second) => second.length - first.length)
      .map(roomUsername => roomUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (alternatives.length === 0) {
      element.textContent = text;
      return;
    }

    const matcher = new RegExp(
      `(^|[^\\p{L}\\p{N}_])(${alternatives.join('|')})(?=$|[^\\p{L}\\p{N}_])`,
      'gu'
    );
    let cursor = 0;
    for (const match of text.matchAll(matcher)) {
      const usernameIndex = match.index + match[1].length;
      element.append(document.createTextNode(text.slice(cursor, usernameIndex)));
      const username = document.createElement('span');
      username.className = 'system-username';
      username.textContent = match[2];
      element.append(username);
      cursor = usernameIndex + match[2].length;
    }
    element.append(document.createTextNode(text.slice(cursor)));
  }

  function createPlaybackSyncControl(username, isCompact = false) {
    const control = document.createElement('span');
    control.className = 'playback-sync-control';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'playback-sync-button';
    button.dataset.playbackSyncTarget = username;
    button.textContent = isCompact ? 'Sync' : `Sync everyone to ${username}`;
    button.setAttribute('aria-label', `Sync everyone to ${username}`);
    button.title = `Sync everyone to ${username}`;
    control.append(button);

    const feedback = document.createElement('span');
    feedback.className = 'playback-sync-feedback';
    feedback.setAttribute('role', 'status');
    control.append(feedback);
    return control;
  }

  function addMessage(message) {
    const row = document.createElement('li');
    row.className = 'message-row';
    row.dataset.messageTime = String(Number.isFinite(message.time) ? message.time : Date.now());
    const messageId = CouchShared.getMessageId(message);
    row.dataset.messageId = messageId;
    if (typeof message.id === 'string' && message.id) {
      row.dataset.serverMessageId = message.id;
    }
    row.dataset.messageSender = message.sender === 'You' ? username : message.sender;
    row.dataset.messageText = message.text;
    const isSystem = message.sender === 'System';
    const isOwnMessage = message.sender === 'You' || message.sender === username;
    row.classList.add(isSystem ? 'system' : isOwnMessage ? 'right' : 'left');
    if (message.syncTargetUsername) row.classList.add('has-playback-sync');

    const content = document.createElement('span');
    content.className = 'message-content';
    const messageDate = new Date(message.time);
    if (Number.isFinite(messageDate.getTime())) {
      content.title = messageDate.toLocaleString();
      row.dataset.messageTimestampTitle = content.title;
    }
    if (message.replyTo) {
      const quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'message-reply-quote';
      quote.dataset.replyTargetId = message.replyTo.id;
      quote.setAttribute('aria-label', `Jump to ${message.replyTo.sender}'s message`);
      const quoteSender = document.createElement('span');
      quoteSender.className = 'message-reply-quote-sender';
      quoteSender.textContent = message.replyTo.sender;
      const quoteText = document.createElement('span');
      quoteText.className = 'message-reply-quote-text';
      quoteText.textContent = message.replyTo.text;
      quote.append(quoteSender, quoteText);
      content.append(quote);
    }
    if (isSystem) {
      if (message.type === 'playback-position-announcement' && Array.isArray(message.participants)) {
        content.classList.add('playback-announcement');
        content.replaceChildren();
        const heading = document.createElement('span');
        heading.className = 'playback-announcement-heading';
        heading.textContent = message.heading || 'Status check every 5 mins';
        content.append(heading);

        const participantList = document.createElement('span');
        participantList.className = 'playback-announcement-participants';
        for (const participant of message.participants) {
          const participantName = document.createElement('span');
          participantName.className = 'playback-announcement-name';
          appendTextWithHighlightedUsernames(
            participantName,
            `${participant.username}${participant.isHost ? ' (host)' : ''}`,
            [participant.username]
          );
          const participantPosition = document.createElement('span');
          participantPosition.className = 'playback-announcement-position';
          participantPosition.textContent = `⏱️ ${participant.position}`;
          participantList.append(participantName, participantPosition);
        }
        content.append(participantList);
        if (typeof message.syncTargetUsername === 'string' && message.syncTargetUsername) {
          content.append(createPlaybackSyncControl(message.syncTargetUsername));
        }
      } else {
        appendTextWithHighlightedUsernames(content, message.text, message.highlightedUsernames || []);
      }
      row.append(content);
    } else {
      if (!isOwnMessage) {
        const senderLabel = document.createElement('span');
        senderLabel.className = 'sender-label';
        const senderName = document.createElement('b');
        senderName.textContent = message.sender;
        senderLabel.append(senderName);
        if (message.sender === currentHost) {
          const hostLabel = document.createElement('b');
          hostLabel.textContent = ' (host)';
          senderLabel.append(document.createTextNode(' '), hostLabel);
        }
        row.append(senderLabel);
      }
      const messageText = document.createElement('span');
      messageText.className = 'message-text';
      messageText.textContent = message.text;
      if (CouchShared.isSingleEmoji(message.text)) {
        if (message.replyTo) messageText.classList.add('emoji-only');
        else content.classList.add('emoji-only');
      }
      content.append(messageText);
      row.append(content);
    }

    if (!isSystem) {
      if (isOwnMessage) {
        renderMessageSeenIndicator(row, message.seenBy, !message.deliveryPending);
      }
      const replyButton = document.createElement('button');
      replyButton.type = 'button';
      replyButton.className = 'message-reply-button';
      replyButton.dataset.replyMessageId = messageId;
      replyButton.textContent = 'Reply';
      replyButton.setAttribute('aria-label', `Reply to ${message.sender}`);
      replyButton.title = `Reply to ${message.sender}`;
      row.append(replyButton);
    }

    messageList.append(row);
    messageSeenObserver.observe(row);
    while (messageList.children.length > 100) messageList.firstElementChild.remove();
    messageList.scrollTop = messageList.scrollHeight;
    const compact = document.createElement('div');
    compact.className = 'compact-message';
    compact.textContent = `${message.sender}: ${message.text}`;
    if (message.type === 'playback-position-announcement' && message.syncTargetUsername) {
      compact.append(createPlaybackSyncControl(message.syncTargetUsername, true));
    }
    compactMessages.append(compact);
    while (compactMessages.children.length > 2) compactMessages.firstElementChild.remove();
  }

  function updateViewToggle() {
    const label = isCompactView ? 'Expand' : 'Collapse';
    CouchShared.setArrowIcon(viewToggleButton, isCompactView ? 'down' : 'up');
    viewToggleButton.title = `${label} Couch`;
    viewToggleButton.setAttribute('aria-label', `${label} Couch`);
  }

  function showFullView() {
    isCompactView = false;
    updateViewToggle();
    hostContainer.style.display = 'block';
    compactView.classList.add('remote-hidden');
    lobby.classList.toggle('remote-expanded', currentRoom === null);
    lobby.classList.toggle('remote-hidden', currentRoom !== null);
    chatContainer.classList.toggle('remote-expanded', currentRoom !== null);
    chatContainer.classList.toggle('remote-hidden', currentRoom === null);
    if (currentRoom) {
      scheduleVisibleMessageSeenScan();
      requestAnimationFrame(() => chatInput.focus());
    }
  }

  function showCompactView() {
    isCompactView = true;
    updateViewToggle();
    hostContainer.style.display = 'block';
    lobby.classList.remove('remote-expanded');
    lobby.classList.add('remote-hidden');
    chatContainer.classList.remove('remote-expanded');
    chatContainer.classList.add('remote-hidden');
    compactView.classList.remove('remote-hidden');
  }

  function showRoom(roomId) {
    currentRoom = roomId;
    isRoomJoined = true;
    joiningRoomId = null;
    renderTypingIndicator([]);
    chatHistoryClearedAt = Number(localStorage.getItem(`couch_chat_cleared_${roomId}`)) || 0;
    persistSession();
    displayRoomId.textContent = roomId;
    lobby.classList.remove('remote-expanded');
    lobby.classList.add('remote-hidden');
    chatContainer.classList.add('remote-expanded');
    chatContainer.classList.remove('remote-hidden');
    updateButtons();
    showFullView();
  }

  function showLobby() {
    const timestamp = currentTimestamp();
    playbackSyncRequestId += 1;
    isSyncingPlayback = false;
    isRoomJoined = false;
    currentRoom = null;
    setReplyTarget(null, false);
    currentHost = null;
    joiningRoomId = null;
    hasRemoteVideo = false;
    setPlayback('paused', timestamp);
    persistSession();
    messageList.replaceChildren();
    compactMessages.replaceChildren();
    roomUsersList.replaceChildren();
    renderRoomUsers([], null);
    renderTypingIndicator([]);
    roomUsersPanel.hidden = true;
    roomUsersToggle.setAttribute('aria-expanded', 'false');
    displayRoomId.textContent = '...';
    lobby.classList.remove('remote-hidden');
    lobby.classList.add('remote-expanded');
    chatContainer.classList.add('remote-hidden');
    chatContainer.classList.remove('remote-expanded');
    showFullView();
    updateButtons();
  }

  function submitRoomRequest(roomId, action) {
    username = usernameInput.value.trim();
    if (!username || !socket.connected) return;
    hasRemoteVideo = false;
    hasReceivedVolumeState = false;
    joiningRoomId = roomId;
    chatHistoryClearedAt = Number(localStorage.getItem(`couch_chat_cleared_${roomId}`)) || 0;
    updateButtons();
    localStorage.setItem('couch_username', username);
    joinError.textContent = '';
    roomLoading.textContent = 'Connecting...';
    createRoomButton.disabled = true;
    joinRoomButton.disabled = true;
    socket.timeout(10000).emit('join-room', { roomId, username, action, clientType: 'remote' }, (error, result) => {
      updateButtons();
      if (error) {
        joiningRoomId = null;
        joinError.textContent = 'The server did not respond. Please try again.';
        return;
      }
      if (!result?.success) {
        joiningRoomId = null;
        joinError.textContent = result?.message || 'Could not join this room.';
        return;
      }
      currentHost = result.host || currentHost;
      showRoom(roomId);
    });
  }

  function sendChat(text) {
    const message = text.trim();
    if (!message || !currentRoom || !isRoomJoined || !socket.connected) return;
    const seekTimestamp = CouchShared.parseSeekCommand(message);
    if (seekTimestamp !== null) {
      seekTo(seekTimestamp);
      return;
    }

    if (CouchShared.containsPauseTrigger(message)) {
      const timestamp = currentTimestamp();
      setPlayback('paused', timestamp);
      emitVideoAction('pause', timestamp);
    }

    const messageId = crypto.randomUUID();
    const messageReplyTo = replyTarget;
    addMessage({
      id: messageId,
      sender: 'You',
      text: message,
      time: Date.now(),
      deliveryPending: true,
      replyTo: messageReplyTo
    });
    socket.timeout(6000).emit('send-message', {
      roomId: currentRoom,
      username,
      text: message,
      messageId,
      replyTo: messageReplyTo
    }, (error, result) => {
      if (error || !result?.success) {
        console.error('Could not confirm message delivery:', error || result?.message);
        return;
      }
      const row = [...messageList.children].find((item) => item.dataset.messageId === messageId);
      if (row) renderMessageSeenIndicator(row, messageSeenBy.get(row), true);
    });
    setReplyTarget(null, false);
  }

  function clearOwnChatHistory() {
    if (!currentRoom) return;
    setReplyTarget(null, false);
    const latestMessageTime = [...messageList.children].reduce((latest, message) => {
      const time = Number(message.dataset.messageTime);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, chatHistoryClearedAt);
    chatHistoryClearedAt = latestMessageTime;
    localStorage.setItem(`couch_chat_cleared_${currentRoom}`, String(chatHistoryClearedAt));
    messageList.replaceChildren();
    compactMessages.replaceChildren();
  }

  let localTypingState = false;

  function renderTypingIndicator(users) {
    const names = [...new Set((users || []).filter(Boolean).filter(name => name !== username))];
    const main = typingIndicator.closest('main');
    if (names.length === 0) {
      typingIndicator.hidden = true;
      typingIndicator.replaceChildren();
      main?.classList.remove('has-typing-indicator');
      return;
    }

    const fragment = document.createDocumentFragment();
    const nameText = names.length === 1 ? names[0] : names.slice(0, 2).join(', ');
    const actionText = names.length === 1 ? ' is typing...' : ' are typing...';

    const nameNode = document.createElement('span');
    nameNode.className = 'typing-username';
    nameNode.textContent = nameText;

    const textNode = document.createElement('span');
    textNode.className = 'typing-text';
    textNode.textContent = actionText;

    fragment.append(nameNode, textNode);
    typingIndicator.hidden = false;
    typingIndicator.replaceChildren(fragment);
    main?.classList.add('has-typing-indicator');

    requestAnimationFrame(() => {
      if (messageList.scrollHeight > messageList.clientHeight) {
        messageList.scrollTop = messageList.scrollHeight;
      }
    });
  }

  function renderRoomUsers(users, host) {
    roomUsersList.replaceChildren();
    const uniqueUsers = [...new Set(users)];
    roomUsersCount.textContent = `(${uniqueUsers.length})`;
    roomUsersToggle.title = `Users (${uniqueUsers.length})`;
    roomUsersToggle.setAttribute('aria-label', `Users (${uniqueUsers.length})`);
    for (const roomUsername of uniqueUsers) {
      const item = document.createElement('li');
      item.textContent = roomUsername === host ? `${roomUsername} (host)` : roomUsername;
      roomUsersList.append(item);
    }
  }

  function isVisibleAfterChatClear(message) {
    return chatHistoryClearedAt === 0
      || (Number.isFinite(message.time) && message.time > chatHistoryClearedAt);
  }

  function setVolume(volume) {
    volumeSlider.value = String(volume);
    const selectedVolume = Number(volumeSlider.value);
    volumeValue.value = `${Math.round(selectedVolume * 100)}%`;
    for (const button of volumePresets.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === selectedVolume));
    }
    volumeStatus.textContent = 'Applying volume...';
    socket.emit('set-video-volume', { roomId: currentRoom, volume: selectedVolume }, (result) => {
      if (!result?.success) {
        hasRemoteVideo = false;
        hasReceivedVolumeState = true;
        volumeStatus.textContent = 'No matching video is connected. Open a video in Couch using the same username.';
        updateButtons();
      } else {
        volumeStatus.textContent = 'Volume applies only to your video.';
      }
    });
  }

  function setConnection(message, state) {
    status.textContent = message;
    status.dataset.state = state;
  }

  viewToggleButton.addEventListener('click', () => isCompactView ? showFullView() : showCompactView());
  compactView.addEventListener('click', showFullView);
  clearChatButton.addEventListener('click', clearOwnChatHistory);
  roomUsersToggle.addEventListener('click', () => {
    roomUsersPanel.hidden = !roomUsersPanel.hidden;
    roomUsersToggle.setAttribute('aria-expanded', String(!roomUsersPanel.hidden));
  });

  usernameInput.addEventListener('input', updateButtons);
  usernameInput.addEventListener('change', () => {
    const enteredUsername = usernameInput.value.trim();
    if (!enteredUsername) return;
    username = enteredUsername;
    localStorage.setItem('couch_username', username);
  });
  joinRoomInput.addEventListener('input', updateButtons);
  function submitRoomFromInputs() {
    if (!usernameInput.value.trim()) return;

    const roomCode = joinRoomInput.value.trim().toLowerCase();
    if (roomCode) {
      submitRoomRequest(roomCode, 'join');
    } else {
      submitRoomRequest(Math.random().toString(36).substring(2, 8), 'create');
    }
  }
  function handleRoomInputEnter(event) {
    if (event.key !== 'Enter') return;

    event.preventDefault();
    submitRoomFromInputs();
  }
  usernameInput.addEventListener('keydown', handleRoomInputEnter);
  joinRoomInput.addEventListener('keydown', handleRoomInputEnter);
  createRoomButton.addEventListener('click', () => {
    if (!createRoomButton.disabled) {
      submitRoomRequest(Math.random().toString(36).substring(2, 8), 'create');
    }
  });
  joinRoomForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const roomCode = joinRoomInput.value.trim().toLowerCase();
    if (roomCode) submitRoomRequest(roomCode, 'join');
  });
  leaveRoomButton.addEventListener('click', () => {
    if (currentRoom) socket.emit('leave-room', { roomId: currentRoom, username });
    showLobby();
  });
  displayRoomId.addEventListener('click', async () => {
    if (!currentRoom) return;
    try {
      await navigator.clipboard.writeText(currentRoom);
      displayRoomId.dataset.copyState = 'copied';
      setTimeout(() => delete displayRoomId.dataset.copyState, 2000);
    } catch (error) {
      console.error('Could not copy room code:', error);
      displayRoomId.dataset.copyState = 'error';
      setTimeout(() => delete displayRoomId.dataset.copyState, 2000);
    }
  });
  shareRoomButton.addEventListener('click', async () => {
    if (!currentRoom) return;
    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.set('roomCode', currentRoom);
    try {
      await navigator.clipboard.writeText(inviteUrl.toString());
      shareRoomButton.dataset.copyState = 'copied';
      setTimeout(() => delete shareRoomButton.dataset.copyState, 2000);
    } catch (error) {
      console.error('Could not copy room invite link:', error);
      shareRoomButton.dataset.copyState = 'error';
      setTimeout(() => delete shareRoomButton.dataset.copyState, 2000);
    }
  });
  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    localTypingState = false;
    socket.emit('typing', { roomId: currentRoom, username, isTyping: false });
    sendChat(chatInput.value);
    chatInput.value = '';
  });
  chatInput.addEventListener('input', () => {
    if (!currentRoom || !socket.connected) return;
    const nextTypingState = chatInput.value.trim().length > 0;
    if (localTypingState === nextTypingState) return;
    localTypingState = nextTypingState;
    socket.emit('typing', { roomId: currentRoom, username, isTyping: nextTypingState });
  });
  chatInput.addEventListener('blur', () => {
    if (!currentRoom || !localTypingState) return;
    localTypingState = false;
    socket.emit('typing', { roomId: currentRoom, username, isTyping: false });
  });
  emojiBar.addEventListener('click', (event) => {
    const button = event.target.closest('.emoji-btn');
    if (button && button !== timestampButton) sendChat(button.textContent);
  });
  timestampButton.addEventListener('click', () => {
    if (!currentRoom || !isRoomJoined || !socket.connected) return;
    const roomId = currentRoom;
    syncPlaybackStatus.textContent = 'Checking playback times…';
    socket.timeout(6000).emit('check-room-playback', { roomId }, (error, result) => {
      if (roomId !== currentRoom) return;
      showSyncToast(error
        ? 'Could not check playback times. Please try again.'
        : result?.success
          ? 'Playback times announced in chat.'
          : result?.message || 'Could not check playback times. Please try again.');
    });
  });
  function handlePlaybackSyncClick(event) {
    const button = event.target.closest('button[data-playback-sync-target]');
    if (!button || button.disabled || !currentRoom || !isRoomJoined || !socket.connected) return;

    const roomId = currentRoom;
    button.disabled = true;
    const feedback = button.parentElement.querySelector('.playback-sync-feedback');
    feedback.textContent = 'Syncing…';
    socket.timeout(6000).emit('sync-room-playback-to-user', {
      roomId,
      username: button.dataset.playbackSyncTarget
    }, (error, result) => {
      if (roomId !== currentRoom || !button.isConnected) return;
      if (error || !result?.success) {
        button.disabled = false;
        feedback.textContent = error
          ? 'Sync request timed out. Please try again.'
          : result?.message || 'Could not sync playback. Please try again.';
        return;
      }

      button.textContent = 'Synced';
      button.setAttribute('aria-label', `Playback synced to ${button.dataset.playbackSyncTarget}`);
      feedback.textContent = '';
    });
  }
  messageList.addEventListener('click', handlePlaybackSyncClick);
  messageList.addEventListener('click', (event) => {
    const replyButton = event.target.closest('button[data-reply-message-id]');
    if (replyButton) {
      const row = replyButton.closest('.message-row');
      if (!row) return;
      setReplyTarget({
        id: row.dataset.messageId,
        sender: row.dataset.messageSender,
        text: row.dataset.messageText
      });
      return;
    }

    const quote = event.target.closest('button[data-reply-target-id]');
    if (!quote) return;
    const originalMessage = [...messageList.children].find(
      (row) => row.dataset.messageId === quote.dataset.replyTargetId
    );
    if (!originalMessage) return;
    originalMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
    originalMessage.classList.add('is-reply-target');
    setTimeout(() => originalMessage.classList.remove('is-reply-target'), 1200);
  });
  replyCancelButton.addEventListener('click', () => setReplyTarget(null));
  compactMessages.addEventListener('click', handlePlaybackSyncClick);
  themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  playbackToggle.addEventListener('click', () => {
    const timestamp = currentTimestamp();
    const nextStatus = playback.status === 'playing' ? 'paused' : 'playing';
    setPlayback(nextStatus, timestamp);
    emitVideoAction(nextStatus === 'playing' ? 'play' : 'pause', timestamp);
  });
  function requestPlaybackSync() {
    if (!currentRoom || !isRoomJoined || !socket.connected || isSyncingPlayback) return;

    const roomId = currentRoom;
    const requestId = ++playbackSyncRequestId;
    isSyncingPlayback = true;
    showSyncToast('Requesting current video time from the extension…', 1800);
    updateButtons();
    socket.timeout(6000).emit('request-playback-state', { roomId }, (error, result) => {
      if (requestId !== playbackSyncRequestId || roomId !== currentRoom) return;

      isSyncingPlayback = false;
      updateButtons();

      if (error) {
        showSyncToast('The extension did not respond. Make sure Couch is open and try again.');
        return;
      }
      if (!result?.success) {
        showSyncToast(result?.message || 'Could not sync from the extension.');
        return;
      }

      setPlayback(result.state.status, result.state.timestamp);
      const stateLabel = result.state.status === 'playing' ? 'playing' : 'paused';
      showSyncToast(`Synced to ${formatTime(result.state.timestamp)} (${stateLabel}).`);
    });
  }
  syncPlaybackButton.addEventListener('click', requestPlaybackSync);
  volumeSlider.addEventListener('input', () => setVolume(Number(volumeSlider.value)));
  volumePresets.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-volume]');
    if (button && !button.disabled) setVolume(Number(button.dataset.volume));
  });
  resetTimeButton.addEventListener('click', () => seekTo(0));
  seekButtons.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-seek-offset]');
    if (!button || button.disabled) return;
    const timestamp = Math.max(0, currentTimestamp() + Number(button.dataset.seekOffset));
    seekTo(timestamp);
  });
  currentTimeInput.addEventListener('focus', () => {
    isEditingCurrentTime = true;
    currentTimeInput.value = formatTime(currentTimestamp());
    currentTimeInput.select();
  });
  currentTimeInput.addEventListener('input', () => {
    applyTimeFormatting(currentTimeInput);
    currentTimeError.textContent = '';
  });
  currentTimeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitCurrentTime();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      isEditingCurrentTime = false;
      currentTimeError.textContent = '';
      renderTimeline();
      currentTimeInput.blur();
    }
  });
  currentTimeInput.addEventListener('blur', () => {
    if (!isEditingCurrentTime) return;
    isEditingCurrentTime = false;
    currentTimeError.textContent = '';
    renderTimeline();
  });

  socket.on('connect', () => {
    seenReceiptsSent.clear();
    setConnection('Connected to Couch', 'connected');
    updateButtons();
    maybeAutoJoinFromUrl();
    if (currentRoom) {
      const roomId = currentRoom;
      if (!username) {
        joinRoomInput.value = roomId;
        joinError.textContent = 'Enter your username to reconnect to the saved room.';
        showLobby();
        return;
      }
      joiningRoomId = roomId;
      chatHistoryClearedAt = Number(localStorage.getItem(`couch_chat_cleared_${roomId}`)) || 0;
      socket.timeout(10000).emit('join-room', { roomId, username, action: 'join', clientType: 'remote' }, (error, result) => {
        if (error || !result?.success) {
          joiningRoomId = null;
          joinRoomInput.value = roomId;
          joinError.textContent = error
            ? 'The server did not respond while reconnecting. Please try again.'
            : result?.message || 'Could not reconnect to the room.';
          showLobby();
          return;
        }
        currentHost = result.host || currentHost;
        showRoom(roomId);
      });
    }
  });
  socket.on('disconnect', () => {
    seenReceiptsSent.clear();
    const timestamp = currentTimestamp();
    playbackSyncRequestId += 1;
    isSyncingPlayback = false;
    isRoomJoined = false;
    hasRemoteVideo = false;
    hasReceivedVolumeState = false;
    setPlayback('paused', timestamp);
    setConnection('Disconnected — reconnecting...', 'offline');
    updateButtons();
  });
  socket.on('connect_error', () => {
    setConnection('Could not connect to Couch', 'offline');
    updateButtons();
  });
  socket.on('sync-room', (state) => {
    if (socket.connected && (joiningRoomId || currentRoom)) {
      isRoomJoined = true;
    }
    currentHost = state.host || currentHost;
    const roomUsernames = [...new Set((state.users || []).map(user => user.username))];
    roomUsernames.sort((first, second) => (
      first === currentHost ? -1 : second === currentHost ? 1 : 0
    ));
    renderRoomUsers(roomUsernames, currentHost);
    if (state.video) {
      const serverActionAt = Number(state.video.updatedAt);
      const shouldUseServer = !hasRestoredPlayback
        || (Number.isFinite(serverActionAt) && serverActionAt > lastPlaybackEventAt);
      if (shouldUseServer) {
        setPlayback(state.video.status, state.video.timestamp, serverActionAt);
      }
    }
    hasRestoredPlayback = false;
    messageList.replaceChildren();
    compactMessages.replaceChildren();
    const roomId = joiningRoomId || currentRoom;
    if (roomId) {
      chatHistoryClearedAt = Number(localStorage.getItem(`couch_chat_cleared_${roomId}`)) || 0;
    }
    for (const message of state.chatHistory || []) {
      if (isVisibleAfterChatClear(message)) addMessage(message);
    }
    scheduleVisibleMessageSeenScan();
  });
  socket.on('room-typing', ({ users = [] }) => {
    renderTypingIndicator(users);
  });
  socket.on('new-message', (message) => {
    if (isVisibleAfterChatClear(message)) addMessage(message);
  });
  socket.on('message-seen', ({ roomId, messageId, username: seenByUsername }) => {
    if (roomId !== currentRoom) return;
    const row = [...messageList.children].find((item) => (
      item.dataset.messageId === messageId
      && item.dataset.messageSender === username
    ));
    if (!row) return;
    const seenBy = messageSeenBy.get(row) || [];
    if (!seenBy.includes(seenByUsername)) {
      renderMessageSeenIndicator(row, [...seenBy, seenByUsername]);
    }
  });
  socket.on('play-video', ({ timestamp, updatedAt }) => setPlayback('playing', timestamp, updatedAt));
  socket.on('pause-video', ({ timestamp, updatedAt }) => setPlayback('paused', timestamp, updatedAt));
  socket.on('seek-video', ({ timestamp, updatedAt }) => setPlayback(playback.status, timestamp, updatedAt));
  socket.on('sync-playback-state', ({ roomId, status, timestamp, updatedAt }) => {
    if (
      (roomId !== currentRoom && roomId !== joiningRoomId)
      || !['playing', 'paused'].includes(status)
      || !Number.isFinite(timestamp)
      || timestamp < 0
    ) {
      return;
    }
    setPlayback(status, timestamp, updatedAt);
  });
  socket.on('update-host', ({ newHost }) => { currentHost = newHost; });
  socket.on('room-users', ({ users, host }) => {
    currentHost = host;
    renderRoomUsers(users, host);
  });
  socket.on('video-volume-state', ({ available, volume }) => {
    hasReceivedVolumeState = true;
    hasRemoteVideo = available === true && Number.isFinite(volume);
    if (hasRemoteVideo) {
      volumeSlider.value = String(Math.min(1, Math.max(0, volume)));
      volumeValue.value = `${Math.round(Number(volumeSlider.value) * 100)}%`;
      for (const button of volumePresets.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === Number(volumeSlider.value)));
      }
      volumeStatus.textContent = 'Volume applies only to your video.';
    } else {
      volumeStatus.textContent = 'No video found in Couch. Open a video using the same username.';
    }
    updateButtons();
  });

  updateViewToggle();
  showCompactView();
  setInterval(renderTimeline, 250);
  setInterval(persistSession, 1000);
  window.addEventListener('pagehide', persistSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSession();
    else scheduleVisibleMessageSeenScan();
  });
  updateButtons();
}

initializeRemote().catch((error) => {
  console.error('Couch Remote failed to initialize:', error);
  const status = document.getElementById('connection-status');
  status.textContent = 'Could not load Couch panel';
  status.dataset.state = 'offline';
});

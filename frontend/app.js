const API_URL = 'https://couch-sl1x.onrender.com';
// const API_URL = 'http://localhost:3000';
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
    <link rel="stylesheet" href="panel.css">
    <link rel="stylesheet" href="remote-panel.css">
    ${panelMarkup.replaceAll('__COUCH_LOGO_URL__', 'assets/couch.svg')}
  `;

  const socket = io(API_URL);
  const status = document.getElementById('connection-status');
  const compactView = shadow.getElementById('compact-view');
  const compactMessages = shadow.getElementById('compact-messages');
  const chatResizeHandle = shadow.getElementById('chat-resize-handle');
  const viewToggleButton = shadow.getElementById('view-toggle-btn');
  const chatContainer = shadow.getElementById('chat-container');
  const lobby = shadow.getElementById('lobby');
  const createRoomForm = shadow.getElementById('create-room-form');
  const usernameInput = shadow.getElementById('username-input');
  const createRoomButton = shadow.getElementById('create-room-btn');
  const joinRoomForm = shadow.getElementById('join-room-form');
  const joinRoomInput = shadow.getElementById('join-room-input');
  const joinRoomButton = shadow.getElementById('join-room-btn');
  const joinError = shadow.getElementById('join-error');
  const roomLoading = shadow.getElementById('room-loading-message');
  const displayRoomId = shadow.getElementById('display-room-id');
  const clearChatButton = shadow.getElementById('clear-chat-btn');
  const leaveRoomButton = shadow.getElementById('leave-room-btn');
  const messageList = shadow.getElementById('messages');
  const chatForm = shadow.getElementById('chat-form');
  const chatInput = shadow.getElementById('chat-input');
  const emojiBar = shadow.getElementById('emoji-bar');
  const timestampButton = shadow.getElementById('timestamp-btn');
  const durationForm = document.getElementById('remote-duration-form');
  const durationInput = document.getElementById('remote-duration');
  const durationError = document.getElementById('remote-duration-error');
  const themeToggle = document.getElementById('theme-toggle');
  const controller = document.getElementById('remote-controller');
  const controllerHint = document.getElementById('controller-hint');
  const seekSlider = document.getElementById('remote-seek');
  const currentTimeInput = document.getElementById('remote-current-time');
  const currentTimeError = document.getElementById('remote-current-time-error');
  const playbackStatusLabel = document.getElementById('remote-playback-status');
  const totalDurationLabel = document.getElementById('remote-total-duration');
  const playbackToggle = document.getElementById('remote-toggle-playback');
  const volumeSlider = document.getElementById('remote-volume');
  const volumeValue = document.getElementById('remote-volume-value');
  const volumePresets = document.getElementById('remote-volume-presets');
  const volumeStatus = document.getElementById('remote-volume-status');
  const themeColor = document.querySelector('meta[name="theme-color"]');

  let username = localStorage.getItem('couch_username') || '';
  let currentRoom = null;
  let isRoomJoined = false;
  let currentHost = null;
  let durationSeconds = 0;
  let playback = { status: 'paused', timestamp: 0, updatedAt: Date.now() };
  let lastPlaybackEventAt = playback.updatedAt;
  let hasRestoredPlayback = false;
  let isSeeking = false;
  let isEditingCurrentTime = false;
  let isCompactView = false;
  let hasRemoteVideo = false;
  let hasReceivedVolumeState = false;
  let chatHistoryClearedAt = 0;
  let joiningRoomId = null;

  const chatResizer = CouchShared.createChatResizer(chatResizeHandle, hostContainer, {
    initialHeight: 180,
    onCommit: (height) => localStorage.setItem('couch_remote_chat_height', String(height))
  });
  const savedChatHeight = Number(localStorage.getItem('couch_remote_chat_height'));
  if (Number.isFinite(savedChatHeight) && savedChatHeight > 0) {
    chatResizer.setHeight(savedChatHeight);
  }

  usernameInput.value = username;
  durationInput.value = localStorage.getItem('couch_remote_duration') || '';
  timestampButton.title = 'Share current playback timestamp';
  applyTheme(theme);

  function parseDuration(value, { allowZero = false } = {}) {
    const parts = value.trim().split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
    const numbers = parts.map(Number);
    const seconds = numbers.at(-1);
    const minutes = numbers.at(-2);
    if (seconds > 59 || (parts.length === 3 && minutes > 59)) return null;

    const total = parts.length === 3
      ? numbers[0] * 3600 + minutes * 60 + seconds
      : minutes * 60 + seconds;
    return Number.isSafeInteger(total) && (allowZero ? total >= 0 : total > 0) ? total : null;
  }

  function formatDurationDigits(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, -2)}:${digits.slice(-2)}`;
    return `${digits.slice(0, -4)}:${digits.slice(-4, -2)}:${digits.slice(-2)}`;
  }

  function applyDurationFormatting(input) {
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, '').length;
    const formatted = formatDurationDigits(input.value);
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
      const savedDuration = typeof savedSession.duration === 'string'
        ? savedSession.duration
        : durationInput.value;
      const savedDurationSeconds = parseDuration(savedDuration);
      const isValidSession = savedSession
        && typeof savedSession === 'object'
        && (savedSession.roomId === null || typeof savedSession.roomId === 'string')
        && ['playing', 'paused'].includes(savedSession.status)
        && Number.isFinite(savedSession.timestamp)
        && savedSession.timestamp >= 0
        && Number.isFinite(savedSession.savedAt)
        && Number.isFinite(savedSession.actionAt);

      if (!isValidSession) {
        console.warn('Saved Couch Remote session data is invalid; starting with the saved duration only.');
      } else {
        durationInput.value = savedDuration;
        durationSeconds = savedDurationSeconds || 0;
        const now = Date.now();
        const elapsed = savedSession.status === 'playing' ? (now - savedSession.savedAt) / 1000 : 0;
        const restoredTimestamp = Math.max(0, savedSession.timestamp + elapsed);
        const reachedEnd = durationSeconds > 0 && restoredTimestamp >= durationSeconds;
        playback = {
          status: reachedEnd ? 'paused' : savedSession.status,
          timestamp: durationSeconds ? Math.min(restoredTimestamp, durationSeconds) : restoredTimestamp,
          updatedAt: now
        };
        lastPlaybackEventAt = savedSession.actionAt;
        hasRestoredPlayback = true;
        currentRoom = savedSession.roomId;
        if (currentRoom) joinRoomInput.value = currentRoom;
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
    return Math.min(durationSeconds || Number.MAX_SAFE_INTEGER, Math.max(0, playback.timestamp + elapsed));
  }

  function persistSession() {
    const timestamp = currentTimestamp();
    localStorage.setItem('couch_remote_session', JSON.stringify({
      roomId: currentRoom,
      duration: durationInput.value,
      status: playback.status,
      timestamp,
      savedAt: Date.now(),
      actionAt: lastPlaybackEventAt
    }));
  }

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
    if (!durationSeconds) return;
    const timestamp = currentTimestamp();
    if (!isEditingCurrentTime && !isSeeking) currentTimeInput.value = formatTime(timestamp);
    const isPlaying = isRoomJoined && playback.status === 'playing';
    playbackStatusLabel.textContent = isPlaying ? 'Playing' : 'Paused';
    totalDurationLabel.textContent = formatTime(durationSeconds);
    playbackToggle.textContent = isPlaying ? 'Pause' : 'Play';
    playbackToggle.classList.toggle('is-secondary', isPlaying);
    playbackToggle.setAttribute('aria-label', isPlaying ? 'Pause playback' : 'Start playback');
    if (!isSeeking) seekSlider.value = String(Math.min(timestamp, durationSeconds));
    if (timestamp >= durationSeconds && isPlaying) {
      setPlayback('paused', durationSeconds);
      emitVideoAction('pause', durationSeconds);
    }
  }

  function updateButtons() {
    const connected = socket.connected;
    const hasUsername = usernameInput.value.trim().length > 0;
    createRoomButton.disabled = !connected || !hasUsername;
    joinRoomButton.disabled = !connected || !hasUsername || !joinRoomInput.value.trim();
    chatInput.disabled = !connected || !isRoomJoined || currentRoom === null;
    const canControl = connected && isRoomJoined && currentRoom !== null && durationSeconds > 0;
    seekSlider.disabled = !canControl;
    currentTimeInput.disabled = !canControl;
    playbackToggle.disabled = !canControl;
    timestampButton.disabled = !canControl;
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

  function addMessage(message) {
    const row = document.createElement('li');
    row.className = 'message-row';
    row.dataset.messageTime = String(Number.isFinite(message.time) ? message.time : Date.now());
    const isSystem = message.sender === 'System';
    const isOwnMessage = message.sender === 'You' || message.sender === username;
    row.classList.add(isSystem ? 'system' : isOwnMessage ? 'right' : 'left');

    const content = document.createElement('span');
    content.className = 'message-content';
    content.textContent = message.text;
    if (isSystem) {
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
      if (CouchShared.isSingleEmoji(message.text)) {
        content.classList.add('emoji-only');
      }
      row.append(content);
    }

    messageList.append(row);
    while (messageList.children.length > 100) messageList.firstElementChild.remove();
    messageList.scrollTop = messageList.scrollHeight;
    const compact = document.createElement('div');
    compact.className = 'compact-message';
    compact.textContent = `${message.sender}: ${message.text}`;
    compactMessages.append(compact);
    while (compactMessages.children.length > 2) compactMessages.firstElementChild.remove();
  }

  function updateViewToggle() {
    const label = isCompactView ? 'Expand' : 'Collapse';
    viewToggleButton.textContent = isCompactView ? '▼' : '▲';
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
    if (currentRoom) requestAnimationFrame(() => chatInput.focus());
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
    isRoomJoined = false;
    currentRoom = null;
    currentHost = null;
    joiningRoomId = null;
    hasRemoteVideo = false;
    setPlayback('paused', timestamp);
    persistSession();
    messageList.replaceChildren();
    compactMessages.replaceChildren();
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
    addMessage({ sender: 'You', text: message, time: Date.now() });
    socket.emit('send-message', { roomId: currentRoom, username, text: message });
  }

  function clearOwnChatHistory() {
    if (!currentRoom) return;
    const latestMessageTime = [...messageList.children].reduce((latest, message) => {
      const time = Number(message.dataset.messageTime);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, chatHistoryClearedAt);
    chatHistoryClearedAt = latestMessageTime;
    localStorage.setItem(`couch_chat_cleared_${currentRoom}`, String(chatHistoryClearedAt));
    messageList.replaceChildren();
    compactMessages.replaceChildren();
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

  usernameInput.addEventListener('input', updateButtons);
  joinRoomInput.addEventListener('input', updateButtons);
  createRoomForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (joinRoomInput.value.trim()) {
      submitRoomRequest(joinRoomInput.value.trim().toLowerCase(), 'join');
    } else {
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
  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendChat(chatInput.value);
    chatInput.value = '';
  });
  emojiBar.addEventListener('click', (event) => {
    const button = event.target.closest('.emoji-btn');
    if (button && button !== timestampButton) sendChat(button.textContent);
  });
  timestampButton.addEventListener('click', () => {
    if (durationSeconds > 0) sendChat(`⏱️ ${formatTime(currentTimestamp())}`);
  });
  durationForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = parseDuration(durationInput.value);
    if (!parsed) {
      durationError.textContent = 'Enter H:MM:SS or M:SS, such as 1:32:12.';
      return;
    }
    durationSeconds = parsed;
    durationError.textContent = '';
    localStorage.setItem('couch_remote_duration', durationInput.value.trim());
    controller.hidden = false;
    controllerHint.hidden = true;
    seekSlider.max = String(durationSeconds);
    totalDurationLabel.textContent = formatTime(durationSeconds);
    updateButtons();
    renderTimeline();
    persistSession();
  });
  durationInput.addEventListener('input', () => {
    applyDurationFormatting(durationInput);
    localStorage.setItem('couch_remote_duration', durationInput.value);
    persistSession();
  });
  themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  playbackToggle.addEventListener('click', () => {
    const timestamp = currentTimestamp();
    const nextStatus = playback.status === 'playing' ? 'paused' : 'playing';
    setPlayback(nextStatus, timestamp);
    emitVideoAction(nextStatus === 'playing' ? 'play' : 'pause', timestamp);
  });
  volumeSlider.addEventListener('input', () => setVolume(Number(volumeSlider.value)));
  volumePresets.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-volume]');
    if (button && !button.disabled) setVolume(Number(button.dataset.volume));
  });
  seekSlider.addEventListener('input', () => {
    isSeeking = true;
    if (!isEditingCurrentTime) currentTimeInput.value = formatTime(Number(seekSlider.value));
  });
  seekSlider.addEventListener('change', () => {
    const timestamp = Number(seekSlider.value);
    isSeeking = false;
    setPlayback(playback.status, timestamp);
    emitVideoAction('seek', timestamp);
  });
  currentTimeInput.addEventListener('focus', () => {
    isEditingCurrentTime = true;
    currentTimeInput.value = formatTime(currentTimestamp());
    currentTimeInput.select();
  });
  currentTimeInput.addEventListener('input', () => {
    applyDurationFormatting(currentTimeInput);
    currentTimeError.textContent = '';
  });
  currentTimeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const timestamp = parseDuration(currentTimeInput.value, { allowZero: true });
      if (timestamp === null) {
        currentTimeError.textContent = 'Enter a time in M:SS or H:MM:SS format.';
        return;
      }
      if (timestamp > durationSeconds) {
        currentTimeError.textContent = `Enter a time at or before ${formatTime(durationSeconds)}.`;
        return;
      }

      currentTimeError.textContent = '';
      isEditingCurrentTime = false;
      setPlayback(playback.status, timestamp);
      emitVideoAction('seek', timestamp);
      currentTimeInput.blur();
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
    setConnection('Connected to Couch', 'connected');
    updateButtons();
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
    const timestamp = currentTimestamp();
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
  });
  socket.on('new-message', (message) => {
    if (isVisibleAfterChatClear(message)) addMessage(message);
  });
  socket.on('play-video', ({ timestamp, updatedAt }) => setPlayback('playing', timestamp, updatedAt));
  socket.on('pause-video', ({ timestamp, updatedAt }) => setPlayback('paused', timestamp, updatedAt));
  socket.on('seek-video', ({ timestamp, updatedAt }) => setPlayback(playback.status, timestamp, updatedAt));
  socket.on('update-host', ({ newHost }) => { currentHost = newHost; });
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

  const savedDuration = durationSeconds || parseDuration(durationInput.value);
  if (savedDuration) {
    durationSeconds = savedDuration;
    controller.hidden = false;
    controllerHint.hidden = true;
    seekSlider.max = String(durationSeconds);
    totalDurationLabel.textContent = formatTime(durationSeconds);
  }

  updateViewToggle();
  showCompactView();
  setInterval(renderTimeline, 250);
  setInterval(persistSession, 1000);
  window.addEventListener('pagehide', persistSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSession();
  });
  updateButtons();
}

initializeRemote().catch((error) => {
  console.error('Couch Remote failed to initialize:', error);
  const status = document.getElementById('connection-status');
  status.textContent = 'Could not load Couch panel';
  status.dataset.state = 'offline';
});

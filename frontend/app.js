const API_URL = 'https://couch-sl1x.onrender.com';
const hostContainer = document.getElementById('couch-root');
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
  const couchSection = shadow.querySelector('section');
  const chatContainer = shadow.getElementById('chat-container');
  const edgeTab = shadow.getElementById('edge-tab');
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
  const currentTimeLabel = document.getElementById('remote-current-time');
  const playbackStatusLabel = document.getElementById('remote-playback-status');
  const totalDurationLabel = document.getElementById('remote-total-duration');
  const playbackToggle = document.getElementById('remote-toggle-playback');
  const themeColor = document.querySelector('meta[name="theme-color"]');

  let username = localStorage.getItem('couch_username') || '';
  let currentRoom = null;
  let currentHost = null;
  let durationSeconds = 0;
  let playback = { status: 'paused', timestamp: 0, updatedAt: Date.now() };
  let lastPlaybackEventAt = playback.updatedAt;
  let hasRestoredPlayback = false;
  let isSeeking = false;
  let isCompactView = false;
  let dockedEdge = null;
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let blurTimer = null;

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

  function parseDuration(value) {
    const parts = value.trim().split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
    const numbers = parts.map(Number);
    const seconds = numbers.at(-1);
    const minutes = numbers.at(-2);
    if (seconds > 59 || (parts.length === 3 && minutes > 59)) return null;

    const total = parts.length === 3
      ? numbers[0] * 3600 + minutes * 60 + seconds
      : minutes * 60 + seconds;
    return Number.isSafeInteger(total) && total > 0 ? total : null;
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
    const elapsed = playback.status === 'playing' ? (Date.now() - playback.updatedAt) / 1000 : 0;
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
    if (!currentRoom || !socket.connected) return;
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
    currentTimeLabel.textContent = formatTime(timestamp);
    playbackStatusLabel.textContent = playback.status === 'playing' ? 'Playing' : 'Paused';
    totalDurationLabel.textContent = formatTime(durationSeconds);
    playbackToggle.textContent = playback.status === 'playing' ? 'Pause' : 'Play';
    playbackToggle.classList.toggle('is-secondary', playback.status === 'playing');
    playbackToggle.setAttribute('aria-label', playback.status === 'playing' ? 'Pause playback' : 'Start playback');
    if (!isSeeking) seekSlider.value = String(Math.min(timestamp, durationSeconds));
    if (timestamp >= durationSeconds && playback.status === 'playing') {
      setPlayback('paused', durationSeconds);
      emitVideoAction('pause', durationSeconds);
    }
  }

  function updateButtons() {
    const connected = socket.connected;
    const hasUsername = usernameInput.value.trim().length > 0;
    createRoomButton.disabled = !connected || !hasUsername;
    joinRoomButton.disabled = !connected || !hasUsername || !joinRoomInput.value.trim();
    chatInput.disabled = !connected || currentRoom === null;
    const canControl = connected && currentRoom !== null && durationSeconds > 0;
    seekSlider.disabled = !canControl;
    playbackToggle.disabled = !canControl;
    timestampButton.disabled = !canControl;
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
    currentRoom = null;
    currentHost = null;
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
    localStorage.setItem('couch_username', username);
    joinError.textContent = '';
    roomLoading.textContent = 'Connecting...';
    createRoomButton.disabled = true;
    joinRoomButton.disabled = true;
    socket.timeout(10000).emit('join-room', { roomId, username, action }, (error, result) => {
      updateButtons();
      if (error) {
        joinError.textContent = 'The server did not respond. Please try again.';
        return;
      }
      if (!result?.success) {
        joinError.textContent = result?.message || 'Could not join this room.';
        return;
      }
      currentHost = result.host || currentHost;
      showRoom(roomId);
    });
  }

  function sendChat(text) {
    const message = text.trim();
    if (!message || !currentRoom || !socket.connected) return;
    addMessage({ sender: 'You', text: message, time: Date.now() });
    socket.emit('send-message', { roomId: currentRoom, username, text: message });
  }

  function setConnection(message, state) {
    status.textContent = message;
    status.dataset.state = state;
  }

  function setDockedEdge(edge) {
    dockedEdge = edge;
    hostContainer.classList.toggle('docked-left', edge === 'left');
    hostContainer.classList.toggle('docked-right', edge === 'right');
    edgeTab.textContent = edge === 'left' ? '▶' : '◀';
  }

  function snapToEdge() {
    const viewportWidth = document.documentElement.clientWidth;
    if (dockedEdge) {
      hostContainer.style.left = dockedEdge === 'left'
        ? '12px'
        : `${viewportWidth - hostContainer.offsetWidth - 12}px`;
      return;
    }

    const rect = hostContainer.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const edgeGap = 12;
    const pastLeftDockThreshold = rect.left + rect.width / 2 < 0;
    const pastRightDockThreshold = rect.left + rect.width / 2 > viewportWidth;
    const nearestEdge = [
      { name: 'top', distance: rect.top },
      { name: 'left', distance: rect.left },
      { name: 'right', distance: viewportWidth - rect.right },
      { name: 'bottom', distance: viewportHeight - rect.bottom }
    ].reduce((nearest, edge) => edge.distance < nearest.distance ? edge : nearest);
    const maxLeft = Math.max(edgeGap, viewportWidth - rect.width - edgeGap);
    const maxTop = Math.max(edgeGap, viewportHeight - rect.height - edgeGap);
    const left = Math.min(Math.max(rect.left, edgeGap), maxLeft);
    const top = Math.min(Math.max(rect.top, edgeGap), maxTop);
    hostContainer.style.right = 'auto';

    if (nearestEdge.name === 'top') {
      hostContainer.style.left = `${left}px`;
      hostContainer.style.top = `${edgeGap}px`;
    } else if (nearestEdge.name === 'left') {
      hostContainer.style.left = `${edgeGap}px`;
      hostContainer.style.top = `${top}px`;
      if (pastLeftDockThreshold) setDockedEdge('left');
    } else if (nearestEdge.name === 'bottom') {
      hostContainer.style.left = `${left}px`;
      hostContainer.style.top = `${viewportHeight - rect.height - edgeGap}px`;
    } else {
      hostContainer.style.left = `${viewportWidth - rect.width - edgeGap}px`;
      hostContainer.style.top = `${top}px`;
      if (pastRightDockThreshold) setDockedEdge('right');
    }
  }

  function scheduleBlur() {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!hostContainer.matches(':hover') && !shadow.activeElement) {
        couchSection.classList.add('blurred');
        edgeTab.classList.add('blurred');
      }
    }, 3000);
  }

  hostContainer.addEventListener('mouseenter', () => {
    clearTimeout(blurTimer);
    couchSection.classList.remove('blurred');
    edgeTab.classList.remove('blurred');
  });
  hostContainer.addEventListener('mouseleave', scheduleBlur);
  shadow.addEventListener('focus', () => {
    hostContainer.classList.add('is-focused');
    clearTimeout(blurTimer);
    couchSection.classList.remove('blurred');
    edgeTab.classList.remove('blurred');
  }, true);
  shadow.addEventListener('blur', () => {
    setTimeout(() => {
      if (!shadow.activeElement) {
        hostContainer.classList.remove('is-focused');
        scheduleBlur();
      }
    }, 0);
  }, true);
  shadow.getElementById('drag-handle').addEventListener('mousedown', (event) => {
    dragging = true;
    const rect = hostContainer.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
  });
  viewToggleButton.addEventListener('mousedown', (event) => event.stopPropagation());
  viewToggleButton.addEventListener('click', () => isCompactView ? showFullView() : showCompactView());
  compactView.addEventListener('click', showFullView);
  edgeTab.addEventListener('mousedown', (event) => event.stopPropagation());
  edgeTab.addEventListener('click', () => {
    setDockedEdge(null);
    if (currentRoom && !isCompactView) requestAnimationFrame(() => chatInput.focus());
  });
  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    hostContainer.style.right = 'auto';
    hostContainer.style.bottom = 'auto';
    hostContainer.style.left = `${event.clientX - dragOffsetX}px`;
    hostContainer.style.top = `${event.clientY - dragOffsetY}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    snapToEdge();
  });
  window.addEventListener('resize', snapToEdge);

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
  seekSlider.addEventListener('input', () => {
    isSeeking = true;
    currentTimeLabel.textContent = formatTime(Number(seekSlider.value));
  });
  seekSlider.addEventListener('change', () => {
    const timestamp = Number(seekSlider.value);
    isSeeking = false;
    setPlayback(playback.status, timestamp);
    emitVideoAction('seek', timestamp);
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
      socket.timeout(10000).emit('join-room', { roomId, username, action: 'join' }, (error, result) => {
        if (error || !result?.success) {
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
    setConnection('Disconnected — reconnecting...', 'offline');
    updateButtons();
  });
  socket.on('connect_error', () => {
    setConnection('Could not connect to Couch', 'offline');
    updateButtons();
  });
  socket.on('sync-room', (state) => {
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
    for (const message of state.chatHistory || []) addMessage(message);
  });
  socket.on('new-message', addMessage);
  socket.on('play-video', ({ timestamp, updatedAt }) => setPlayback('playing', timestamp, updatedAt));
  socket.on('pause-video', ({ timestamp, updatedAt }) => setPlayback('paused', timestamp, updatedAt));
  socket.on('seek-video', ({ timestamp, updatedAt }) => setPlayback(playback.status, timestamp, updatedAt));
  socket.on('update-host', ({ newHost }) => { currentHost = newHost; });

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
  scheduleBlur();
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

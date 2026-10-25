async function initializeCouch() {
// 1. Setup Variables
const socket = io('http://localhost:3000');
let isRemoteUpdate = false;
const VIDEO_ACTION_ANNOUNCEMENT_DELAY_MS = 1000;
let myUsername = '';
let currentRoom = null; // Starts null! We are in the lobby.
let currentHost = null; // Track current room host
let isCompactView = true;
let chatHistoryClearedAt = 0;
let joiningRoomId = null;
const chatHistoryClearedAtByRoom = {};

// Helper to generate a random 6-character room code (e.g., "x7b9kq")
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8);
}

function generateUsername() {
  return `Guest-${Math.random().toString(36).substring(2, 7)}`;
}

// 2. Video Hijacking Logic
let activeVideo = null;

function isVisibleVideo(video) {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  );
}

function isActivelyPlaying(video) {
  return (
    video instanceof HTMLVideoElement &&
    !video.paused &&
    !video.ended &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  );
}

function findVideoElement() {
  if (isActivelyPlaying(activeVideo)) return activeVideo;

  const videos = [...document.querySelectorAll('video')].filter(isVisibleVideo);

  return videos.sort((first, second) => (
    second.clientWidth * second.clientHeight - first.clientWidth * first.clientHeight
  ))[0] || null;
}

let hookedVideo = null;
let pendingVideoState = null;
let lastAnnouncedMediaKey = null;
let remoteSeekTarget = null;
const pendingVideoActionAnnouncements = new Set();

function cancelPendingVideoActionAnnouncements() {
  pendingVideoActionAnnouncements.forEach(clearTimeout);
  pendingVideoActionAnnouncements.clear();
}

function getVideoTitle(video) {
  const elementTitle = video.getAttribute('title')?.trim();
  if (elementTitle) return elementTitle;

  const pageTitle = document.title.trim();
  return pageTitle.replace(/\s*[|-]\s*(YouTube|Cinejoy|Cinegram)\s*$/i, '').trim() || 'Untitled video';
}

function announceMediaChange(video) {
  if (!currentRoom || video !== hookedVideo) return;

  const mediaKey = video.currentSrc || video.src || getVideoTitle(video);
  if (mediaKey === lastAnnouncedMediaKey) return;
  lastAnnouncedMediaKey = mediaKey;

  socket.emit('media-change', {
    roomId: currentRoom,
    username: myUsername,
    title: getVideoTitle(video),
    mediaKey
  });
}

function announceVideoVolume(video = findVideoElement()) {
  if (!currentRoom) return;
  socket.emit('video-volume-state', {
    roomId: currentRoom,
    available: Boolean(video),
    volume: video ? (video.muted ? 0 : video.volume) : null
  });
}

function applyVideoTime(video, timestamp) {
  isRemoteUpdate = true;
  if (Math.abs(video.currentTime - timestamp) > 0.5) {
    remoteSeekTarget = { video, timestamp };
    video.currentTime = timestamp;
  }
  setTimeout(() => { isRemoteUpdate = false; }, 50);
}

function applyVideoState(video, state) {
  applyVideoTime(video, state.timestamp);

  if (state.status === 'playing') {
    video.play()
      .catch(error => console.error('Watch Party autoplay blocked:', error))
      .finally(() => { isRemoteUpdate = false; });
  } else {
    video.pause();
  }
}

function hookVideo(video) {
  if (!video || video === hookedVideo) return;
  cancelPendingVideoActionAnnouncements();
  hookedVideo = video;
  console.log('Watch Party: Video element found and hooked!');
  announceVideoVolume(video);

  function announceVideoAction(action) {
    socket.emit('video-action', {
      roomId: currentRoom,
      username: myUsername,
      action,
      timestamp: video.currentTime
    });
  }

  function deferPlaybackAnnouncement(action) {
    const roomId = currentRoom;
    const username = myUsername;
    const timestamp = video.currentTime;
    const timer = setTimeout(() => {
      pendingVideoActionAnnouncements.delete(timer);
      if (roomId !== currentRoom) return;
      socket.emit('video-action', { roomId, username, action, timestamp });
    }, VIDEO_ACTION_ANNOUNCEMENT_DELAY_MS);
    pendingVideoActionAnnouncements.add(timer);
  }

  video.addEventListener('play', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('play-video', { roomId: currentRoom, timestamp: video.currentTime });
    deferPlaybackAnnouncement('play');
  });

  video.addEventListener('pause', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    if (document.hidden) return;
    socket.emit('pause-video', { roomId: currentRoom, timestamp: video.currentTime });
    deferPlaybackAnnouncement('pause');
  });

  video.addEventListener('seeked', () => {
    if (!currentRoom || video !== hookedVideo) return;
    cancelPendingVideoActionAnnouncements();
    if (remoteSeekTarget?.video === video) {
      const isRemoteSeek = Math.abs(video.currentTime - remoteSeekTarget.timestamp) <= 0.5;
      remoteSeekTarget = null;
      if (isRemoteSeek) return;
    }
    if (isRemoteUpdate) return;
    socket.emit('seek-video', { roomId: currentRoom, timestamp: video.currentTime });
    announceVideoAction('seek');
  });

  video.addEventListener('loadedmetadata', () => announceMediaChange(video));
  video.addEventListener('volumechange', () => announceVideoVolume(video));
  video.addEventListener('emptied', () => { lastAnnouncedMediaKey = null; });

  if (video.readyState >= 1) announceMediaChange(video);

  if (pendingVideoState) {
    if (pendingVideoState.status === 'seeking') {
      applyVideoTime(video, pendingVideoState.timestamp);
    } else {
      applyVideoState(video, pendingVideoState);
    }
    pendingVideoState = null;
  }
}

document.addEventListener('playing', (event) => {
  if (!(event.target instanceof HTMLVideoElement)) return;
  activeVideo = event.target;
  hookVideo(activeVideo);
}, true);

let wasPageHidden = document.hidden;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    wasPageHidden = true;
    return;
  }
  if (!wasPageHidden) return;
  wasPageHidden = false;

  const roomId = currentRoom;
  const video = hookedVideo;
  if (!roomId || !video || !socket.connected) return;

  socket.timeout(6000).emit('request-room-playback-state', { roomId }, (error, result) => {
    if (roomId !== currentRoom || video !== hookedVideo) return;
    if (error) {
      console.error('Could not restore playback after returning to the video tab:', error);
      return;
    }
    if (
      !result?.success
      || !['playing', 'paused'].includes(result.state?.status)
      || !Number.isFinite(result.state.timestamp)
      || result.state.timestamp < 0
    ) {
      console.error('The room returned an invalid playback state while restoring the video tab.');
      return;
    }

    applyVideoState(video, result.state);
  });
});

setInterval(() => hookVideo(findVideoElement()), 500);

function setPendingVideoState(status, timestamp) {
  pendingVideoState = { status, timestamp };
  const video = findVideoElement();

  if (!video) return;

  if (status === 'seeking') {
    applyVideoTime(video, timestamp);
    return;
  }

  applyVideoState(video, pendingVideoState);
}

socket.on('play-video', (data) => {
  setPendingVideoState('playing', data.timestamp);
});

socket.on('pause-video', (data) => {
  setPendingVideoState('paused', data.timestamp);
});

socket.on('seek-video', (data) => {
  setPendingVideoState('seeking', data.timestamp);
});

socket.on('request-video-volume', () => announceVideoVolume());
socket.on('request-playback-state', ({ roomId }, callback) => {
  if (roomId !== currentRoom || typeof callback !== 'function') return;

  const video = findVideoElement();
  if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(video.currentTime)) {
    callback({ available: false });
    return;
  }

  callback({
    available: true,
    status: video.paused ? 'paused' : 'playing',
    timestamp: video.currentTime
  });
});
socket.on('set-video-volume', ({ volume }) => {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
  const video = findVideoElement();
  if (!video) {
    announceVideoVolume(null);
    return;
  }
  video.volume = volume;
  video.muted = volume === 0;
  announceVideoVolume(video);
});


// 3. UI Injection (Draggable + Semantic HTML)
const hostContainer = document.createElement('div');
hostContainer.id = 'couch';
hostContainer.style.cssText = `
  display: block; position: fixed; top: 20px; right: 20px; width: 250px;
  z-index: 9999999;
`;

const shadow = hostContainer.attachShadow({ mode: 'open' });
const panelResponse = await fetch(chrome.runtime.getURL('panel.html'));
if (!panelResponse.ok) throw new Error(`Panel template request failed: ${panelResponse.status}`);
const panelMarkup = await panelResponse.text();
shadow.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL('panel.css')}">${panelMarkup
  .replaceAll('__COUCH_LOGO_URL__', chrome.runtime.getURL('assets/couch.svg'))
  .replaceAll('__COUCH_LINK_URL__', chrome.runtime.getURL('assets/link.svg'))
  .replaceAll('__COUCH_USERS_URL__', chrome.runtime.getURL('assets/users.svg'))
  .replaceAll('__COUCH_ERASER_URL__', chrome.runtime.getURL('assets/eraser.svg'))
  .replaceAll('__COUCH_LOGOUT_URL__', chrome.runtime.getURL('assets/logout.svg'))
  .replaceAll('__COUCH_VERSION__', chrome.runtime.getManifest().version)}`;
document.body.appendChild(hostContainer);

function syncFullscreenHost() {
  const fullscreenElement = document.fullscreenElement;
  const hostParent = fullscreenElement || document.body;

  if (hostContainer.parentElement !== hostParent) {
    hostParent.appendChild(hostContainer);
  }
}

document.addEventListener('fullscreenchange', syncFullscreenHost);

const compactView = shadow.getElementById('compact-view');
const compactMessages = shadow.getElementById('compact-messages');
const chatResizeHandle = shadow.getElementById('chat-resize-handle');
const viewToggleBtn = shadow.getElementById('view-toggle-btn');
const couchSection = shadow.querySelector('section');
const edgeTab = shadow.getElementById('edge-tab');
let blurOpacityTimer;
let isMessageMainVisible = false;
let dockedEdge = null;

function clearBlurOpacityTimer() {
  clearTimeout(blurOpacityTimer);
  blurOpacityTimer = null;
}

const chatResizer = CouchShared.createChatResizer(chatResizeHandle, hostContainer, {
  initialHeight: 130,
  onCommit: (height) => {
    chrome.storage.local.set({ couch_chat_height: height }).catch((error) => {
      console.error('Could not save Couch chat height:', error);
    });
  }
});
chrome.storage.local.get('couch_chat_height').then(({ couch_chat_height: savedHeight }) => {
  if (Number.isFinite(savedHeight)) {
    chatResizer.setHeight(savedHeight);
  } else if (savedHeight !== undefined) {
    console.warn('Saved Couch chat height is invalid; using the default height.');
  }
}).catch((error) => {
  console.error('Could not restore Couch chat height:', error);
});

function showInteractiveOpacity() {
  clearBlurOpacityTimer();
  couchSection.classList.remove('blurred');
  edgeTab.classList.remove('blurred');
}

function scheduleBlurOpacity() {
  clearBlurOpacityTimer();
  blurOpacityTimer = setTimeout(() => {
    if (!hostContainer.matches(':hover') && !shadow.activeElement) {
      couchSection.classList.add('blurred');
      edgeTab.classList.add('blurred');
    }
  }, 3000);
}

hostContainer.addEventListener('mouseenter', showInteractiveOpacity);
hostContainer.addEventListener('mouseleave', scheduleBlurOpacity);
shadow.addEventListener('focus', () => {
  hostContainer.classList.add('is-focused');
  showInteractiveOpacity();
}, true);
shadow.addEventListener('blur', () => {
  setTimeout(() => {
    if (!shadow.activeElement) {
      hostContainer.classList.remove('is-focused');
      scheduleBlurOpacity();
    }
  }, 0);
}, true);

scheduleBlurOpacity();

function highlightNewMessage() {
  showInteractiveOpacity();
  couchSection.classList.add('has-new-message');
  edgeTab.classList.add('has-new-message');
  if (isMessageMainVisible) {
    couchSection.classList.remove('has-new-message');
    edgeTab.classList.remove('has-new-message');
  }
}

function updateViewToggleButton() {
  const action = isCompactView ? 'Expand' : 'Collapse';
  CouchShared.setArrowIcon(viewToggleBtn, isCompactView ? 'down' : 'up');
  viewToggleBtn.title = `${action} Couch`;
  viewToggleBtn.setAttribute('aria-label', `${action} Couch`);
}

function showFullView() {
  isCompactView = false;
  updateViewToggleButton();
  hostContainer.style.display = 'block';
  compactView.style.display = 'none';
  lobbyView.style.display = currentRoom ? 'none' : 'flex';
  chatContainer.style.display = currentRoom ? 'flex' : 'none';
  if (currentRoom) {
    requestAnimationFrame(() => chatInput.focus());
  }
}

function showCompactView() {
  isCompactView = true;
  updateViewToggleButton();
  hostContainer.style.display = 'block';
  chatContainer.style.display = 'none';
  lobbyView.style.display = 'none';
  compactView.style.display = 'flex';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'toggle-chat') {
    if (hostContainer.style.display === 'none') {
      showCompactView();
    } else {
      hostContainer.style.display = 'none';
    }
  }
});

// 4. Drag Logic
const dragHandle = shadow.getElementById('drag-handle');
let isDragging = false, dragStartX = 0, dragStartY = 0;

dragHandle.addEventListener('mousedown', (e) => {
  isDragging = true;
  const rect = hostContainer.getBoundingClientRect();
  dragStartX = e.clientX - rect.left;
  dragStartY = e.clientY - rect.top;
});

viewToggleBtn.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

compactView.addEventListener('click', () => {
  showFullView();
});

viewToggleBtn.addEventListener('click', () => {
  if (isCompactView) {
    showFullView();
  } else {
    showCompactView();
  }
});

function setDockedEdge(edge) {
  dockedEdge = edge;
  hostContainer.classList.toggle('docked-left', edge === 'left');
  hostContainer.classList.toggle('docked-right', edge === 'right');
  CouchShared.setArrowIcon(edgeTab, edge === 'left' ? 'right' : 'left');
  edgeTab.title = 'Show Couch';
  edgeTab.setAttribute('aria-label', 'Show Couch');
}

function restoreFromEdge() {
  if (!dockedEdge) return;
  setDockedEdge(null);
  if (currentRoom && !isCompactView) {
    requestAnimationFrame(() => chatInput.focus());
  }
}

edgeTab.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

edgeTab.addEventListener('click', restoreFromEdge);

updateViewToggleButton();

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  hostContainer.style.right = 'auto';
  hostContainer.style.bottom = 'auto';
  hostContainer.style.left = `${e.clientX - dragStartX}px`;
  hostContainer.style.top = `${e.clientY - dragStartY}px`;
});

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
  const edges = [
    { name: 'top', distance: rect.top },
    { name: 'left', distance: rect.left },
    { name: 'right', distance: viewportWidth - rect.right },
    { name: 'bottom', distance: viewportHeight - rect.bottom }
  ];
  const nearestEdge = edges.reduce((nearest, edge) => (
    edge.distance < nearest.distance ? edge : nearest
  ));
  const maxLeft = Math.max(edgeGap, viewportWidth - rect.width - edgeGap);
  const maxTop = Math.max(edgeGap, viewportHeight - rect.height - edgeGap);
  const currentLeft = Math.min(Math.max(rect.left, edgeGap), maxLeft);
  const currentTop = Math.min(Math.max(rect.top, edgeGap), maxTop);

  hostContainer.style.right = 'auto';
  hostContainer.style.bottom = 'auto';

  if (nearestEdge.name === 'top') {
    hostContainer.style.left = `${currentLeft}px`;
    hostContainer.style.top = `${edgeGap}px`;
  } else if (nearestEdge.name === 'left') {
    hostContainer.style.left = `${edgeGap}px`;
    hostContainer.style.top = `${currentTop}px`;
    if (pastLeftDockThreshold) setDockedEdge('left');
  } else if (nearestEdge.name === 'bottom') {
    hostContainer.style.left = `${currentLeft}px`;
    hostContainer.style.top = `${viewportHeight - rect.height - edgeGap}px`;
  } else {
    hostContainer.style.left = `${viewportWidth - rect.width - edgeGap}px`;
    hostContainer.style.top = `${currentTop}px`;
    if (pastRightDockThreshold) setDockedEdge('right');
  }
}

document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  snapToEdge();
});

window.addEventListener('resize', snapToEdge);

// 5. Chat Logic
const messageList = shadow.getElementById('messages');
const chatForm = shadow.getElementById('chat-form');
const chatInput = shadow.getElementById('chat-input');
const roomUsersToggle = shadow.getElementById('room-users-toggle');
const roomUsersCount = shadow.getElementById('room-users-count');
const roomUsersPanel = shadow.getElementById('room-users-panel');
const roomUsersList = shadow.getElementById('room-users-list');
const messageMain = messageList.closest('main');

const messagesVisibilityObserver = new IntersectionObserver(([entry]) => {
  isMessageMainVisible = entry.isIntersecting;
  if (!entry.isIntersecting) return;

  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
  couchSection.classList.remove('has-new-message');
  edgeTab.classList.remove('has-new-message');
  if (!hostContainer.matches(':hover') && !shadow.activeElement) {
    scheduleBlurOpacity();
  }
}, { threshold: 0.1 });

messagesVisibilityObserver.observe(messageMain);

function buildLinkifiedText(messageText) {
  const safeText = String(messageText ?? '');
  if (!safeText) return document.createTextNode('');

  const fragment = document.createDocumentFragment();
  const parts = safeText.split(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi);

  parts.forEach((part) => {
    if (!part) return;

    const isUrl = /^https?:\/\/[^\s]+$/i.test(part) || /^www\.[^\s]+$/i.test(part);
    if (!isUrl) {
      fragment.appendChild(document.createTextNode(part));
      return;
    }

    const link = document.createElement('a');
    const normalizedUrl = /^www\./i.test(part) ? `https://${part}` : part;
    link.href = normalizedUrl;
    link.target = '_self';
    link.rel = 'noopener noreferrer';
    link.textContent = part;
    fragment.appendChild(link);
  });

  return fragment;
}

function createSenderLabel(sender, isHost) {
  const wrapper = document.createElement('span');
  wrapper.className = 'sender-label';
  const name = document.createElement('b');
  name.textContent = sender;
  wrapper.appendChild(name);

  if (isHost) {
    const hostTag = document.createElement('b');
    const hostText = document.createElement('i');
    hostText.textContent = ' (host)';
    hostTag.appendChild(hostText);
    wrapper.appendChild(document.createTextNode(' '));
    wrapper.appendChild(hostTag);
  }

  return wrapper;
}

function appendTextWithHighlightedUsernames(element, text, usernames) {
  element.replaceChildren();
  const alternatives = [...new Set(usernames.filter(username => typeof username === 'string' && username))]
    .sort((first, second) => second.length - first.length)
    .map(username => username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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

function appendMessage(sender, text, time = Date.now(), announcement = null) {
  const rowDiv = document.createElement('div');
  rowDiv.className = 'message-row';
  rowDiv.dataset.messageTime = String(time);

  const messageContent = document.createElement('span');
  messageContent.className = 'message-content';
  if (CouchShared.isSingleEmoji(text)) messageContent.classList.add('emoji-only');

  const compactRow = document.createElement('div');
  compactRow.className = 'compact-message';
  compactRow.textContent = `${sender}: ${text}`;

  if (sender === 'System') {
    rowDiv.classList.add('system');
    if (announcement?.syncTargetUsername) rowDiv.classList.add('has-playback-sync');
    if (announcement?.type === 'playback-position-announcement' && Array.isArray(announcement.participants)) {
      messageContent.classList.add('playback-announcement');
      const heading = document.createElement('span');
      heading.className = 'playback-announcement-heading';
      heading.textContent = announcement.heading || 'Status check every 5 mins';
      messageContent.append(heading);

      const participantList = document.createElement('span');
      participantList.className = 'playback-announcement-participants';
      for (const participant of announcement.participants) {
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
      messageContent.append(participantList);
      if (typeof announcement.syncTargetUsername === 'string' && announcement.syncTargetUsername) {
        messageContent.append(createPlaybackSyncControl(announcement.syncTargetUsername));
      }
    } else {
      appendTextWithHighlightedUsernames(
        messageContent,
        text,
        announcement?.highlightedUsernames || []
      );
    }
    rowDiv.appendChild(messageContent);
  } else if (sender === 'You' || sender === myUsername) {
    rowDiv.classList.add('right');
    messageContent.appendChild(buildLinkifiedText(text));
    rowDiv.appendChild(messageContent);
  } else {
    rowDiv.classList.add('left');
    const isHost = sender === currentHost;
    const senderLabel = createSenderLabel(sender, isHost);

    rowDiv.appendChild(senderLabel);
    messageContent.appendChild(buildLinkifiedText(text));
    rowDiv.appendChild(messageContent);
  }

  if (announcement?.type === 'playback-position-announcement' && announcement.syncTargetUsername) {
    compactRow.append(createPlaybackSyncControl(announcement.syncTargetUsername, true));
  }

  messageList.appendChild(rowDiv);
  compactMessages.appendChild(compactRow);

  while (compactMessages.children.length > 2) {
    compactMessages.firstElementChild.remove();
  }

  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

function clearChatHistory() {
  messageList.innerHTML = '';
  compactMessages.innerHTML = '';
}

function renderRoomUsers(users, host) {
  roomUsersList.replaceChildren();
  const uniqueUsers = [...new Set(users)];
  roomUsersCount.textContent = `(${uniqueUsers.length})`;
  roomUsersToggle.title = `Users (${uniqueUsers.length})`;
  roomUsersToggle.setAttribute('aria-label', `Users (${uniqueUsers.length})`);
  for (const username of uniqueUsers) {
    const item = document.createElement('li');
    item.textContent = username === host ? `${username} (host)` : username;
    roomUsersList.append(item);
  }
}

roomUsersToggle.addEventListener('click', () => {
  roomUsersPanel.hidden = !roomUsersPanel.hidden;
  roomUsersToggle.setAttribute('aria-expanded', String(!roomUsersPanel.hidden));
});

function emitLocalChatMessage(text) {
  const trimmedText = String(text ?? '').trim();
  if (!trimmedText || !currentRoom) return;

  if (trimmedText === '/remote') {
    showRemoteQrCode();
    return;
  }

  const seekTimestamp = CouchShared.parseSeekCommand(trimmedText);
  if (seekTimestamp !== null) {
    pendingVideoState = { status: 'seeking', timestamp: seekTimestamp };
    const video = findVideoElement();
    if (video) applyVideoTime(video, seekTimestamp);
    socket.emit('seek-video', { roomId: currentRoom, timestamp: seekTimestamp });
    socket.emit('video-action', {
      roomId: currentRoom,
      username: myUsername,
      action: 'seek',
      timestamp: seekTimestamp
    });
    return;
  }

  appendMessage('You', trimmedText);
  socket.emit('send-message', {
    roomId: currentRoom,
    username: myUsername,
    text: trimmedText
  });

  requestAnimationFrame(() => chatInput.focus());
}

const lobbyView = shadow.getElementById('lobby');
const chatContainer = shadow.getElementById('chat-container');
const displayRoomId = shadow.getElementById('display-room-id');
const shareRoomButton = shadow.getElementById('share-room-btn');
const remoteQrDialog = shadow.getElementById('remote-qr-dialog');
const remoteQrCanvas = shadow.getElementById('remote-qr-canvas');
const remoteQrStatus = shadow.getElementById('remote-qr-status');
const joinRoomInput = shadow.getElementById('join-room-input');
const joinRoomBtn = shadow.getElementById('join-room-btn');
const joinRoomForm = shadow.getElementById('join-room-form');
const joinError = shadow.getElementById('join-error');
const roomLoadingMessage = shadow.getElementById('room-loading-message');
const usernameInput = shadow.getElementById('username-input');
const createRoomBtn = shadow.getElementById('create-room-btn');
const createRoomForm = shadow.getElementById('create-room-form');
const displayHostName = shadow.getElementById('display-host-name');
const roomCodeFromUrl = new URLSearchParams(window.location.search).get('roomCode')?.trim() || '';
if (roomCodeFromUrl) joinRoomInput.value = roomCodeFromUrl;

const sessionReady = chrome.storage.local.get([
  'couch_username',
  'couch_chat_history_cleared_at'
]).then((session) => {
  myUsername = typeof session.couch_username === 'string' && session.couch_username.trim()
    ? session.couch_username
    : generateUsername();
  if (session.couch_chat_history_cleared_at && typeof session.couch_chat_history_cleared_at === 'object') {
    Object.assign(chatHistoryClearedAtByRoom, session.couch_chat_history_cleared_at);
  }
  usernameInput.value = myUsername;
  updateLobbyButtons();

  return Promise.all([
    chrome.storage.local.set({ couch_username: myUsername }),
    chrome.storage.local.remove('couch_room')
  ]);
});
let roomRequestPending = false;
let roomLoadingTimer = null;

function updateLobbyButtons() {
  const hasUsername = usernameInput.value.trim();
  const hasRoomCode = joinRoomInput.value.trim();

  createRoomBtn.disabled = roomRequestPending || !hasUsername;
  joinRoomBtn.disabled = roomRequestPending || !hasUsername || !hasRoomCode;
  usernameInput.disabled = roomRequestPending;
  joinRoomInput.disabled = roomRequestPending;
}

function setRoomRequestPending(isPending) {
  roomRequestPending = isPending;

  if (roomLoadingTimer !== null) {
    clearTimeout(roomLoadingTimer);
    roomLoadingTimer = null;
  }

  if (isPending) {
    lobbyView.classList.add('is-loading');
    roomLoadingMessage.textContent = 'Connecting...';
    roomLoadingTimer = setTimeout(() => {
      if (roomRequestPending) roomLoadingMessage.textContent = 'Cold starting API...';
    }, 1500);
  } else {
    lobbyView.classList.remove('is-loading');
  }

  updateLobbyButtons();
}

usernameInput.addEventListener('input', updateLobbyButtons);
usernameInput.addEventListener('change', () => {
  const typedName = usernameInput.value.trim();
  if (!typedName) return;
  myUsername = typedName;
  chrome.storage.local.set({ couch_username: myUsername }).catch((error) => {
    console.error('Could not save Couch username:', error);
  });
});
joinRoomInput.addEventListener('input', updateLobbyButtons);
function submitRoomFromInputs() {
  if (!usernameInput.value.trim()) return;

  const roomCode = joinRoomInput.value.trim();
  if (roomCode) {
    captureAndSaveUsername();
    joinRoom(roomCode);
  } else {
    createRoom();
  }
}

createRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitRoomFromInputs();
});

const emojiBar = shadow.getElementById('emoji-bar');

emojiBar.addEventListener('click', (event) => {
  const emojiButton = event.target.closest('.emoji-btn');
  if (!emojiButton) return;

  emitLocalChatMessage(emojiButton.textContent);
});

// Helper function to capture username changes right before entering a room
function captureAndSaveUsername() {
  const typedName = usernameInput.value.trim();
  if (!typedName) return;

  myUsername = typedName;
  chrome.storage.local.set({ couch_username: myUsername }).catch((error) => {
    console.error('Could not save Couch username:', error);
  });
}

function showRoom(roomId) {
  currentRoom = roomId;
  joiningRoomId = null;
  displayRoomId.textContent = currentRoom;
  lobbyView.style.display = 'none';
  chatContainer.style.display = isCompactView ? 'none' : 'flex';

  if (hookedVideo?.readyState >= 1) {
    announceMediaChange(hookedVideo);
  }
  announceVideoVolume();
}

function joinRoom(roomId, action = 'join') {
  if (roomRequestPending) return;

  joiningRoomId = roomId;
  chatHistoryClearedAt = Number(chatHistoryClearedAtByRoom[roomId]) || 0;
  setRoomRequestPending(true);
  joinError.textContent = '';

  socket.emit('join-room', { roomId, username: myUsername, action, clientType: 'extension' }, (response) => {
    setRoomRequestPending(false);

    if (response.success) {
      showRoom(roomId);
      joinRoomInput.value = '';
      return;
    }

    joiningRoomId = null;
    if (action === 'join') {
      joinError.textContent = response.message;
    }
  });
}

function createRoom() {
  if (!usernameInput.value.trim()) return;

  captureAndSaveUsername();
  const newCode = generateRoomCode();
  currentHost = myUsername;

  if (displayHostName) {
    displayHostName.textContent = currentHost;
  }

  joinRoom(newCode, 'create');
}

createRoomBtn.addEventListener('click', createRoom);

joinRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (joinRoomBtn.disabled) return;

  const code = joinRoomInput.value.trim();
  captureAndSaveUsername();
  joinRoom(code);
});

const leaveRoomBtn = shadow.getElementById('leave-room-btn');
const clearChatButton = shadow.getElementById('clear-chat-btn');

function renderSyncedChatHistory(history) {
  history
    .filter(isVisibleAfterChatClear)
    .forEach((message) => appendMessage(message.sender, message.text, message.time, message));
}

function isVisibleAfterChatClear(message) {
  const time = Number(message.time);
  return chatHistoryClearedAt === 0 || (Number.isFinite(time) && time > chatHistoryClearedAt);
}

function clearOwnChatHistory() {
  if (!currentRoom) return;
  const latestMessageTime = [...messageList.children].reduce((latest, message) => {
    const time = Number(message.dataset.messageTime);
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, chatHistoryClearedAt);
  chatHistoryClearedAt = latestMessageTime;
  chatHistoryClearedAtByRoom[currentRoom] = chatHistoryClearedAt;
  chrome.storage.local.set({
    couch_chat_history_cleared_at: chatHistoryClearedAtByRoom
  }).catch((error) => {
    console.error('Could not save the cleared chat history marker:', error);
  });
  clearChatHistory();
}

clearChatButton.addEventListener('click', clearOwnChatHistory);

// --- FEATURE 3: LEAVING A ROOM ---
leaveRoomBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  socket.emit('leave-room', { roomId: currentRoom, username: myUsername });

  clearChatHistory();
  roomUsersList.replaceChildren();
  renderRoomUsers([], null);
  roomUsersPanel.hidden = true;
  roomUsersToggle.setAttribute('aria-expanded', 'false');
  currentRoom = null;
  chrome.storage.local.remove('couch_room');
  updateLobbyButtons();

  usernameInput.value = myUsername;
  chatContainer.style.display = 'none';
  lobbyView.style.display = 'flex';
  displayRoomId.textContent = '...';
});

// Grab the new timestamp elements
const timestampBtn = shadow.getElementById('timestamp-btn');

// --- FEATURE: SHARE VIDEO TIMESTAMP ---
timestampBtn.addEventListener('click', () => {
  if (!currentRoom || !socket.connected) return;
  const roomId = currentRoom;
  socket.timeout(6000).emit('check-room-playback', { roomId }, (error, result) => {
    if (roomId !== currentRoom) return;
    if (error || !result?.success) {
      appendMessage(
        'System',
        error
          ? 'Could not check playback times. Please try again.'
          : result?.message || 'Could not check playback times. Please try again.',
        Date.now()
      );
    }
  });
});

async function showRemoteQrCode() {
  if (!currentRoom) return;

  const remoteUrl = new URL('https://couch-remote.onrender.com/');
  remoteUrl.searchParams.set('username', myUsername);
  remoteUrl.searchParams.set('roomCode', currentRoom);
  remoteQrStatus.textContent = 'Generating QR code…';
  remoteQrDialog.showModal();

  try {
    await globalThis.CouchQrCode.toCanvas(remoteQrCanvas, remoteUrl.toString(), {
      width: 224,
      margin: 2,
      errorCorrectionLevel: 'Q'
    });
    remoteQrStatus.textContent = `Scan to open Couch Remote as ${myUsername} and join room ${currentRoom}.`;
  } catch (error) {
    console.error('Could not generate Couch Remote QR code:', error);
    remoteQrStatus.textContent = 'Could not generate the QR code. Please try again.';
  }
}

shadow.getElementById('remote-qr-close').addEventListener('click', () => {
  remoteQrDialog.close();
});

function handlePlaybackSyncClick(event) {
  const button = event.target.closest('button[data-playback-sync-target]');
  if (!button || button.disabled || !currentRoom || !socket.connected) return;

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
compactMessages.addEventListener('click', handlePlaybackSyncClick);

let copyFeedbackTimer = null;

displayRoomId.addEventListener('click', () => {
  if (!currentRoom) return;

  const showCopyState = (state, label) => {
    displayRoomId.dataset.copyState = state;
    displayRoomId.setAttribute('aria-label', label);
    displayRoomId.title = label;

    if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      delete displayRoomId.dataset.copyState;
      displayRoomId.setAttribute('aria-label', 'Copy room code');
      displayRoomId.title = 'Copy room code';
      copyFeedbackTimer = null;
    }, 2000);
  };

  navigator.clipboard.writeText(currentRoom).then(() => {
    showCopyState('copied', 'Room code copied');
  }).catch((error) => {
    console.error('Failed to copy room code:', error);
    showCopyState('error', 'Could not copy room code');
  });
});

let shareFeedbackTimer = null;

shareRoomButton.addEventListener('click', () => {
  if (!currentRoom) return;

  const showShareState = (state, label) => {
    shareRoomButton.dataset.copyState = state;
    shareRoomButton.setAttribute('aria-label', label);
    shareRoomButton.title = label;

    if (shareFeedbackTimer !== null) clearTimeout(shareFeedbackTimer);
    shareFeedbackTimer = setTimeout(() => {
      delete shareRoomButton.dataset.copyState;
      shareRoomButton.setAttribute('aria-label', 'Copy room invite link');
      shareRoomButton.title = 'Copy room invite link';
      shareFeedbackTimer = null;
    }, 2000);
  };

  const inviteUrl = new URL(window.location.href);
  inviteUrl.searchParams.set('roomCode', currentRoom);
  navigator.clipboard.writeText(inviteUrl.toString()).then(() => {
    showShareState('copied', 'Room invite link copied');
  }).catch((error) => {
    console.error('Failed to copy room invite link:', error);
    showShareState('error', 'Could not copy room invite link');
  });
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();

  if (!text) return;

  emitLocalChatMessage(text);
  chatInput.value = '';
});

socket.on('new-message', (data) => {
  if (!isVisibleAfterChatClear(data)) return;
  appendMessage(data.sender, data.text, data.time, data);
  highlightNewMessage();
});
socket.on('sync-room', (state) => {
  currentHost = state.host;
  renderRoomUsers(
    [...new Set((state.users || []).map(user => user.username))].sort((first, second) => (
      first === currentHost ? -1 : second === currentHost ? 1 : 0
    )),
    currentHost
  );
  pendingVideoState = state.video || null;

  const video = findVideoElement();
  if (video && pendingVideoState) {
    applyVideoState(video, pendingVideoState);
    pendingVideoState = null;
  }

  if (displayHostName) {
    displayHostName.textContent = currentHost;
  }

  clearChatHistory();
  const roomId = joiningRoomId || currentRoom;
  if (roomId) chatHistoryClearedAt = Number(chatHistoryClearedAtByRoom[roomId]) || 0;
  renderSyncedChatHistory(state.chatHistory);
});

socket.on('sync-playback-state', ({ roomId, status, timestamp }) => {
  if (
    (roomId !== currentRoom && roomId !== joiningRoomId)
    || !['playing', 'paused'].includes(status)
    || !Number.isFinite(timestamp)
    || timestamp < 0
  ) {
    return;
  }

  setPendingVideoState(status, timestamp);
});

socket.on('update-host', ({ newHost }) => {
  currentHost = newHost;

  if (displayHostName) {
    displayHostName.textContent = newHost;
    console.log(`Host title transferred to: ${newHost}`);
  }
});
socket.on('room-users', ({ users, host }) => {
  currentHost = host;
  renderRoomUsers(users, host);
});

sessionReady.catch((error) => {
  console.error('Could not restore Couch username:', error);
});
}

initializeCouch().catch((error) => {
  console.error('Couch panel failed to initialize:', error);
});

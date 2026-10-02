// 1. Setup Variables
const socket = io('https://couch-sl1x.onrender.com');
let isRemoteUpdate = false;
let myUsername = '';
let currentRoom = null; // Starts null! We are in the lobby.
let currentHost = null; // Track current room host
let isCompactView = true;

const sessionReady = chrome.storage.local.get(['couch_username', 'couch_room']).then((session) => {
  myUsername = session.couch_username || localStorage.getItem('couch_username');
  usernameInput.value = myUsername;
  updateLobbyButtons();

  if (!session.couch_username) {
    chrome.storage.local.set({ couch_username: myUsername });
  }

  return session.couch_room || null;
});

// Helper to generate a random 6-character room code (e.g., "x7b9kq")
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8);
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

function applyVideoTime(video, timestamp) {
  isRemoteUpdate = true;
  if (Math.abs(video.currentTime - timestamp) > 0.5) {
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
  hookedVideo = video;
  console.log('Watch Party: Video element found and hooked!');

  function announceVideoAction(action) {
    socket.emit('video-action', {
      roomId: currentRoom,
      username: myUsername,
      action,
      timestamp: video.currentTime
    });
  }

  video.addEventListener('play', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('play-video', { roomId: currentRoom, timestamp: video.currentTime });
    announceVideoAction('play');
  });

  video.addEventListener('pause', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('pause-video', { roomId: currentRoom, timestamp: video.currentTime });
    announceVideoAction('pause');
  });

  video.addEventListener('seeked', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('seek-video', { roomId: currentRoom, timestamp: video.currentTime });
    announceVideoAction('seek');
  });

  video.addEventListener('loadedmetadata', () => announceMediaChange(video));
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


// 3. UI Injection (Draggable + Semantic HTML)
const hostContainer = document.createElement('div');
hostContainer.id = 'couch';
hostContainer.style.cssText = `
  display: block; position: fixed; top: 20px; right: 20px; width: 250px;
  z-index: 9999999;
`;

const shadow = hostContainer.attachShadow({ mode: 'open' });
shadow.innerHTML = `
  <style>
    :host {
      display: block;
      transition: transform 180ms ease;
    }

    :host(.docked-left) {
      transform: translateX(calc(-100% + -25px));
    }

    :host(.docked-right) {
      transform: translateX(calc(100% - -25px));
    }

    section {
      transition: opacity 1s ease;
      transition: background 1s ease;
      box-sizing: border-box;
      width: 100%;
      opacity: 1;
      background-color: rgb(255 255 255 / 10%);
      backdrop-filter: blur(20px);
      border-radius: 12px;
      border: solid 1px rgb(199, 114, 75);
    }

    section.blurred,
    #edge-tab.blurred {
      opacity: 0.2;
    }

    #edge-tab {
      transition: opacity 1s ease;
      transition: background 1s ease;
      display: none;
      position: absolute;
      top: 50%;
      width: 28px;
      height: 56px;
      padding: 0;
      transform: translateY(-50%);
      cursor: pointer;
      color: white;
      border: 1px solid rgb(255 255 255 / 20%);
      background-color: rgb(255 255 255 / 10%);
      font-size: 18px;
      cursor: pointer;
      opacity: 1;
    }

    #edge-tab:hover {
      opacity: 1;
    }

    #edge-tab.has-new-message {
      opacity: 1;
      background-color: rgb(233 151 7 / 50%);
    }

    section.has-new-message {
      opacity: 1;
      background-color: rgb(233 151 7 / 50%);
    }

    :host(:hover) section,
    :host(:focus-within) section,
    :host(.is-focused) section,
    :host(:active) section {
      opacity: 1;
    }

    * {
      color: rgb(255 255 255 / 75%);
      font-family: sans-serif; 
    }
    input {
      border-radius: .5rem;
      height: 1rem;
      padding: 0.5rem;
      box-shadow: none;
      appearance: none;
      -webkit-appearance: none;
      outline: none;
      border: 1px solid rgb(255 255 255 / 20%);
      background-color: rgb(255 255 255 / 10%);
      flex-grow: 1;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }

    input:focus {
      border-color: rgb(199, 114, 75);
      box-shadow: 0 0 0 2px rgb(199 114 75 / 25%);
    }

    input::placeholder {
      color: rgb(255 255 255 / 30%);
    }
    
    .btn {
      padding: .5rem;
      cursor: pointer;
      color: white; 
      border: none; 
      border-radius: 4px; 
      background-color: rgb(199, 114, 75);
    }

    .btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .btn.danger {
      background-color: #ed1212;
    }

    .btn.small {
      font-size: 0.6rem;
      padding: .2rem .4rem;
    }

    header { 
      cursor: all-scroll;
      user-select: none; 
      font-family: sans-serif;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-radius: 12px 12px 0 0;
      padding: .5rem;
      background-color: rgb(255 255 255 / 30%);
      font-variant: small-caps;
    }

    .brand-label {
      background: linear-gradient(90deg, rgb(199, 114, 75), rgb(255, 214, 176));
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      -webkit-text-fill-color: transparent;
      font-weight: 700;
    }

    header:active { cursor: all-scroll; }

    .view-toggle-btn {
      padding: 0 4px;
      cursor: pointer;
      color: rgb(255 255 255 / 75%);
      border: 0;
      background: transparent;
      font-size: 10px;
      line-height: 1;
    }

    :host(.docked-left) #edge-tab,
    :host(.docked-right) #edge-tab {
      display: block;
    }

    :host(.docked-left) #edge-tab {
      top: 20px;
      right: -40px;
      border-radius: 0 8px 8px 0;
    }

    :host(.docked-right) #edge-tab {
      top: 20px;
      left: -40px;
      border-radius: 8px 0 0 8px;
    }

    /* Lobby Styles */
    #lobby {
      padding: 15px;
      display: none;
      flex-direction: column;
      gap: 10px;
    }
    
    /* Chat Container Styles */
    #chat-container { 
      display: none; 
      flex-direction: column; 
    }

    #compact-view {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: .5rem;
      cursor: default;
    }

    #compact-messages {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 34px;
      overflow: hidden;
      cursor: pointer;
    }

    .compact-title {
      font-size: 11px;
      font-weight: bold;
    }

    .compact-message {
      overflow: hidden;
      font-size: 10px;
      line-height: 15px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .room-header { 
      font-size: 12px; 
      padding: 4px 5px; 
      font-family: monospace; 
      display: flex; 
      justify-content: space-between;
      align-items: center;
    }

    /* Message List & Scrollable Area */
    #messages {
      border-top: 1px solid rgb(255 255 255 / 10%);
      border-bottom: 1px solid rgb(255 255 255 / 10%);
      list-style-type: none;
      margin: 0;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: sans-serif;
      font-size: 14px;
      
      /* Scroll & Height Settings */
      height: 100px;
      max-height: 100px;
      overflow-y: auto;
      
      /* Hide scrollbar for Chrome, Safari, Opera, and Firefox */
      scrollbar-width: none; 
    }

    #messages::-webkit-scrollbar {
      display: none; 
    }

    /* Message Row Alignments (Plain Text) */
    .message-row {
      width: 100%;
      font-size: 12px;
      word-break: break-word;
    }

    .message-row.left {
      align-self: start;
      max-width: 80%;
      text-align: left;
    }

    .message-row.right {
      align-self: flex-end;
      max-width: 80%;
      text-align: right;
    }

    .message-row.system {
      text-align: center;
      font-style: italic;
      font-size: 0.6rem;
      opacity: 0.5;
    }
    .message-content.emoji-only {
      font-size: 2rem;
      line-height: 1.2;
    }
    .message-row a {
      color: inherit;
      text-decoration: underline;
      word-break: break-all;
    }
    .emoji-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      padding: 2px;
      border-radius: 4px;
    }
    .muted {
      opacity: .5;
    }
    #emoji-bar {
      display: flex;
      gap: 6px;
      max-width: 190px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      white-space: nowrap;
    }
  </style>
  <section>
    <header id="drag-handle">
      <span class="brand-label">couch</span>
      <button id="view-toggle-btn" class="view-toggle-btn" type="button" title="Expand Couch" aria-label="Expand Couch">▼</button>
    </header>
    
    <!-- LOBBY VIEW -->
    <div id="lobby">
      <!-- UPDATED: Username section without a separate button -->
      <form id="create-room-form" style="display: contents;">
        <input type="text" id="username-input" placeholder="Username" autocomplete="off" style="margin-bottom: .5rem;"/>
        <button type="submit" id="create-room-btn" class="btn">Create New Room</button>
      </form>

      <hr width="100%" border="1" class="muted">

      <form id="join-room-form" style="display: flex; gap: 6px;">
        <input type="text" id="join-room-input" placeholder="Room Code" autocomplete="off"/>
        <button type="submit" id="join-room-btn" class="btn">Join</button>
      </form>
      <div id="join-error" style="color: red; font-size: 12px; height: 14px;"></div>
    </div>

    <!-- CHAT VIEW -->
    <div id="chat-container">
      <div class="room-header" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; font-size: 12px;">
        <div style="display: flex; align-items: center;">
          <span><strong id="display-room-id">...</strong></span>
          <!-- NEW: Copy Room Code Button -->
          <button id="copy-code-btn" style="background: none; border:none; cursor: pointer; font-size: 10px;" title="Copy Room Code">📋</button>
        </div>
        <button id="leave-room-btn" class="btn small danger">Leave</button>
      </div>
      <main><ul id="messages"></ul></main>
      <footer>
        <!-- Toolbar containing Emojis and Timestamp Button -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.2rem .5rem;">
          <div id="emoji-bar">
            <button class="emoji-btn" title="Clap">👏</button>
            <button class="emoji-btn" title="Laugh">😂</button>
            <button class="emoji-btn" title="Heart">♥️</button>
            <button class="emoji-btn" title="Scared">😱</button>
            <button class="emoji-btn" title="Surprise">😲</button>
            <button class="emoji-btn" title="Sad">😢</button>
            <button class="emoji-btn" title="Goodbye">👋</button>
            <button class="emoji-btn" title="Splash">💦</button>
            <button class="emoji-btn" title="Paper">🧻</button>
            <button class="emoji-btn" title="Thumbs Up">👍</button>
            <button class="emoji-btn" title="Fire">🔥</button>
            <button class="emoji-btn" title="Happy">😄</button>
            <button class="emoji-btn" title="Cool">😎</button>
            <button class="emoji-btn" title="Party">🥳</button>
            <button class="emoji-btn" title="Perfect">💯</button>
            <button class="emoji-btn" title="Sparkles">✨</button>
            <button class="emoji-btn" title="Handshake">🤝</button>
          </div>
          
          <!-- NEW: Timestamp Button -->
          <button id="timestamp-btn" class="emoji-btn" title="Share current video timestamp">⏱️</button>
        </div>
        
        
        <div style="padding: 0 .5rem .5rem .5rem;">
          <form id="chat-form" style="display: flex;">
            <input type="text" id="chat-input" placeholder="Type..." autocomplete="off" required />
          </form>
        </div>
      </footer>
    </div>

    <div id="compact-view" title="Open Couch">
      <div id="compact-messages"></div>
    </div>
  </section>
  <button id="edge-tab" type="button" title="Show Couch" aria-label="Show Couch">‹</button>
`;
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
  viewToggleBtn.textContent = isCompactView ? '▼' : '▲';
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
  edgeTab.textContent = edge === 'left' ? '›' : '‹';
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
  if (dockedEdge) {
    hostContainer.style.left = dockedEdge === 'left'
      ? '12px'
      : `${window.innerWidth - hostContainer.offsetWidth - 12}px`;
    return;
  }

  const rect = hostContainer.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const edgeGap = 12;
  const atLeftEdge = rect.left <= edgeGap;
  const atRightEdge = viewportWidth - rect.right <= edgeGap;
  const edges = [
    { name: 'top', distance: rect.top },
    { name: 'left', distance: rect.left },
    { name: 'right', distance: viewportWidth - rect.right }
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
    if (atLeftEdge) setDockedEdge('left');
  } else {
    hostContainer.style.left = `${viewportWidth - rect.width - edgeGap}px`;
    hostContainer.style.top = `${currentTop}px`;
    if (atRightEdge) setDockedEdge('right');
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

function appendMessage(sender, text) {
  const rowDiv = document.createElement('div');
  rowDiv.className = 'message-row';

  const messageContent = document.createElement('span');
  messageContent.className = 'message-content';
  if (isSingleEmoji(text)) messageContent.classList.add('emoji-only');

  const compactRow = document.createElement('div');
  compactRow.className = 'compact-message';
  compactRow.textContent = `${sender}: ${text}`;

  if (sender === 'System') {
    rowDiv.classList.add('system');
    messageContent.textContent = text;
    rowDiv.appendChild(messageContent);
  } else if (sender === 'You' || sender === myUsername) {
    rowDiv.classList.add('right');
    messageContent.appendChild(buildLinkifiedText(text));
    rowDiv.appendChild(messageContent);
  } else {
    rowDiv.classList.add('left');
    const isHost = sender === currentHost;
    const senderLabel = createSenderLabel(sender, isHost);
    const labelSeparator = document.createTextNode(': ');

    rowDiv.appendChild(senderLabel);
    rowDiv.appendChild(labelSeparator);
    messageContent.appendChild(buildLinkifiedText(text));
    rowDiv.appendChild(messageContent);
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

function emitLocalChatMessage(text) {
  const trimmedText = String(text ?? '').trim();
  if (!trimmedText || !currentRoom) return;

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
const joinRoomInput = shadow.getElementById('join-room-input');
const joinRoomBtn = shadow.getElementById('join-room-btn');
const joinRoomForm = shadow.getElementById('join-room-form');
const joinError = shadow.getElementById('join-error');
const usernameInput = shadow.getElementById('username-input');
const createRoomBtn = shadow.getElementById('create-room-btn');
const createRoomForm = shadow.getElementById('create-room-form');
const displayHostName = shadow.getElementById('display-host-name');

function updateLobbyButtons() {
  const hasUsername = usernameInput.value.trim();
  const hasRoomCode = joinRoomInput.value.trim();

  createRoomBtn.disabled = !hasUsername;
  joinRoomBtn.disabled = !hasUsername || !hasRoomCode;
}

usernameInput.addEventListener('input', updateLobbyButtons);
joinRoomInput.addEventListener('input', updateLobbyButtons);

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
  chrome.storage.local.set({ couch_username: myUsername });
}

function showRoom(roomId) {
  currentRoom = roomId;
  displayRoomId.textContent = currentRoom;
  lobbyView.style.display = 'none';
  chatContainer.style.display = isCompactView ? 'none' : 'flex';

  if (hookedVideo?.readyState >= 1) {
    announceMediaChange(hookedVideo);
  }
}

function joinRoom(roomId, action = 'join') {
  joinRoomBtn.disabled = true;
  joinError.textContent = '';

  socket.emit('join-room', { roomId, username: myUsername, action }, (response) => {
    joinRoomBtn.disabled = false;

    if (response.success) {
      showRoom(roomId);
      joinRoomInput.value = '';
      chrome.storage.local.set({ couch_room: roomId });
      return;
    }

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

createRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();

  if (joinRoomInput.value.trim()) {
    joinRoomForm.requestSubmit();
    return;
  }

  createRoom();
});

joinRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (joinRoomBtn.disabled) return;

  const code = joinRoomInput.value.trim();
  captureAndSaveUsername();
  joinRoom(code);
});

const leaveRoomBtn = shadow.getElementById('leave-room-btn');

// --- FEATURE 3: LEAVING A ROOM ---
leaveRoomBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  socket.emit('leave-room', { roomId: currentRoom, username: myUsername });

  clearChatHistory();
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

// Helper to format seconds into M:SS or H:MM:SS
function formatTimestamp(seconds) {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const secondsText = secs.toString().padStart(2, '0');

  return hours > 0
    ? `${hours}:${mins.toString().padStart(2, '0')}:${secondsText}`
    : `${mins}:${secondsText}`;
}

// --- FEATURE: SHARE VIDEO TIMESTAMP ---
timestampBtn.addEventListener('click', () => {
  const video = findVideoElement();
  const timeString = formatTimestamp(video?.currentTime || 0);
  const messageText = `⏱️ ${timeString}`;

  emitLocalChatMessage(messageText);
});

const copyCodeBtn = shadow.getElementById('copy-code-btn');

copyCodeBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  navigator.clipboard.writeText(currentRoom).then(() => {
    copyCodeBtn.textContent = '✓';
    setTimeout(() => {
      copyCodeBtn.textContent = '📋';
    }, 2000);
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
  appendMessage(data.sender, data.text);
  highlightNewMessage();
});
socket.on('sync-room', (state) => {
  currentHost = state.host;
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
  state.chatHistory.forEach((msg) => appendMessage(msg.sender, msg.text));
});

socket.on('update-host', ({ newHost }) => {
  currentHost = newHost;

  if (displayHostName) {
    displayHostName.textContent = newHost;
    console.log(`Host title transferred to: ${newHost}`);
  }
});

sessionReady.then((savedRoom) => {
  if (savedRoom) joinRoom(savedRoom);
});
// 1. Setup Variables
const socket = io('http://localhost:3000');
let isRemoteUpdate = false;
let myUsername = '';
let currentRoom = null; // Starts null! We are in the lobby.
let currentHost = null; // Track current room host

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
function findVideoElement() {
  const video = document.querySelector("body > div:nth-child(1) > div.app-shell > div > div > video") || document.querySelector('video');

  return video;
}

let hookedVideo = null;
let pendingVideoState = null;

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

  video.addEventListener('play', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('play-video', { roomId: currentRoom, timestamp: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('pause-video', { roomId: currentRoom, timestamp: video.currentTime });
  });

  video.addEventListener('seeked', () => {
    if (!currentRoom || isRemoteUpdate || video !== hookedVideo) return;
    socket.emit('seek-video', { roomId: currentRoom, timestamp: video.currentTime });
  });

  if (pendingVideoState) {
    if (pendingVideoState.status === 'seeking') {
      applyVideoTime(video, pendingVideoState.timestamp);
    } else {
      applyVideoState(video, pendingVideoState);
    }
    pendingVideoState = null;
  }
}

setInterval(() => hookVideo(findVideoElement()), 500);

socket.on('play-video', (data) => {
  const video = findVideoElement();
  pendingVideoState = { status: 'playing', timestamp: data.timestamp };
  if (video) applyVideoState(video, pendingVideoState);
});

socket.on('pause-video', (data) => {
  const video = findVideoElement();
  pendingVideoState = { status: 'paused', timestamp: data.timestamp };
  if (video) applyVideoState(video, pendingVideoState);
});

socket.on('seek-video', (data) => {
  const video = findVideoElement();
  pendingVideoState = { status: 'seeking', timestamp: data.timestamp };
  if (video) applyVideoTime(video, data.timestamp);
});


// 3. UI Injection (Draggable + Semantic HTML)
const hostContainer = document.createElement('div');
hostContainer.id = 'couch';
hostContainer.style.cssText = `
  position: fixed; top: 20px; right: 20px; width: 250px;
  z-index: 9999999; background-color: rgb(255 255 255 / 10%);
  backdrop-filter: blur(20px); border-radius: 12px; padding: .5rem;
`;

const shadow = hostContainer.attachShadow({ mode: 'open' });
shadow.innerHTML = `
  <style>
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
      background-color: black;
    }

    .btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .btn.danger {
      background-color: #ef4444;
    }

    .btn.small {
      font-size: 0.6rem;
    }

    header { 
      cursor: grab; 
      padding: 5px; 
      user-select: none; 
      font-family: sans-serif;
    }
    header:active { cursor: grabbing; }

    /* Lobby Styles */
    #lobby {
      padding: 15px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    
    /* Chat Container Styles */
    #chat-container { 
      display: none; 
      flex-direction: column; 
    }

    .room-header { 
      font-size: 12px; 
      padding: 4px 5px; 
      border-top: 1px solid rgb(255 255 255 / 10%);
      border-bottom: 1px solid rgb(255 255 255 / 10%);
      font-family: monospace; 
      display: flex; 
      justify-content: space-between;
      align-items: center;
    }

    /* Message List & Scrollable Area */
    #messages {
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
  </style>
  <section>
    <header id="drag-handle">⠿ Couch</header>
    
    <!-- LOBBY VIEW -->
    <div id="lobby">
      <!-- UPDATED: Username section without a separate button -->
      <input type="text" id="username-input" placeholder="Username" autocomplete="off" style="margin-bottom: .5rem;"/>
      <button id="create-room-btn" class="btn">Create New Room</button>

      <div style="display: flex; gap: 6px;">
        <input type="text" id="join-room-input" placeholder="Room Code" autocomplete="off"/>
        <button id="join-room-btn" class="btn">Join</button>
      </div>
      <div id="join-error" style="color: red; font-size: 12px; height: 14px;"></div>
    </div>

    <!-- CHAT VIEW -->
    <div id="chat-container">
      <div class="room-header" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; font-size: 12px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>Room: <strong id="display-room-id">...</strong></span>
          <!-- NEW: Copy Room Code Button -->
          <button id="copy-code-btn" style="background: none; border:none; cursor: pointer; font-size: 10px;" title="Copy Room Code">📋</button>
        </div>
        <button id="leave-room-btn" class="btn small danger">Leave</button>
      </div>
      <main><ul id="messages"></ul></main>
      <footer>
        <!-- Toolbar containing Emojis and Timestamp Button -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px;">
          <div id="emoji-bar" style="display: flex; gap: 6px;">
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Laugh">😆</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Heart">♥️</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Splash">💦</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Surprise">😲</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Clap">👏</button>
          </div>
          
          <!-- NEW: Timestamp Button -->
          <button id="timestamp-btn" class="btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Share current video timestamp">⏱️</button>
        </div>
        
        <form id="chat-form" style="display: flex; gap: 5px;">
          <input type="text" id="chat-input" placeholder="Type..." autocomplete="off" required />
        </form>
      </footer>
    </div>
  </section>
`;
document.body.appendChild(hostContainer);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'toggle-chat') return;

  hostContainer.style.display = hostContainer.style.display === 'none' ? 'block' : 'none';
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

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  hostContainer.style.right = 'auto';
  hostContainer.style.bottom = 'auto';
  hostContainer.style.left = `${e.clientX - dragStartX}px`;
  hostContainer.style.top = `${e.clientY - dragStartY}px`;
});

document.addEventListener('mouseup', () => isDragging = false);

// 5. Chat Logic
const messageList = shadow.getElementById('messages');
const chatForm = shadow.getElementById('chat-form');
const chatInput = shadow.getElementById('chat-input');

function appendMessage(sender, text) {
  const messageList = shadow.getElementById('messages');
  const rowDiv = document.createElement('div');
  rowDiv.className = 'message-row';

  // 1. System Announcements
  if (sender === 'System') {
    rowDiv.classList.add('system');
    rowDiv.textContent = text;
  } 
  // 2. Current User Messages
  else if (sender === 'You' || sender === myUsername) {
    rowDiv.classList.add('right');
    rowDiv.textContent = text;
  } 
  // 3. Other Users' Messages
  else {
    rowDiv.classList.add('left');
    const isHost = (sender === currentHost);
    let senderHTML = `<b>${sender}</b>`;
    if (isHost) {
      senderHTML += ` <b><i>(host)</i></b>`;
    }
    rowDiv.innerHTML = `${senderHTML}: ${text}`;
  }

  messageList.appendChild(rowDiv);

  // Directly scroll the message list to the bottom
  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

const lobbyView = shadow.getElementById('lobby');
const chatContainer = shadow.getElementById('chat-container');
const createRoomBtn = shadow.getElementById('create-room-btn');
const displayRoomId = shadow.getElementById('display-room-id');
const joinRoomInput = shadow.getElementById('join-room-input');
const joinRoomBtn = shadow.getElementById('join-room-btn');
const joinError = shadow.getElementById('join-error');
const usernameInput = shadow.getElementById('username-input');
const displayHostName = shadow.getElementById('display-host-name');

function updateLobbyButtons() {
  createRoomBtn.disabled = !usernameInput.value.trim();
  joinRoomBtn.disabled = !joinRoomInput.value.trim() || !usernameInput.value.trim();
}

usernameInput.addEventListener('input', updateLobbyButtons);
joinRoomInput.addEventListener('input', updateLobbyButtons);

// Grab the emoji bar element
const emojiBar = shadow.getElementById('emoji-bar');

// --- FEATURE 5: QUICK EMOJI BUTTONS ---
emojiBar.addEventListener('click', (e) => {
  // Check if the clicked target is one of our emoji buttons
  if (e.target.classList.contains('emoji-btn')) {
    const emoji = e.target.textContent;
    if (!currentRoom) return;

    // Immediately display and emit the emoji as a chat message
    appendMessage('You', emoji);
    socket.emit('send-message', { roomId: currentRoom, username: myUsername, text: emoji });
  }
});

// Helper function to capture username changes right before entering a room
function captureAndSaveUsername() {
  const typedName = usernameInput.value.trim();
  if (typedName) {
    myUsername = typedName;
    chrome.storage.local.set({ couch_username: myUsername });
  }
}

function showRoom(roomId) {
  currentRoom = roomId;
  displayRoomId.textContent = currentRoom;
  lobbyView.style.display = 'none';
  chatContainer.style.display = 'flex';
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
    } else if (action === 'join') {
      joinError.textContent = response.message;
    }
  });
}

// --- FEATURE 1: CREATING A ROOM ---
createRoomBtn.addEventListener('click', () => {
  if (createRoomBtn.disabled) return;

  captureAndSaveUsername();
  const newCode = generateRoomCode();
  joinRoom(newCode, 'create');
  currentHost = myUsername;
  const displayHostName = shadow.getElementById('display-host-name');
  if (displayHostName) displayHostName.textContent = currentHost;
});

// --- FEATURE 2: JOINING A ROOM ---
joinRoomBtn.addEventListener('click', () => {
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

  messageList.innerHTML = '';
  currentRoom = null;
  chrome.storage.local.remove('couch_room');
  updateLobbyButtons();

  // Re-populate the input with the active username when returning to the lobby
  usernameInput.value = myUsername;

  chatContainer.style.display = 'none';
  lobbyView.style.display = 'flex';
  displayRoomId.textContent = '...';
});

// Grab the new timestamp elements
const timestampBtn = shadow.getElementById('timestamp-btn');

// Helper to format seconds into MM:SS
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// --- FEATURE: SHARE VIDEO TIMESTAMP ---
timestampBtn.addEventListener('click', () => {
  const video = findVideoElement();

  const timeString = formatTimestamp(video?.currentTime || 0);
  const messageText = `⏱️ ${timeString}`;

  appendMessage('You', messageText);
  socket.emit('send-message', { roomId: currentRoom, username: myUsername, text: messageText });
});

// Grab the new copy button
const copyCodeBtn = shadow.getElementById('copy-code-btn');

// --- FEATURE: COPY ROOM CODE TO CLIPBOARD ---
copyCodeBtn.addEventListener('click', () => {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom).then(() => {
    copyCodeBtn.textContent = '✓';
    setTimeout(() => { copyCodeBtn.textContent = '📋'; }, 2000);
  });
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  
  appendMessage('You', text);
  socket.emit('send-message', { roomId: currentRoom, username: myUsername, text: text });
  chatInput.value = '';
});

socket.on('new-message', (data) => appendMessage(data.sender, data.text));
socket.on('sync-room', (state) => {
  currentHost = state.host;
  pendingVideoState = state.video || null;
  const video = findVideoElement();
  if (video && pendingVideoState) {
    applyVideoState(video, pendingVideoState);
    pendingVideoState = null;
  }

  const displayHostName = shadow.getElementById('display-host-name');
  if (displayHostName) displayHostName.textContent = currentHost;
  
  // Render existing chat history...
  messageList.innerHTML = '';
  state.chatHistory.forEach(msg => appendMessage(msg.sender, msg.text));
});

socket.on('update-host', ({ newHost }) => {
  currentHost = newHost;
  const displayHostName = shadow.getElementById('display-host-name');
  if (displayHostName) {
    displayHostName.textContent = newHost;
    console.log(`Host title transferred to: ${newHost}`);
  }

  // Re-render chat messages so the new host gets the (host) tag on their past messages too!
  // (Assuming you store chat messages or fetch them from room state. If using sync-room, it will refresh automatically)
});

sessionReady.then((savedRoom) => {
  if (savedRoom) joinRoom(savedRoom);
});
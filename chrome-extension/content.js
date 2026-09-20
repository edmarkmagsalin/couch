// 1. Setup Variables
const socket = io('http://localhost:3000');
let isRemoteUpdate = false;
// Retrieve saved username from localStorage or generate a new one
let myUsername = localStorage.getItem('couch_username') || ('User_' + Math.floor(Math.random() * 1000));
localStorage.setItem('couch_username', myUsername);
let currentRoom = null; // Starts null! We are in the lobby.
let currentHost = null; // Track current room host

// Helper to generate a random 6-character room code (e.g., "x7b9kq")
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8);
}
// 2. Video Hijacking Logic
function findVideoElement() {
  const video = document.querySelector("body > div:nth-child(1) > div.app-shell > div > div > video") || document.querySelector('video');

  if (!video) {
    console.log("Watch Party: No video element found yet.");
    return null;
  }
  return video;
}

// We wrap the video logic in a small delay (1 second) to give modern 
// websites time to dynamically load their video elements before we hook into them.
setTimeout(() => {
  const video = findVideoElement();

  if (video) {
    console.log("Watch Party: Video element found and hooked!");
    
    // Local Video -> Server
    video.addEventListener('play', () => {
      if (!currentRoom || isRemoteUpdate) return;
      socket.emit('play-video', { roomId: currentRoom, timestamp: video.currentTime });
    });

    video.addEventListener('pause', () => {
      if (!currentRoom || isRemoteUpdate) return;
      socket.emit('pause-video', { roomId: currentRoom, timestamp: video.currentTime });
    });

    video.addEventListener('seeked', () => {
      if (!currentRoom || isRemoteUpdate) return;
      socket.emit('seek-video', { roomId: currentRoom, timestamp: video.currentTime });
    });

    // Server -> Local Video
    socket.on('play-video', (data) => {
      isRemoteUpdate = true;
      if (Math.abs(video.currentTime - data.timestamp) > 0.5) {
        video.currentTime = data.timestamp;
      }
      video.play().then(() => isRemoteUpdate = false)
        .catch(e => console.error("Watch Party Autoplay blocked:", e));
    });

    socket.on('pause-video', (data) => {
      isRemoteUpdate = true;
      video.currentTime = data.timestamp;
      video.pause();
      setTimeout(() => { isRemoteUpdate = false; }, 50);
    });

    socket.on('seek-video', (data) => {
      isRemoteUpdate = true;
      video.currentTime = data.timestamp;
      setTimeout(() => { isRemoteUpdate = false; }, 50);
    });
  }
}, 1000); // 1000ms delay


// 3. UI Injection (Draggable + Semantic HTML)
const hostContainer = document.createElement('div');
hostContainer.id = 'watch-party-host';
hostContainer.style.cssText = `
  position: fixed; top: 20px; right: 20px; width: 250px;
  z-index: 9999999; background: white; color: black;
  border: 1px solid black; opacity: 0.7;
`;

hostContainer.addEventListener('mouseenter', () => hostContainer.style.opacity = '1');
hostContainer.addEventListener('mouseleave', () => hostContainer.style.opacity = '0.7');

const shadow = hostContainer.attachShadow({ mode: 'open' });
shadow.innerHTML = `
  <style>
    header { 
      cursor: grab; 
      border-bottom: 1px solid black; 
      padding: 5px; 
      user-select: none; 
      font-family: sans-serif; 
      background: #f3f4f6; 
    }
    header:active { cursor: grabbing; }
    
    /* Lobby Styles */
    #lobby { 
      padding: 15px; 
      display: flex; 
      flex-direction: column; 
      gap: 10px; 
      font-family: sans-serif; 
    }
    
    .btn { 
      padding: 8px; 
      cursor: pointer; 
      background: black; 
      color: white; 
      border: none; 
      border-radius: 4px; 
    }
    
    /* Chat Container Styles */
    #chat-container { 
      display: none; 
      flex-direction: column; 
    }

    .room-header { 
      font-size: 12px; 
      padding: 4px 5px; 
      background: #e5e7eb; 
      border-bottom: 1px solid black; 
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
      height: 200px;
      max-height: 200px;
      overflow-y: auto;
      
      /* Hide scrollbar for Chrome, Safari, Opera, and Firefox */
      scrollbar-width: none; 
    }

    #messages::-webkit-scrollbar {
      display: none; 
    }

    /* Message Row Alignments (Plain Text) */
    .message-row {
      display: flex;
      width: 100%;
      font-size: 12px;
      word-break: break-word;
    }

    .message-row.left {
      justify-content: flex-start;
      text-align: left;
      color: #1f2937;
    }

    .message-row.right {
      justify-content: flex-end;
      text-align: right;
      color: #2563eb;
    }

    .message-row.system {
      justify-content: center;
      text-align: center;
      color: #9ca3af;
      font-style: italic;
      font-size: 11px;
    }

    /* Footer & Inputs */
    footer { 
      border-top: 1px solid black; 
      padding: 5px; 
    }
    
    form { 
      display: flex; 
    }
    
    input { 
      flex-grow: 1; 
      font-family: sans-serif; 
      padding: 4px; 
    }
  </style>
  <section>
    <header id="drag-handle">⠿ Couch</header>
    
    <!-- LOBBY VIEW -->
    <div id="lobby">
      <p style="margin: 0; font-size: 14px;">Welcome to Couch!</p>
      
      <!-- UPDATED: Username section without a separate button -->
      <div style="margin: 8px 0; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 11px; color: #4b5563;">Your Username:</label>
        <input type="text" id="username-input" autocomplete="off" style="padding: 4px; font-family: sans-serif;" />
      </div>

      <button id="create-room-btn" class="btn">Create New Room</button>
      
      <div style="margin: 10px 0; text-align: center; font-size: 12px; color: #6b7280;">OR</div>
      
      <div style="display: flex; flex-direction: column; gap: 5px;">
        <div style="display: flex; gap: 5px;">
          <input type="text" id="join-room-input" placeholder="Room Code" autocomplete="off" />
          <button id="join-room-btn" class="btn" style="background: #4b5563;">Join</button>
        </div>
        <div id="join-error" style="color: red; font-size: 12px; height: 14px;"></div>
      </div>
    </div>

    <!-- CHAT VIEW -->
    <div id="chat-container">
      <div class="room-header" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb; font-size: 12px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>Room: <strong id="display-room-id">...</strong></span>
          <!-- NEW: Copy Room Code Button -->
          <button id="copy-code-btn" style="background: none; border: 1px solid #d1d5db; border-radius: 3px; padding: 1px 4px; cursor: pointer; font-size: 10px;" title="Copy Room Code">📋</button>
        </div>
        <button id="leave-room-btn" style="background: #ef4444; color: white; border: none; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 11px;">Leave</button>
      </div>
      <main><ul id="messages"></ul></main>
      <footer>
        <!-- Toolbar containing Emojis and Timestamp Button -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">
          <div id="emoji-bar" style="display: flex; gap: 6px;">
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Laugh">😆</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Heart">♥️</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Splash">💦</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Surprise">😲</button>
            <button class="emoji-btn" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px; border-radius: 4px;" title="Clap">👏</button>
          </div>
          
          <!-- NEW: Timestamp Button -->
          <button id="timestamp-btn" class="btn" style="font-size: 11px; padding: 3px 6px; background: #4b5563;" title="Share current video timestamp">⏱️ Time</button>
        </div>

        <!-- Inline error message for the chatbox -->
        <div id="chat-error" style="color: red; font-size: 11px; padding: 2px 8px; height: 14px;"></div>
        
        <form id="chat-form" style="display: flex; gap: 5px;">
          <input type="text" id="chat-input" placeholder="Type..." autocomplete="off" required />
          <button type="submit" class="btn">Send</button>
        </form>
      </footer>
    </div>
  </section>
`;
document.body.appendChild(hostContainer);

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

// Prevent input fields from triggering background website video hotkeys (like Space pausing the video)
const allInputs = shadow.querySelectorAll('input');
allInputs.forEach(input => {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });
});

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

// Pre-fill input with last used username from localStorage
usernameInput.value = myUsername;

// Helper function to capture username changes right before entering a room
function captureAndSaveUsername() {
  const typedName = usernameInput.value.trim();
  if (typedName) {
    myUsername = typedName;
    localStorage.setItem('couch_username', myUsername);
  }
}

// --- FEATURE 1: CREATING A ROOM ---
createRoomBtn.addEventListener('click', () => {
  captureAndSaveUsername();
  const newCode = generateRoomCode();
  
  socket.emit('join-room', { roomId: newCode, username: myUsername, action: 'create' }, (response) => {
    if (response.success) {
      currentRoom = newCode;
      displayRoomId.textContent = currentRoom;
      
      // >>> PUT IT HERE <<<
      currentHost = myUsername;
      const displayHostName = shadow.getElementById('display-host-name');
      if (displayHostName) displayHostName.textContent = currentHost;

      lobbyView.style.display = 'none';
      chatContainer.style.display = 'flex';
    }
  });
});

// --- FEATURE 2: JOINING A ROOM ---
joinRoomBtn.addEventListener('click', () => {
  const code = joinRoomInput.value.trim();
  if (!code) return; 

  joinError.textContent = ''; 
  captureAndSaveUsername();

  socket.emit('join-room', { roomId: code, username: myUsername, action: 'join' }, (response) => {
    if (response.success) {
      currentRoom = code;
      displayRoomId.textContent = currentRoom;
      
      // >>> PUT IT HERE <<<
      currentHost = response.host;
      const displayHostName = shadow.getElementById('display-host-name');
      if (displayHostName) displayHostName.textContent = currentHost;

      lobbyView.style.display = 'none';
      chatContainer.style.display = 'flex';
      joinRoomInput.value = ''; 
    } else {
      joinError.textContent = response.message;
    }
  });
});

const leaveRoomBtn = shadow.getElementById('leave-room-btn');

// --- FEATURE 3: LEAVING A ROOM ---
leaveRoomBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  socket.emit('leave-room', { roomId: currentRoom, username: myUsername });

  messageList.innerHTML = '';
  currentRoom = null;

  // Re-populate the input with the active username when returning to the lobby
  usernameInput.value = myUsername;

  chatContainer.style.display = 'none';
  lobbyView.style.display = 'flex';
  displayRoomId.textContent = '...';
});

// Grab the new timestamp elements
const timestampBtn = shadow.getElementById('timestamp-btn');
const chatError = shadow.getElementById('chat-error');

// Helper to format seconds into MM:SS
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// --- FEATURE: SHARE VIDEO TIMESTAMP ---
timestampBtn.addEventListener('click', () => {
  chatError.textContent = '';
  const video = findVideoElement();

  if (!video) {
    chatError.textContent = 'No video is playing.';
    setTimeout(() => { chatError.textContent = ''; }, 3000); // Clears after 3 seconds
    return;
  }

  if (!currentRoom) {
    chatError.textContent = 'Join a room first.';
    setTimeout(() => { chatError.textContent = ''; }, 3000); // Clears after 3 seconds
    return;
  }

  const timeString = formatTimestamp(video.currentTime);
  const messageText = `⏱️ Timestamp: ${timeString}`;

  appendMessage('You', messageText);
  socket.emit('send-message', { roomId: currentRoom, username: myUsername, text: messageText });
});

// Grab the new copy button
const copyCodeBtn = shadow.getElementById('copy-code-btn');

// --- FEATURE: COPY ROOM CODE TO CLIPBOARD ---
copyCodeBtn.addEventListener('click', () => {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom).then(() => {
    copyCodeBtn.textContent = '✔️';
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
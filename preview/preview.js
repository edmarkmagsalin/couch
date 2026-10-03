const storage = {
  couch_username: new URLSearchParams(window.location.hash.slice(1)).get('username')?.trim() || 'Preview User'
};

const runtimeListeners = [];
const socketListeners = new Map();
const connectSocket = window.io;
let previewSocket;
let contentScriptLoaded = false;

const status = document.getElementById('status');
const previewVideo = document.querySelector('.fake-player video');
let videoError = Boolean(previewVideo.error);
const playbackButtons = [
  document.getElementById('simulate-remote-seek'),
  document.getElementById('simulate-remote-play'),
  document.getElementById('simulate-remote-pause')
];

function updatePreviewStatus() {
  if (videoError) {
    status.textContent = 'Could not load /preview/video.mp4. Add the sample video to enable playback simulation.';
  } else if (!previewVideo.readyState || previewVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
    status.textContent = contentScriptLoaded
      ? 'Extension ready. Waiting for /preview/video.mp4...'
      : 'Loading preview...';
  } else {
    status.textContent = 'Ready. Use the expand button in the Couch header.';
  }
}

function updatePlaybackAvailability() {
  videoError = Boolean(previewVideo.error);
  const hasVideo = previewVideo.readyState >= HTMLMediaElement.HAVE_METADATA
    && Number.isFinite(previewVideo.duration)
    && previewVideo.duration > 0;
  playbackButtons.forEach((button) => { button.disabled = !hasVideo; });
  updatePreviewStatus();
}

previewVideo.addEventListener('loadedmetadata', updatePlaybackAvailability);
previewVideo.addEventListener('error', updatePlaybackAvailability);
updatePlaybackAvailability();

window.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const selected = {};
        keys.forEach((key) => {
          if (storage[key] !== undefined) selected[key] = storage[key];
        });
        return selected;
      },
      set: async (values) => Object.assign(storage, values),
      remove: async (key) => delete storage[key]
    }
  },
  runtime: {
    getURL: (path) => `/chrome-extension/${path}`,
    onMessage: {
      addListener: (listener) => runtimeListeners.push(listener)
    }
  }
};

window.io = (...args) => {
  const socket = connectSocket(...args);
  previewSocket = socket;
  const subscribe = socket.on.bind(socket);
  socket.on = (event, listener) => {
    if (!socketListeners.has(event)) socketListeners.set(event, []);
    socketListeners.get(event).push(listener);
    return subscribe(event, listener);
  }
  return socket;
};

function dispatchSocketEvent(event, data) {
  (socketListeners.get(event) || []).forEach((listener) => listener(data));
}

function sendRuntimeMessage(message) {
  runtimeListeners.forEach((listener) => listener(message));
}

function loadContentScript() {
  const script = document.createElement('script');
  script.src = 'chrome-extension/content.js';
  script.onload = () => {
    contentScriptLoaded = true;
    updatePreviewStatus();
  };
  script.onerror = () => {
    status.textContent = 'Could not load chrome-extension/content.js.';
  };
  document.head.appendChild(script);
}

function shadowRoot() {
  return document.getElementById('couch')?.shadowRoot;
}

document.getElementById('simulate-message').addEventListener('click', () => {
  const roomId = storage.couch_room;
  const status = document.getElementById('status');

  if (!roomId) {
    status.textContent = 'Join a room before sending a preview message.';
    return;
  }

  if (!previewSocket?.connected) {
    status.textContent = 'Not connected to the room server. Please try again.';
    return;
  }

  const text = `Message ${new Date().toLocaleTimeString()}`;
  previewSocket.emit('send-message', {
    roomId,
    username: storage.couch_username,
    text
  });
  dispatchSocketEvent('new-message', {
    sender: storage.couch_username,
    text,
    time: Date.now()
  });
  status.textContent = `Sent "${text}" to room ${roomId}.`;
});

document.getElementById('simulate-remote-seek').addEventListener('click', () => {
  const timestamp = Math.min(42, previewVideo.duration / 2);
  dispatchSocketEvent('seek-video', { timestamp });
});

document.getElementById('simulate-remote-play').addEventListener('click', () => {
  dispatchSocketEvent('play-video', { timestamp: previewVideo.currentTime });
});

document.getElementById('simulate-remote-pause').addEventListener('click', () => {
  dispatchSocketEvent('pause-video', { timestamp: previewVideo.currentTime });
});

loadContentScript();

const storage = {
  couch_username: 'Preview User',
  couch_room: 'preview'
};

const runtimeListeners = [];
const socketListeners = new Map();

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
    onMessage: {
      addListener: (listener) => runtimeListeners.push(listener)
    }
  }
};

window.io = () => ({
  emit: (event, data, callback) => {
    if (event === 'join-room') {
      callback?.({ success: true, host: 'Preview User' });
      setTimeout(() => dispatchSocketEvent('sync-room', {
        host: 'Preview User',
        video: { status: 'paused', timestamp: 0 },
        chatHistory: [
          { sender: 'System', text: 'Preview room ready.', time: Date.now() }
        ]
      }), 0);
    }
  },
  on: (event, listener) => {
    if (!socketListeners.has(event)) socketListeners.set(event, []);
    socketListeners.get(event).push(listener);
  }
});

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
    document.getElementById('status').textContent = 'Ready. Use the expand button in the Couch header.';
  };
  script.onerror = () => {
    document.getElementById('status').textContent = 'Could not load chrome-extension/content.js.';
  };
  document.head.appendChild(script);
}

function shadowRoot() {
  return document.getElementById('couch')?.shadowRoot;
}

document.getElementById('simulate-message').addEventListener('click', () => {
  dispatchSocketEvent('new-message', {
    sender: 'Preview Friend',
    text: `Message ${new Date().toLocaleTimeString()}`,
    time: Date.now()
  });
});

document.getElementById('simulate-remote-seek').addEventListener('click', () => {
  dispatchSocketEvent('seek-video', { timestamp: 42 });
});

document.getElementById('simulate-remote-play').addEventListener('click', () => {
  dispatchSocketEvent('play-video', { timestamp: 42 });
});

document.getElementById('simulate-remote-pause').addEventListener('click', () => {
  dispatchSocketEvent('pause-video', { timestamp: 42 });
});

loadContentScript();

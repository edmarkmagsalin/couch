const storage = {
  couch_username: new URLSearchParams(window.location.hash.slice(1)).get('username')?.trim() || 'Preview User'
};

const runtimeListeners = [];
let contentScriptLoaded = false;

const status = document.getElementById('status');
const previewVideo = document.querySelector('.fake-player video');
let videoError = Boolean(previewVideo.error);

function updatePreviewStatus() {
  if (videoError) {
    status.textContent = 'Could not load /preview/video.mp4.';
  } else if (!previewVideo.readyState || previewVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
    status.textContent = contentScriptLoaded
      ? 'Extension ready. Waiting for /preview/video.mp4...'
      : 'Loading preview...';
  } else {
    status.textContent = 'Ready. Use the expand button in the Couch header.';
  }
}

function updateVideoStatus() {
  videoError = Boolean(previewVideo.error);
  updatePreviewStatus();
}

previewVideo.addEventListener('loadedmetadata', updateVideoStatus);
previewVideo.addEventListener('error', updateVideoStatus);
updateVideoStatus();

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

loadContentScript();

# Couch

Couch is a Chrome extension for watching videos together with friends in a shared room. Create a room, share a code, and sync playback, chat, and reactions in real time.

## Status

This project is a lightweight browser-based watch-party tool for shared viewing experiences.

## Features

- Shared watch rooms with invite codes
- Real-time video playback sync
- In-room chat and emoji reactions
- Static web remote for room chat and playback control
- Simple setup for manual or local installation

## Couch Remote frontend

The `frontend/` directory is a static web app that connects to the Couch API at `https://couch-sl1x.onrender.com`. It can be deployed to Render as a Static Site using the included `render.yaml` Blueprint.

Enter the same username used by the Chrome extension and join the same room code to see its chat and control its playback. Set the duration to the source video's length (for example, `1:32:12`) to enable the remote timeline, play, pause, and seek controls. Edit the current-time readout and press Enter to jump to a specific time; use `M:SS` or `H:MM:SS` within the configured duration. This page controls synchronized playback but does not host or play the source video.

The frontend saves the room, duration, playback state, and playhead locally, then restores them and reconnects to the last room after a refresh. Playback position is checkpointed while the page is open; a room's newer playback action takes precedence when available. Deploy the backend timestamp updates in `backend/server.js` to the API service so actions made while this page is closed can be identified as newer.

On Couch Remote, the chat panel appears in a card above the playback controller. Drag the grip beneath the chat history to resize it; the surrounding layout adjusts to its height, which is saved locally. In the Chrome extension, the chat panel remains floating: drag the grip to resize it, then drag the panel near an edge to snap or dock it.

The extension and remote page share the floating panel template and styles in `chrome-extension/panel.html` and `chrome-extension/panel.css`, plus emoji detection and timestamp formatting in `chrome-extension/couch-shared.js`. Render's build command copies these assets into the static publish directory.

To test the frontend locally, run `pnpm frontend:dev` and open `http://localhost:4173`. This prepares the shared assets and serves the static frontend; stop the server with `Ctrl+C`. Python 3 is required.

## Links

- Home page: https://edmarkmagsalin.github.io/couch/
- GitHub repository: https://github.com/edmarkmagsalin/couch
- Releases: https://github.com/edmarkmagsalin/couch/releases
- Privacy policy: https://edmarkmagsalin.github.io/couch/privacy/

## Install from a GitHub release

Download `couch-chrome-extension.zip` from the [latest GitHub release](https://github.com/edmarkmagsalin/couch/releases), then:

1. Extract the ZIP file.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the extracted `chrome-extension` folder. Do not select the ZIP file itself.
6. Confirm that **Couch** appears in the extensions list.

## How to use it

1. Open the Couch extension.
2. Choose a username.
3. Create a new room or join an existing one with a room code.
4. Watch the same video together and use the live chat while playback stays synced.

## Notes

Couch is designed for shared viewing experiences and is best used with a room of people who want to watch the same content together in sync.
# Couch

A small, local-first video player built with React and Vite.

## Run locally

From this directory, install dependencies with `pnpm install`, then start the development server with `pnpm dev`.

## Play a video

- Choose a local video file or drag it onto the player.
- Load or drop a local `.srt` subtitle file after loading a video, or drop one video and one SRT together. Their filenames do not need to match. The player converts SRT to WebVTT in your browser; use the native video controls to toggle captions.
- Paste a direct `http://` or `https://` video URL, such as an MP4 or WebM file.
- Videos attempt to play automatically after loading. If the browser blocks autoplay, press Play in the built-in controls.

## Restore media after reload

Couch stores the current video link, or a browser file handle for a local movie, in IndexedDB. It does not copy or store the movie's video data. Depending on browser permissions, restoring a local movie may require you to grant access again; browsers without file-handle support ask you to choose the same movie again. Loaded sidecar and extracted subtitles are stored locally as WebVTT and restored with that movie. Browser storage can be removed by clearing site data.

SRT files should be UTF-8. When loading an MKV, Couch checks its first embedded subtitle track and extracts it only when its Matroska codec is `S_TEXT/UTF8` or `S_TEXT/ASS`; other subtitle formats are left untouched. The subtitle is converted to WebVTT for the browser player. When an MKV has multiple audio tracks, Couch lists the detected language, codec, and default track and lets you select a track if the browser exposes native audio-track switching for that video. Audio is not extracted or remuxed; browsers without native switching support show the selector disabled. FFmpeg WebAssembly is loaded to inspect MKV streams and extract supported subtitles, but the video itself is passed directly to the browser without conversion. Its WebAssembly core is about 32 MB. MKV playback still depends on browser support for the container and its video/audio codecs. Large MKV files may take time to scan, although the app mounts the file without copying the entire file into WebAssembly memory.

The bundled FFmpeg core is licensed under GPL-2.0-or-later; review its license obligations before redistributing the app.

Local video files and direct video links use native browser playback. Supported formats depend on the browser. Video page links such as YouTube or Vimeo are not supported, and remote playback depends on whether the server allows the video to be loaded.

Run `pnpm build` to type-check and build the app, or `pnpm lint` to lint the frontend.

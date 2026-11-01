import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent, SyntheticEvent } from 'react'
import { Video, VideoPlayer, VideoSkin } from '@videojs/react/video'
import '@videojs/react/video/skin.css'
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import {
  chooseVideoFile,
  deleteSavedMedia,
  getDroppedVideoHandle,
  readSavedMedia,
  saveMedia,
  supportsVideoFilePicker,
  type PersistedMedia,
  type VideoFileHandle,
} from './mediaPersistence'
import couchLogo from './assets/couch.svg'
import './App.css'

type MediaSource = {
  src: string
  title: string
  kind: 'file' | 'link'
  handle?: VideoFileHandle
  fileSize?: number
  fileLastModified?: number
}

type SubtitleTrack = {
  src: string
  label: string
  blob: Blob
}

const videoFileExtension = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|avi)$/i

function createSubtitleTrack(blob: Blob, label: string): SubtitleTrack {
  return {
    src: URL.createObjectURL(blob),
    label,
    blob,
  }
}

function isVideoFile(file: File) {
  return file.type.startsWith('video/') || videoFileExtension.test(file.name)
}

function isSubtitleFile(file: File) {
  const name = file.name.toLowerCase()
  return name.endsWith('.srt')
}

function convertSrtToVtt(srt: string) {
  const normalizedSrt = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const cuePattern = /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}(?:\s+.*)?$/gm
  const timestampPattern = /\d{2}:\d{2}:\d{2},\d{3}/g

  if (!cuePattern.test(normalizedSrt)) {
    throw new Error('This SRT file contains no valid subtitle cues.')
  }

  return `WEBVTT\n\n${normalizedSrt.replace(timestampPattern, (timestamp) => timestamp.replace(',', '.'))}\n`
}

function App() {
  const [media, setMedia] = useState<MediaSource | null>(null)
  const [subtitle, setSubtitle] = useState<SubtitleTrack | null>(null)
  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState('')
  const [playerError, setPlayerError] = useState('')
  const [playerNotice, setPlayerNotice] = useState('')
  const [subtitleError, setSubtitleError] = useState('')
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isNavOpen, setIsNavOpen] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<PersistedMedia | null>(null)
  const [persistenceReady, setPersistenceReady] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const subtitleInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const autoplayAttemptedFor = useRef<string | null>(null)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const subtitleExtractionId = useRef(0)
  const restoreCancelled = useRef(false)

  useEffect(() => {
    if (media?.kind === 'file') {
      return () => URL.revokeObjectURL(media.src)
    }
  }, [media])

  useEffect(() => () => {
    subtitleExtractionId.current += 1
    ffmpegRef.current?.terminate()
    ffmpegRef.current = null
  }, [])

  useEffect(() => {
    if (subtitle) return () => URL.revokeObjectURL(subtitle.src)
  }, [subtitle])

  useEffect(() => {
    let cancelled = false
    void readSavedMedia()
      .then(async (saved) => {
        if (!saved || cancelled || restoreCancelled.current) return
        if (saved.kind === 'link') {
          setMedia({ src: saved.src, title: saved.title, kind: 'link' })
          setUrl(saved.src)
          setSubtitle(saved.subtitle ? createSubtitleTrack(saved.subtitle.blob, saved.subtitle.label) : null)
          return
        }

        setPendingRestore(saved)
        const permission = saved.handle
          ? await saved.handle.queryPermission?.({ mode: 'read' })
          : undefined
        if (cancelled || restoreCancelled.current) return
        if (permission === 'granted' && saved.handle) {
          const file = await saved.handle.getFile()
          if (cancelled || restoreCancelled.current) return
          const subtitleMatchesFile =
            file.size === saved.size && file.lastModified === saved.lastModified
          setMedia({
            src: URL.createObjectURL(file),
            title: file.name,
            kind: 'file',
            handle: saved.handle,
            fileSize: file.size,
            fileLastModified: file.lastModified,
          })
          setSubtitle(
            subtitleMatchesFile && saved.subtitle
              ? createSubtitleTrack(saved.subtitle.blob, saved.subtitle.label)
              : null,
          )
          setPendingRestore(null)
          if (saved.subtitle && !subtitleMatchesFile) {
            setPlayerNotice('The movie changed since the subtitle was saved, so the old subtitle was not restored.')
          }
          if ((!saved.subtitle || !subtitleMatchesFile) && /\.mkv$/i.test(file.name)) {
            const requestId = subtitleExtractionId.current
            setPlayerNotice('Checking for supported embedded subtitles…')
            void extractMkvSubtitle(file, requestId)
          }
          return
        }

        setPlayerNotice(
          saved.handle
            ? 'A saved movie is ready to restore. Choose Restore saved movie to grant access.'
            : 'Choose the saved movie again to restore it. The video itself was not stored.',
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPlayerError(error instanceof Error ? error.message : `Could not restore saved media: ${String(error)}`)
        }
      })
      .finally(() => {
        if (!cancelled) setPersistenceReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!persistenceReady || !media) return

    const save = media.kind === 'link'
      ? saveMedia({
          kind: 'link',
          src: media.src,
          title: media.title,
          subtitle: subtitle ? { blob: subtitle.blob, label: subtitle.label } : null,
        })
      : saveMedia({
          kind: 'file',
          handle: media.handle ?? null,
          title: media.title,
          size: media.fileSize ?? 0,
          lastModified: media.fileLastModified ?? 0,
          subtitle: subtitle ? { blob: subtitle.blob, label: subtitle.label } : null,
        })
    void save.catch((error: unknown) => {
      setPlayerError(error instanceof Error ? error.message : `Could not save media details: ${String(error)}`)
    })
  }, [media, subtitle, persistenceReady])

  useEffect(() => {
    const hasMessage = Boolean(playerError || subtitleError || playerNotice || autoplayBlocked)
    if (!hasMessage) return

    const timer = window.setTimeout(() => {
      setPlayerError('')
      setSubtitleError('')
      setPlayerNotice('')
      setAutoplayBlocked(false)
    }, 10000)

    return () => window.clearTimeout(timer)
  }, [playerError, subtitleError, playerNotice, autoplayBlocked])

  function cancelSubtitleExtraction() {
    subtitleExtractionId.current += 1
    ffmpegRef.current?.terminate()
    ffmpegRef.current = null
  }

  function loadFile(file: File, extractEmbeddedSubtitles = true, handle?: VideoFileHandle) {
    if (!file.type.startsWith('video/') && !videoFileExtension.test(file.name)) {
      setPlayerError('Choose a video file to start watching.')
      return
    }

    restoreCancelled.current = true
    const saved = pendingRestore?.kind === 'file' &&
      pendingRestore.title === file.name &&
      pendingRestore.size === file.size &&
      pendingRestore.lastModified === file.lastModified
      ? pendingRestore
      : null
    cancelSubtitleExtraction()
    setUrlError('')
    setPlayerError('')
    setSubtitleError('')
    setPlayerNotice(
      handle
        ? ''
        : 'This movie was opened without a persistent file handle. Choose it using Choose a file to restore it after reloading.',
    )
    setAutoplayBlocked(false)
    autoplayAttemptedFor.current = null
    setPendingRestore(null)
    setSubtitle(saved?.subtitle ? createSubtitleTrack(saved.subtitle.blob, saved.subtitle.label) : null)
    setMedia({
      src: URL.createObjectURL(file),
      title: file.name,
      kind: 'file',
      handle,
      fileSize: file.size,
      fileLastModified: file.lastModified,
    })

    if (extractEmbeddedSubtitles && !saved?.subtitle && /\.mkv$/i.test(file.name)) {
      const requestId = subtitleExtractionId.current
      setPlayerNotice('Checking for supported embedded subtitles…')
      void extractMkvSubtitle(file, requestId)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (file) loadFile(file)
    event.currentTarget.value = ''
  }

  async function handleChooseFile() {
    if (!supportsVideoFilePicker()) {
      fileInputRef.current?.click()
      return
    }

    try {
      const chosen = await chooseVideoFile()
      if (chosen) {
        loadFile(chosen.file, true, chosen.handle)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setPlayerError(error instanceof Error ? error.message : `Could not open the video file: ${String(error)}`)
    }
  }

  function clearCurrentMedia() {
    restoreCancelled.current = true
    setPendingRestore(null)
    setUrl('')
    setUrlError('')
    setPlayerError('')
    setSubtitleError('')
    setPlayerNotice('Current media and subtitle removed.')
    setAutoplayBlocked(false)
    autoplayAttemptedFor.current = null
    cancelSubtitleExtraction()
    setSubtitle(null)
    setMedia(null)
    void deleteSavedMedia().catch((error: unknown) => {
      setPlayerError(error instanceof Error ? error.message : 'Could not clear saved media.')
    })
  }

  function handleUrlSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedUrl = url.trim()
    let parsedUrl: URL

    try {
      parsedUrl = new URL(trimmedUrl)
    } catch {
      setUrlError('Enter a valid link to a video file.')
      return
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      setUrlError('Video links must start with http:// or https://.')
      return
    }

    restoreCancelled.current = true
    setPendingRestore(null)
    setUrlError('')
    setPlayerError('')
    setSubtitleError('')
    setPlayerNotice('')
    setAutoplayBlocked(false)
    autoplayAttemptedFor.current = null
    cancelSubtitleExtraction()
    setSubtitle(null)
    setMedia({
      src: parsedUrl.href,
      title: parsedUrl.pathname.split('/').filter(Boolean).at(-1) || parsedUrl.hostname,
      kind: 'link',
    })
  }

  async function loadSubtitleFile(file: File) {
    if (!file) return

    cancelSubtitleExtraction()
    setPlayerNotice('')
    setSubtitleError('')
    if (!media) {
      setPlayerError('Load a video before choosing its subtitle file.')
      return
    }

    if (!isSubtitleFile(file)) {
      setPlayerError('Choose an SRT subtitle file.')
      return
    }

    try {
      setSubtitle(await createSubtitleFromSrt(file))
      setPlayerError('')
      setPlayerNotice('Subtitles loaded. Use the video controls to turn captions on or off.')
    } catch (error) {
      setPlayerError(error instanceof Error ? error.message : 'Could not read this subtitle file.')
    }
  }

  async function createSubtitleFromSrt(file: File): Promise<SubtitleTrack> {
    const webVtt = convertSrtToVtt(await file.text())
    return createSubtitleTrack(new Blob([webVtt], { type: 'text/vtt' }), file.name.replace(/\.srt$/i, ''))
  }

  function handleSubtitleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void loadSubtitleFile(file)
  }

  async function extractMkvSubtitle(file: File, requestId: number) {
    const ffmpeg = new FFmpeg()
    ffmpegRef.current = ffmpeg
    const inputName = 'input.mkv'
    const inputPath = `/input/${inputName}`
    const outputName = 'subtitle.vtt'
    const logs: string[] = []
    const onLog = ({ message }: { message: string }) => {
      logs.push(message)
      if (logs.length > 100) logs.shift()
    }
    const currentRequest = () => subtitleExtractionId.current === requestId

    ffmpeg.on('log', onLog)
    try {
      await ffmpeg.load({ coreURL, wasmURL })
      if (!currentRequest()) return

      await ffmpeg.createDir('/input')
      const mounted = await ffmpeg.mount(
        FFFSType.WORKERFS,
        { blobs: [{ name: inputName, data: file }] },
        '/input',
      )
      if (!mounted) throw new Error('The MKV file could not be opened for subtitle extraction.')

      setPlayerNotice('Checking the first embedded subtitle track…')
      await ffmpeg.exec(['-hide_banner', '-i', inputPath])
      if (!currentRequest()) return

      const streamLines = logs.flatMap((message) => message.split(/\r?\n/))

      const subtitleStreams = streamLines
        .map((line) => line.match(/Stream #0:(\d+)(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Subtitle:\s*([^,\s]+)/i))
        .filter((match): match is RegExpMatchArray => match !== null)
      const firstSubtitle = subtitleStreams[0]

      if (!firstSubtitle) {
        setPlayerNotice('No embedded subtitle track was found.')
        return
      }

      const [, streamIndex, codec] = firstSubtitle
      const normalizedCodec = codec.toLowerCase()
      if (normalizedCodec !== 'subrip' && normalizedCodec !== 'ass' && normalizedCodec !== 'webvtt') {
        setPlayerNotice('The first embedded subtitle track is not S_TEXT/UTF8, S_TEXT/ASS, or WebVTT, so it was not extracted.')
        return
      }

      setPlayerNotice('Extracting the embedded subtitle…')
      const result = await ffmpeg.exec([
        '-i', inputPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        outputName,
      ])
      if (!currentRequest()) return

      const files = await ffmpeg.listDir('/')
      if (result !== 0 || !files.some((entry) => entry.name === outputName && !entry.isDir)) {
        const details = logs
          .filter((message) => /error|failed|unsupported|invalid/i.test(message))
          .slice(-3)
        throw new Error(
          `FFmpeg could not convert the embedded ${normalizedCodec === 'ass' ? 'S_TEXT/ASS' : 'S_TEXT/UTF8'} track to WebVTT.${details.length ? ` ${details.join(' | ')}` : ''}`,
        )
      }

      const subtitleData = await ffmpeg.readFile(outputName)
      if (typeof subtitleData === 'string') throw new Error('The extracted subtitle file could not be read.')
      if (!currentRequest()) return

      setSubtitle(createSubtitleTrack(
        new Blob([new Uint8Array(subtitleData)], { type: 'text/vtt' }),
        normalizedCodec === 'ass' ? 'Embedded ASS subtitles' : 'Embedded SRT subtitles',
      ))
      setSubtitleError('')
      setPlayerNotice('Embedded subtitles loaded. Use the video controls to turn captions on or off.')
    } catch (error) {
      if (currentRequest()) {
        setSubtitleError(
          error instanceof Error
            ? `Could not extract embedded subtitles: ${error.message}`
            : `Could not extract embedded subtitles: ${String(error)}`,
        )
        setPlayerNotice('')
      }
    } finally {
      ffmpeg.off('log', onLog)
      ffmpeg.terminate()
      if (ffmpegRef.current === ffmpeg) ffmpegRef.current = null
    }
  }

  function handleVideoCanPlay(event: SyntheticEvent<HTMLVideoElement> | HTMLVideoElement) {
    const video = 'currentTarget' in event ? event.currentTarget : event
    if (autoplayAttemptedFor.current === media?.src) return

    autoplayAttemptedFor.current = media?.src ?? null
    void video.play().then(
      () => setAutoplayBlocked(false),
      () => setAutoplayBlocked(true),
    )
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setIsDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return

    setPlayerError('')
    setPlayerNotice('')

    if (files.length === 1) {
      const [file] = files
      if (isSubtitleFile(file)) {
        void loadSubtitleFile(file)
      } else {
        const item = Array.from(event.dataTransfer.items).find(
          (candidate) => candidate.kind === 'file' && candidate.getAsFile()?.name === file.name,
        )
        let handle: VideoFileHandle | null = null
        try {
          handle = await getDroppedVideoHandle(item)
        } catch (error) {
          setPlayerNotice(error instanceof Error ? error.message : `Could not retain movie access: ${String(error)}`)
        }
        loadFile(file, true, handle ?? undefined)
      }
      return
    }

    const videos = files.filter(isVideoFile)
    const subtitles = files.filter(isSubtitleFile)
    if (files.length !== 2 || videos.length !== 1 || subtitles.length !== 1) {
      setPlayerError('Drop one video and one SRT subtitle file together.')
      return
    }

    const [video] = videos
    const [subtitleFile] = subtitles
    const videoItem = Array.from(event.dataTransfer.items).find(
      (candidate) => candidate.kind === 'file' && candidate.getAsFile()?.name === video.name,
    )
    const handlePromise = getDroppedVideoHandle(videoItem).catch((error: unknown) => {
      setPlayerNotice(error instanceof Error ? error.message : `Could not retain movie access: ${String(error)}`)
      return null
    })
    cancelSubtitleExtraction()
    void (async () => {
      try {
        const [track, handle] = await Promise.all([
          createSubtitleFromSrt(subtitleFile),
          handlePromise,
        ])
        loadFile(video, false, handle ?? undefined)
        setSubtitle(track)
        setPlayerError('')
        setSubtitleError('')
        setPlayerNotice('Subtitles loaded. Use the video controls to turn captions on or off.')
      } catch (error) {
        setPlayerError(error instanceof Error ? error.message : 'Could not read this subtitle file.')
      }
    })()
  }

  async function handleRestoreSavedMovie() {
    if (!pendingRestore || pendingRestore.kind !== 'file') return

    if (!pendingRestore.handle) {
      fileInputRef.current?.click()
      return
    }

    try {
      const permission = await pendingRestore.handle.requestPermission?.({ mode: 'read' })
      if (permission && permission !== 'granted') {
        setPlayerNotice('Access was not granted. Choose the saved movie again to restore it.')
        return
      }
      const file = await pendingRestore.handle.getFile()
      loadFile(file, !pendingRestore.subtitle, pendingRestore.handle)
    } catch (error) {
      setPlayerError(error instanceof Error ? error.message : `Could not restore the movie: ${String(error)}`)
    }
  }

  const mediaSourceBadge = media ? (media.kind === 'file' ? 'LOCAL' : 'REMOTE') : null

  return (
    <main className="app-shell">
      <header className={`topbar${isNavOpen ? ' is-nav-open' : ''}`}>
        <div className="brand-group">
          <a className="brand" href="/" aria-label="Couch home">
            <img src={couchLogo} alt="" />
            <span>Couch</span>
          </a>
          {mediaSourceBadge && (
            <span className={`local-badge${media?.kind === 'link' ? ' remote-badge' : ''}`}>
              <span /> {mediaSourceBadge}
            </span>
          )}
        </div>

        <button
          type="button"
          className="nav-collapse-toggle"
          aria-label={isNavOpen ? 'Collapse toolbar' : 'Expand toolbar'}
          aria-expanded={isNavOpen}
          onClick={() => setIsNavOpen((open) => !open)}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="topbar-actions">
          <div className="toolbar-inline">
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="video/*,.mkv,.avi"
              onChange={handleFileChange}
              aria-label="Choose a video file"
            />
            <button className="secondary-button nav-button" onClick={() => void handleChooseFile()}>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Open file
            </button>
            <input
              ref={subtitleInputRef}
              className="visually-hidden"
              type="file"
              accept=".srt,application/x-subrip"
              onChange={handleSubtitleChange}
              aria-label="Choose an SRT subtitle file"
              disabled={!media}
            />
            <button
              className="secondary-button nav-button"
              onClick={() => subtitleInputRef.current?.click()}
              disabled={!media}
            >
              Subtitles
            </button>
            {(media || subtitle) && (
              <button className="secondary-button danger-button nav-button" onClick={clearCurrentMedia}>
                Remove
              </button>
            )}
          </div>

          <form className="nav-url-form" onSubmit={handleUrlSubmit} noValidate>
            <label className="visually-hidden" htmlFor="video-url">Video URL</label>
            <div className={`nav-url-input${urlError ? ' has-error' : ''}`}>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M8.1 11.9a3 3 0 0 0 4.24 0l2.12-2.12a3 3 0 0 0-4.24-4.24L9 6.76m2.9 1.34a3 3 0 0 0-4.24 0l-2.12 2.12a3 3 0 0 0 4.24 4.24L11 13.24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input
                id="video-url"
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                  setUrlError('')
                }}
                placeholder="https://example.com/video.mp4"
                aria-describedby={urlError ? 'url-error' : undefined}
              />
              <button type="submit" className="load-button">Load</button>
            </div>
            {urlError && <p className="url-error" id="url-error" role="alert">{urlError}</p>}
          </form>
        </div>
      </header>

      <section className="workspace">
        <section
          className={`player-frame${isDragging ? ' is-dragging' : ''}${media ? ' has-media' : ''}`}
          aria-label="Video player"
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {media ? (
            <VideoPlayer title={media.title}>
              <VideoSkin>
                <Video
                  key={media.src}
                  ref={videoRef}
                  className="video"
                  src={media.src}
                  playsInline
                  preload="metadata"
                  onError={() => setPlayerError(
                    media.kind === 'file' && /\.mkv$/i.test(media.title)
                      ? 'This MKV could not be played by your browser. Support depends on the browser and the video/audio codecs in the file.'
                      : 'This video could not be played. Check the link or try another video file.',
                  )}
                  onCanPlay={(event) => {
                    setPlayerError('')
                    handleVideoCanPlay(event)
                  }}
                  onPlay={() => setAutoplayBlocked(false)}
                >
                  {subtitle && (
                    <track
                      key={subtitle.src}
                      kind="subtitles"
                      src={subtitle.src}
                      srcLang="en"
                      label={subtitle.label}
                      default
                      onError={() => setPlayerError('The subtitle file could not be loaded by the browser.')}
                    />
                  )}
                  Your browser does not support video playback.
                </Video>
              </VideoSkin>
            </VideoPlayer>
          ) : (
            <div className="player-empty">
              <div className="play-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="m9 6 10 6-10 6V6Z" fill="currentColor" />
                </svg>
              </div>
              <p className="empty-title">Ready when you are</p>
              <p className="empty-copy">Choose a video or drop one right here</p>
              <button className="browse-button" onClick={() => void handleChooseFile()}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Open a video
              </button>
              {pendingRestore?.kind === 'file' && (
                <button className="secondary-button" onClick={() => void handleRestoreSavedMovie()}>
                  Restore saved movie
                </button>
              )}
              <span className="drop-hint">or drop one video and one subtitle together</span>
            </div>
          )}
          {isDragging && <div className="drop-overlay">Drop a video or SRT/VTT subtitle file</div>}
        </section>

        {playerError && <p className="error-message" role="alert">{playerError}</p>}
        {subtitleError && <p className="error-message" role="alert">{subtitleError}</p>}
        {playerNotice && <p className="player-notice" role="status">{playerNotice}</p>}
        {autoplayBlocked && <p className="player-notice" role="status">Autoplay was blocked by your browser. Press Play to start the video.</p>}
      </section>
      <footer className="footer">
        <p className="privacy-note">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.25 3.5 4v3.5c0 2.8 1.9 5.25 4.5 6.25 2.6-1 4.5-3.45 4.5-6.25V4L8 2.25Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
            <path d="m6.25 7.75 1.2 1.2 2.5-2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Video bytes stay on your device; Couch saves only file access, links, and subtitle data locally.
        </p>
        <div>© {new Date().getFullYear()} Couch. All rights reserved.</div>
      </footer>
    </main>
  )
}

export default App

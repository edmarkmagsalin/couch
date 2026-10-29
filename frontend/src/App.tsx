import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent, SyntheticEvent } from 'react'
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import {
  chooseVideoFile,
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
  currentTime?: number
}

type SubtitleTrack = {
  src: string
  label: string
  blob: Blob
}

type MkvAudioTrack = {
  streamIndex: number
  label: string
  isDefault: boolean
}

type NativeAudioTrackList = {
  length: number
  [index: number]: { enabled: boolean }
}

type VideoWithAudioTracks = HTMLVideoElement & {
  audioTracks?: NativeAudioTrackList
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
  const [audioTracks, setAudioTracks] = useState<MkvAudioTrack[]>([])
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(0)
  const [nativeAudioTrackCount, setNativeAudioTrackCount] = useState<number | null>(null)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
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
    const nativeTracks = (videoRef.current as VideoWithAudioTracks | null)?.audioTracks
    const trackCount = nativeTracks?.length ?? 0
    setNativeAudioTrackCount(trackCount)

    if (trackCount !== audioTracks.length || !nativeTracks) return
    for (let index = 0; index < trackCount; index += 1) {
      nativeTracks[index].enabled = index === selectedAudioTrack
    }
  }, [audioTracks, media, nativeAudioTrackCount, selectedAudioTrack])

  useEffect(() => {
    let cancelled = false
    void readSavedMedia()
      .then(async (saved) => {
        if (!saved || cancelled || restoreCancelled.current) return
        if (saved.kind === 'link') {
          setMedia({
            src: saved.src,
            title: saved.title,
            kind: 'link',
            currentTime: saved.currentTime ?? 0,
          })
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
            currentTime: saved.currentTime ?? 0,
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

    const currentTime = Number.isFinite(videoRef.current?.currentTime)
      ? Math.max(0, videoRef.current!.currentTime)
      : media.currentTime ?? 0
    const save = media.kind === 'link'
      ? saveMedia({
          kind: 'link',
          src: media.src,
          title: media.title,
          subtitle: subtitle ? { blob: subtitle.blob, label: subtitle.label } : null,
          currentTime,
        })
      : saveMedia({
          kind: 'file',
          handle: media.handle ?? null,
          title: media.title,
          size: media.fileSize ?? 0,
          lastModified: media.fileLastModified ?? 0,
          subtitle: subtitle ? { blob: subtitle.blob, label: subtitle.label } : null,
          currentTime,
        })
    void save.catch((error: unknown) => {
      setPlayerError(error instanceof Error ? error.message : `Could not save media details: ${String(error)}`)
    })
  }, [media, subtitle, persistenceReady])

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
    setAudioTracks([])
    setSelectedAudioTrack(0)
    setNativeAudioTrackCount(null)
    setPendingRestore(null)
    setSubtitle(saved?.subtitle ? createSubtitleTrack(saved.subtitle.blob, saved.subtitle.label) : null)
    setMedia({
      src: URL.createObjectURL(file),
      title: file.name,
      kind: 'file',
      handle,
      fileSize: file.size,
      fileLastModified: file.lastModified,
      currentTime: saved?.currentTime ?? 0,
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
    setAudioTracks([])
    setSelectedAudioTrack(0)
    setNativeAudioTrackCount(null)
    setMedia({
      src: parsedUrl.href,
      title: parsedUrl.pathname.split('/').filter(Boolean).at(-1) || parsedUrl.hostname,
      kind: 'link',
      currentTime: 0,
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

    if (!file.name.toLowerCase().endsWith('.srt')) {
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
      let audioOrdinal = 0
      let activeAudioTrack: MkvAudioTrack | null = null
      const discoveredAudioTracks: MkvAudioTrack[] = []
      for (const line of streamLines) {
        const match = line.match(
          /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]*)\))?:\s*Audio:\s*([^,\s]+)/i,
        )
        if (match) {
          audioOrdinal += 1
          const [, streamIndexText, language, codec] = match
          const description = [language, codec.toUpperCase()].filter(Boolean).join(' · ')
          const isDefault = /\(default\)/i.test(line)
          activeAudioTrack = {
            streamIndex: Number(streamIndexText),
            label: `${description || `Audio track ${audioOrdinal}`}${isDefault ? ' (default)' : ''}`,
            isDefault,
          }
          discoveredAudioTracks.push(activeAudioTrack)
          continue
        }

        if (/^\s*Stream #0:\d+/i.test(line)) {
          activeAudioTrack = null
          continue
        }
        const title = line.match(/^\s*title\s*:\s*(.+)$/i)?.[1]?.trim()
        if (activeAudioTrack && title) {
          const defaultLabel = activeAudioTrack.isDefault ? ' (default)' : ''
          const trackDescription = activeAudioTrack.label.replace(/ \(default\)$/, '')
          activeAudioTrack.label = `${title} — ${trackDescription}${defaultLabel}`
          activeAudioTrack = null
        }
      }
      setAudioTracks(discoveredAudioTracks)
      const defaultTrackIndex = discoveredAudioTracks.findIndex((track) => track.isDefault)
      const initialTrackIndex = defaultTrackIndex >= 0 ? defaultTrackIndex : 0
      setSelectedAudioTrack(initialTrackIndex)

      const subtitleStreams = streamLines
        .map((line) => line.match(/Stream #0:(\d+)(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Subtitle:\s*([^\s,(]+)/i))
        .filter((match): match is RegExpMatchArray => match !== null)
      const firstSubtitle = subtitleStreams[0]

      if (!firstSubtitle) {
        setPlayerNotice(
          discoveredAudioTracks.length > 1
            ? 'Multiple audio tracks found. Choose a track below. No embedded subtitle track was found.'
            : 'No embedded subtitle track was found.',
        )
        return
      }

      const [, streamIndex, codec] = firstSubtitle
      const normalizedCodec = codec.toLowerCase()
      if (normalizedCodec !== 'subrip' && normalizedCodec !== 'ass') {
        setPlayerNotice(
          discoveredAudioTracks.length > 1
            ? 'Multiple audio tracks found. Choose a track below. The first embedded subtitle track is unsupported.'
            : 'The first embedded subtitle track is not S_TEXT/UTF8 or S_TEXT/ASS, so it was not extracted.',
        )
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
      setPlayerNotice(
        discoveredAudioTracks.length > 1
          ? 'Multiple audio tracks found. Choose a track below. Embedded subtitles loaded.'
          : 'Embedded subtitles loaded. Use the video controls to turn captions on or off.',
      )
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

  function handleVideoCanPlay(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    if (media?.currentTime && Number.isFinite(media.currentTime)) {
      const savedTime = Math.min(media.currentTime, video.duration || media.currentTime)
      if (!Number.isNaN(savedTime) && savedTime > 0 && Math.abs(video.currentTime - savedTime) > 0.5) {
        video.currentTime = savedTime
      }
    }
    if (autoplayAttemptedFor.current === media?.src) return

    autoplayAttemptedFor.current = media?.src ?? null
    void video.play().then(
      () => setAutoplayBlocked(false),
      () => setAutoplayBlocked(true),
    )
  }

  function handleVideoTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    const nextTime = event.currentTarget.currentTime
    if (!Number.isFinite(nextTime)) return

    setMedia((current) => {
      if (!current || current.src !== media?.src) return current
      return { ...current, currentTime: nextTime }
    })
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
      if (file.name.toLowerCase().endsWith('.srt')) {
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
    const subtitles = files.filter((file) => file.name.toLowerCase().endsWith('.srt'))
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
    void Promise.all([createSubtitleFromSrt(subtitleFile), handlePromise])
      .then(([track, handle]) => {
        loadFile(video, false, handle ?? undefined)
        setSubtitle(track)
        setPlayerError('')
        setSubtitleError('')
        setPlayerNotice('Subtitles loaded. Use the video controls to turn captions on or off.')
      })
      .catch((error: unknown) => {
        setPlayerError(error instanceof Error ? error.message : 'Could not read this subtitle file.')
      })
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Couch home">
          <img src={couchLogo} alt="" />
          <span>Couch</span>
        </a>
        <span className="local-badge"><span /> YOUR PERSONAL VIDEO PLAYER</span>
      </header>

      <section className="workspace">
        <div className="intro">
          <p className="eyebrow">A LITTLE SPACE FOR BIG STORIES</p>
          <h1>Your video, <span>your space.</span></h1>
          <p className="intro-copy">Drop in a file or paste a video link. Sit back and enjoy.</p>
        </div>

        <section
          className={`player-frame${isDragging ? ' is-dragging' : ''}${media ? ' has-media' : ''}${isPaused ? ' is-paused' : ''}`}
          aria-label="Video player"
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {media ? (
            <>
              <video
                key={media.src}
                ref={videoRef}
                className="video"
                src={media.src}
                controls
                playsInline
                preload="metadata"
                onError={() => setPlayerError(
                  media.kind === 'file' && /\.mkv$/i.test(media.title)
                    ? 'This MKV could not be played by your browser. Support depends on the browser and the video/audio codecs in the file.'
                    : 'This video could not be played. Check the link or try another video file.',
                )}
                onCanPlay={(event) => {
                  setPlayerError('')
                  setNativeAudioTrackCount(
                    (event.currentTarget as VideoWithAudioTracks).audioTracks?.length ?? 0,
                  )
                  handleVideoCanPlay(event)
                }}
                onTimeUpdate={handleVideoTimeUpdate}
                onPause={() => setIsPaused(true)}
                onPlay={() => {
                  setAutoplayBlocked(false)
                  setIsPaused(false)
                }}
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
              </video>
              <div className="media-title-overlay" aria-hidden="true">{media.title}</div>
            </>
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
              <span className="drop-hint">or drop one video and one SRT together</span>
            </div>
          )}
          {isDragging && <div className="drop-overlay">Drop a video or SRT subtitle file</div>}
        </section>

        {!media && <p className="detail-placeholder">Your next favorite starts here</p>}

        {playerError && <p className="error-message" role="alert">{playerError}</p>}
        {subtitleError && <p className="error-message" role="alert">{subtitleError}</p>}
        {playerNotice && <p className="player-notice" role="status">{playerNotice}</p>}
        {autoplayBlocked && <p className="player-notice" role="status">Autoplay was blocked by your browser. Press Play to start the video.</p>}
        {audioTracks.length > 1 && (
          <div className="audio-track-picker">
            <label htmlFor="audio-track">Audio track</label>
            <select
              id="audio-track"
              value={selectedAudioTrack}
              disabled={nativeAudioTrackCount !== audioTracks.length}
              onChange={(event) => setSelectedAudioTrack(Number(event.target.value))}
            >
              {audioTracks.map((track, index) => (
                <option key={track.streamIndex} value={index}>{track.label}</option>
              ))}
            </select>
            <span>
              {nativeAudioTrackCount === audioTracks.length
                ? 'Select an embedded audio track.'
                : 'This browser does not support native audio-track switching for this video.'}
            </span>
          </div>
        )}

        <div className="source-panel">
          <div className="file-action">
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="video/*,.mkv,.avi"
              onChange={handleFileChange}
              aria-label="Choose a video file"
            />
            <button className="secondary-button" onClick={() => void handleChooseFile()}>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Choose a file
            </button>
            <span className="action-caption">MKV: SRT/ASS auto-extract · playback varies</span>
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
              className="secondary-button subtitle-button"
              onClick={() => subtitleInputRef.current?.click()}
              disabled={!media}
            >
              Load subtitles
            </button>
            {subtitle && <span className="action-caption subtitle-caption">{subtitle.label}</span>}
          </div>

          <div className="divider"><span>OR PASTE A LINK</span></div>

          <form className="url-form" onSubmit={handleUrlSubmit} noValidate>
            <label className="visually-hidden" htmlFor="video-url">Video URL</label>
            <div className={`url-input-wrap${urlError ? ' has-error' : ''}`}>
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
              <button type="submit" className="load-button">Load video</button>
            </div>
            {urlError && <p className="url-error" id="url-error" role="alert">{urlError}</p>}
          </form>
        </div>

        <p className="privacy-note">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.25 3.5 4v3.5c0 2.8 1.9 5.25 4.5 6.25 2.6-1 4.5-3.45 4.5-6.25V4L8 2.25Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
            <path d="m6.25 7.75 1.2 1.2 2.5-2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Video bytes stay on your device; Couch saves only file access, links, and subtitle data locally.
        </p>
      </section>
      <footer className="footer">Made for the moments worth pressing play on.</footer>
    </main>
  )
}

export default App

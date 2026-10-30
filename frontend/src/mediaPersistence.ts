export type VideoFileHandle = {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<File>
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>
}

export type PersistedSubtitle = {
  blob: Blob
  label: string
}

export type PersistedMedia =
  | {
      kind: 'file'
      handle: VideoFileHandle | null
      title: string
      size: number
      lastModified: number
      subtitle: PersistedSubtitle | null
    }
  | {
      kind: 'link'
      src: string
      title: string
      subtitle: PersistedSubtitle | null
    }

type StoredMedia = {
  id: 'current'
  media: PersistedMedia
}

type VideoPickerWindow = Window & {
  showOpenFilePicker?: () => Promise<VideoFileHandle[]>
}

const databaseName = 'couch-media'
const storeName = 'media'

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'))
  })

  return databasePromise
}

export function supportsVideoFilePicker() {
  return typeof (window as VideoPickerWindow).showOpenFilePicker === 'function'
}

export async function chooseVideoFile(): Promise<{ file: File; handle: VideoFileHandle } | null> {
  const picker = (window as VideoPickerWindow).showOpenFilePicker
  if (!picker) return null

  const [handle] = await picker()
  if (!handle) return null

  return { file: await handle.getFile(), handle }
}

export function isVideoFileHandle(value: unknown): value is VideoFileHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'file' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'getFile' in value &&
    typeof value.getFile === 'function'
  )
}

export async function getDroppedVideoHandle(item: DataTransferItem | undefined) {
  if (!item) return null

  const itemWithHandle = item as DataTransferItem & {
    getAsFileSystemHandle?: () => Promise<unknown>
  }
  if (!itemWithHandle.getAsFileSystemHandle) return null

  const handle = await itemWithHandle.getAsFileSystemHandle()
  return isVideoFileHandle(handle) ? handle : null
}

export async function readSavedMedia(): Promise<PersistedMedia | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(storeName, 'readonly')
      .objectStore(storeName)
      .get('current') as IDBRequest<StoredMedia | undefined>

    request.onsuccess = () => resolve(request.result?.media ?? null)
    request.onerror = () => reject(request.error ?? new Error('Could not read saved media.'))
  })
}

export async function saveMedia(media: PersistedMedia): Promise<void> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put({ id: 'current', media } satisfies StoredMedia)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save media details.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Saving media details was aborted.'))
  })
}

export async function deleteSavedMedia(): Promise<void> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const request = transaction.objectStore(storeName).delete('current')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Could not remove saved media.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Removing saved media was aborted.'))
  })
}

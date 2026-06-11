import './styles.css'

const CODECS = {
  h264: 'H.264 / AVC',
  h265: 'H.265 / HEVC',
  vp9: 'VP9',
  mpeg4: 'MPEG-4 Part 2'
}

const CHUNK_SIZE = 4 * 1024 * 1024

const app = document.querySelector('#app')

const state = {
  file: null,
  videoUrl: '',
  inputUrl: '',
  outputUrl: '',
  isWorking: false,
  uploadStartedAt: 0,
  activeRequest: null,
  activeUploadId: '',
  activeJobId: '',
  activeEventSource: null,
  didCancel: false
}

app.innerHTML = `
  <main class="shell">
    <section class="workspace simple-workspace">
      <aside class="panel controls">
        <div class="brand">
          <div class="brand-mark">FF</div>
          <div>
            <h1>视频编码转换器</h1>
            <p>服务器端 FFmpeg 转码</p>
          </div>
        </div>

        <label class="dropzone" id="dropzone">
          <input id="fileInput" type="file" accept="video/*" />
          <span class="drop-icon">+</span>
          <strong>选择或拖入视频</strong>
          <small id="fileMeta">等待选择视频文件</small>
        </label>

        <label>
          <span>视频链接</span>
          <input id="urlInput" class="url-input" type="url" placeholder="https://example.com/video.mp4" />
        </label>

        <label>
          <span>目标编码</span>
          <select id="codecSelect">
            <option value="h264">H.264 / AVC</option>
            <option value="h265">H.265 / HEVC</option>
            <option value="vp9">VP9</option>
            <option value="mpeg4">MPEG-4 Part 2</option>
          </select>
        </label>

        <div class="actions">
          <button id="convertBtn" class="primary" type="button" disabled>
            <span class="button-icon">▶</span>
            上传并转换
          </button>
          <button id="cancelBtn" class="danger hidden" type="button">
            <span class="button-icon">■</span>
            停止
          </button>
          <a id="downloadBtn" class="download hidden" href="#" download>
            <span class="button-icon">↓</span>
            下载视频
          </a>
        </div>
      </aside>

      <section class="stage simple-stage">
        <div class="preview-wrap">
          <video id="preview" controls playsinline></video>
          <div id="emptyState" class="empty-state">
            <div class="film">
              <span></span><span></span><span></span><span></span>
            </div>
            <p>选择视频后可预览</p>
          </div>
        </div>

        <div class="status-band">
          <div>
            <span class="eyebrow">当前状态</span>
            <strong id="statusText">等待文件</strong>
          </div>
          <div id="progressShell" class="progress-shell" aria-label="转换进度">
            <div id="progressBar"></div>
          </div>
          <span id="progressText">0%</span>
        </div>
      </section>
    </section>
  </main>
`

const refs = {
  fileInput: document.querySelector('#fileInput'),
  urlInput: document.querySelector('#urlInput'),
  dropzone: document.querySelector('#dropzone'),
  fileMeta: document.querySelector('#fileMeta'),
  codecSelect: document.querySelector('#codecSelect'),
  convertBtn: document.querySelector('#convertBtn'),
  cancelBtn: document.querySelector('#cancelBtn'),
  downloadBtn: document.querySelector('#downloadBtn'),
  preview: document.querySelector('#preview'),
  emptyState: document.querySelector('#emptyState'),
  statusText: document.querySelector('#statusText'),
  progressShell: document.querySelector('#progressShell'),
  progressBar: document.querySelector('#progressBar'),
  progressText: document.querySelector('#progressText')
}

refs.fileInput.addEventListener('change', (event) => {
  const [file] = event.target.files
  if (file) setFile(file)
})

refs.urlInput.addEventListener('input', (event) => {
  setVideoUrl(event.target.value)
})

refs.dropzone.addEventListener('dragover', (event) => {
  event.preventDefault()
  refs.dropzone.classList.add('is-dragging')
})

refs.dropzone.addEventListener('dragleave', () => {
  refs.dropzone.classList.remove('is-dragging')
})

refs.dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  refs.dropzone.classList.remove('is-dragging')
  const [file] = event.dataTransfer.files
  if (file) setFile(file)
})

refs.convertBtn.addEventListener('click', convertVideoCodec)
refs.cancelBtn.addEventListener('click', cancelActiveRequest)

function setFile(file) {
  cleanupOutput()
  if (state.inputUrl) URL.revokeObjectURL(state.inputUrl)

  state.file = file
  state.videoUrl = ''
  state.inputUrl = URL.createObjectURL(file)
  refs.urlInput.value = ''

  refs.preview.src = state.inputUrl
  refs.preview.classList.add('is-visible')
  refs.emptyState.classList.add('hidden')
  refs.fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`
  refs.statusText.textContent = '已选择文件'
  refs.convertBtn.textContent = '上传并转换'
  refs.convertBtn.disabled = false
  renderProgress(0)
}

function setVideoUrl(value) {
  cleanupOutput()
  const videoUrl = value.trim()
  state.videoUrl = videoUrl

  if (!videoUrl) {
    refs.convertBtn.disabled = !state.file
    refs.statusText.textContent = state.file ? '已选择文件' : '等待文件'
    refs.convertBtn.textContent = '上传并转换'
    return
  }

  state.file = null
  refs.fileInput.value = ''
  refs.fileMeta.textContent = '使用视频链接'
  refs.preview.removeAttribute('src')
  refs.preview.classList.remove('is-visible')
  refs.emptyState.classList.remove('hidden')
  refs.statusText.textContent = '已输入视频链接'
  refs.convertBtn.textContent = '下载并转换'
  refs.convertBtn.disabled = false
  renderProgress(0)
}

async function convertVideoCodec() {
  if ((!state.file && !state.videoUrl) || state.isWorking) return

  cleanupOutput()
  state.isWorking = true
  state.didCancel = false
  state.uploadStartedAt = performance.now()
  refs.convertBtn.disabled = true
  refs.cancelBtn.classList.remove('hidden')
  refs.statusText.textContent = state.videoUrl ? '服务器下载视频' : '上传视频'
  renderProgress(0)

  try {
    const codec = refs.codecSelect.value

    if (state.videoUrl) {
      await convertRemoteVideo(codec)
      return
    }

    const { uploadId } = await createUploadSession()
    state.activeUploadId = uploadId

    await uploadFileChunks(uploadId)

    refs.statusText.textContent = `上传完成，服务器合并并转码为 ${CODECS[codec]}`
    refs.progressShell.classList.add('is-indeterminate')
    renderProgress(78, '转码中')

    const result = await completeUpload(uploadId, codec)
    const filename = getFilenameFromDisposition(result.disposition) || `video-${codec}.mp4`
    state.outputUrl = URL.createObjectURL(result.blob)
    refs.downloadBtn.href = state.outputUrl
    refs.downloadBtn.download = filename
    refs.downloadBtn.classList.remove('hidden')
    refs.statusText.textContent = `已转换为 ${CODECS[codec]}`
    refs.progressShell.classList.remove('is-indeterminate')
    renderProgress(100)
  } catch (error) {
    refs.progressShell.classList.remove('is-indeterminate')

    if (state.didCancel) {
      refs.statusText.textContent = '已停止上传并清理'
      renderProgress(0)
    } else {
      refs.statusText.textContent = error.message || '转换失败'
    }
  } finally {
    finishRequest()
  }
}

async function convertRemoteVideo(codec) {
  refs.statusText.textContent = '创建转换任务'
  renderProgress(1, '准备中')

  const { jobId } = await createRemoteJob(codec)
  state.activeJobId = jobId
  await watchRemoteJob(jobId)

  refs.statusText.textContent = '下载转换结果'
  renderProgress(98, '下载中')
  const result = await downloadRemoteJob(jobId)
  const filename = getFilenameFromDisposition(result.disposition) || `video-${codec}.mp4`
  state.outputUrl = URL.createObjectURL(result.blob)
  refs.downloadBtn.href = state.outputUrl
  refs.downloadBtn.download = filename
  refs.downloadBtn.classList.remove('hidden')
  refs.statusText.textContent = `已转换为 ${CODECS[codec]}`
  refs.progressShell.classList.remove('is-indeterminate')
  renderProgress(100)
}

async function createRemoteJob(codec) {
  const response = await fetch('/api/url-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      codec,
      url: state.videoUrl
    })
  })

  if (!response.ok) {
    throw new Error(await readResponseError(response))
  }

  return response.json()
}

function watchRemoteJob(jobId) {
  return new Promise((resolvePromise, reject) => {
    const events = new EventSource(`/api/url-jobs/${jobId}/events`)
    state.activeEventSource = events

    events.onmessage = (event) => {
      const job = JSON.parse(event.data)
      renderRemoteJobProgress(job)

      if (job.status === 'done') {
        events.close()
        state.activeEventSource = null
        resolvePromise(job)
      }

      if (job.status === 'error') {
        events.close()
        state.activeEventSource = null
        reject(new Error(job.error || '转换失败'))
      }

      if (job.status === 'cancelled') {
        events.close()
        state.activeEventSource = null
        reject(new Error('已停止处理'))
      }
    }

    events.onerror = () => {
      events.close()
      state.activeEventSource = null
      reject(new Error(state.didCancel ? '已停止处理' : '进度连接中断'))
    }
  })
}

function renderRemoteJobProgress(job) {
  renderProgress(job.progress || 0, `${job.progress || 0}%`)

  if (job.status === 'downloading') {
    const total = job.totalBytes ? formatBytes(job.totalBytes) : '未知大小'
    refs.statusText.textContent = `服务器下载 ${formatBytes(job.downloadedBytes)} / ${total}`
    return
  }

  if (job.status === 'probing') {
    refs.statusText.textContent = '读取视频信息'
    return
  }

  if (job.status === 'transcoding') {
    const current = formatDuration(job.transcodedSeconds || 0)
    const total = job.durationSeconds ? formatDuration(job.durationSeconds) : '未知时长'
    refs.statusText.textContent = `服务器转码 ${current} / ${total}`
    return
  }

  refs.statusText.textContent = job.phase || '处理中'
}

function downloadRemoteJob(jobId) {
  return new Promise((resolvePromise, reject) => {
    const request = new XMLHttpRequest()
    state.activeRequest = request
    request.open('GET', `/api/url-jobs/${jobId}/download`)
    request.responseType = 'blob'

    request.onload = async () => {
      state.activeRequest = null
      if (request.status >= 200 && request.status < 300) {
        resolvePromise({
          blob: request.response,
          disposition: request.getResponseHeader('Content-Disposition')
        })
        return
      }

      reject(new Error(await readError(request.response)))
    }

    request.onerror = () => {
      state.activeRequest = null
      reject(new Error(state.didCancel ? '已停止处理' : '网络错误，转换失败'))
    }

    request.onabort = () => {
      state.activeRequest = null
      reject(new Error('已停止处理'))
    }

    request.send()
  })
}

async function createUploadSession() {
  const response = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: state.file.name,
      size: state.file.size
    })
  })

  if (!response.ok) {
    throw new Error(await readResponseError(response))
  }

  return response.json()
}

async function uploadFileChunks(uploadId) {
  const totalChunks = Math.ceil(state.file.size / CHUNK_SIZE)
  let uploadedBytes = 0

  for (let index = 0; index < totalChunks; index += 1) {
    if (state.didCancel) throw new Error('已停止上传')

    const start = index * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, state.file.size)
    const chunk = state.file.slice(start, end)

    refs.statusText.textContent = `上传分片 ${index + 1} / ${totalChunks}`
    await uploadChunk(uploadId, index, chunk, (loaded) => {
      const sentBytes = uploadedBytes + loaded
      const uploadProgress = sentBytes / state.file.size
      const elapsedSeconds = Math.max((performance.now() - state.uploadStartedAt) / 1000, 0.1)
      const uploadSpeed = sentBytes / elapsedSeconds
      const progress = Math.min(76, Math.round(uploadProgress * 76))

      refs.statusText.textContent = `上传视频 ${formatBytes(sentBytes)} / ${formatBytes(state.file.size)}`
      renderProgress(progress, `${Math.round(uploadProgress * 100)}% · ${formatBytes(uploadSpeed)}/s`)
    })

    uploadedBytes += chunk.size
  }
}

function uploadChunk(uploadId, index, chunk, onProgress) {
  return new Promise((resolvePromise, reject) => {
    const formData = new FormData()
    formData.append('chunk', chunk, `${index}.part`)

    const request = new XMLHttpRequest()
    state.activeRequest = request
    request.open('POST', `/api/uploads/${uploadId}/chunks/${index}`)

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onProgress(event.loaded)
    }

    request.onload = () => {
      state.activeRequest = null
      if (request.status >= 200 && request.status < 300) {
        resolvePromise()
        return
      }

      reject(new Error(readRequestError(request)))
    }

    request.onerror = () => {
      state.activeRequest = null
      reject(new Error(state.didCancel ? '已停止上传' : '网络错误，上传失败'))
    }

    request.onabort = () => {
      state.activeRequest = null
      reject(new Error('已停止上传'))
    }

    request.send(formData)
  })
}

function completeUpload(uploadId, codec) {
  return new Promise((resolvePromise, reject) => {
    const request = new XMLHttpRequest()
    state.activeRequest = request
    request.open('POST', `/api/uploads/${uploadId}/complete`)
    request.setRequestHeader('Content-Type', 'application/json')
    request.responseType = 'blob'

    request.onload = async () => {
      state.activeRequest = null
      if (request.status >= 200 && request.status < 300) {
        resolvePromise({
          blob: request.response,
          disposition: request.getResponseHeader('Content-Disposition')
        })
        return
      }

      reject(new Error(await readError(request.response)))
    }

    request.onerror = () => {
      state.activeRequest = null
      reject(new Error(state.didCancel ? '已停止上传' : '网络错误，转换失败'))
    }

    request.onabort = () => {
      state.activeRequest = null
      reject(new Error('已停止上传'))
    }

    request.send(JSON.stringify({
      codec,
      filename: state.file.name,
      totalChunks: Math.ceil(state.file.size / CHUNK_SIZE)
    }))
  })
}

function cancelActiveRequest() {
  if (!state.isWorking) return

  state.didCancel = true
  refs.statusText.textContent = '正在停止'
  refs.cancelBtn.disabled = true
  state.activeEventSource?.close()
  state.activeEventSource = null
  state.activeRequest?.abort()

  if (state.activeUploadId) {
    fetch(`/api/uploads/${state.activeUploadId}`, { method: 'DELETE' }).catch(() => {})
  }

  if (state.activeJobId) {
    fetch(`/api/url-jobs/${state.activeJobId}`, { method: 'DELETE' }).catch(() => {})
  }
}

function finishRequest() {
  state.isWorking = false
  state.activeRequest = null
  state.activeUploadId = ''
  state.activeJobId = ''
  state.activeEventSource?.close()
  state.activeEventSource = null
  refs.convertBtn.disabled = !(state.file || state.videoUrl)
  refs.cancelBtn.disabled = false
  refs.cancelBtn.classList.add('hidden')
}

function renderProgress(progress, label = '') {
  const percent = Math.max(0, Math.min(100, progress))
  refs.progressBar.style.width = `${percent}%`
  refs.progressText.textContent = label || (refs.progressShell.classList.contains('is-indeterminate') ? '转码中' : `${percent}%`)
}

function cleanupOutput() {
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
  state.outputUrl = ''
  refs.downloadBtn.classList.add('hidden')
  refs.downloadBtn.removeAttribute('href')
  refs.progressShell.classList.remove('is-indeterminate')
}

async function readError(blob) {
  try {
    const data = JSON.parse(await blob.text())
    return data.error || '转换失败'
  } catch {
    return '转换失败'
  }
}

async function readResponseError(response) {
  try {
    const data = await response.json()
    return data.error || '请求失败'
  } catch {
    return '请求失败'
  }
}

function readRequestError(request) {
  try {
    const data = JSON.parse(request.responseText)
    return data.error || '上传失败'
  } catch {
    return '上传失败'
  }
}

function getFilenameFromDisposition(disposition) {
  if (!disposition) return ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/)
  if (utf8Match) return decodeURIComponent(utf8Match[1])
  const asciiMatch = disposition.match(/filename="([^"]+)"/)
  return asciiMatch ? asciiMatch[1] : ''
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0))
  const minutes = Math.floor(safeSeconds / 60)
  const restSeconds = safeSeconds % 60
  return `${minutes}:${String(restSeconds).padStart(2, '0')}`
}

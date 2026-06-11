import './styles.css'

const CODECS = {
  h264: 'H.264 / AVC',
  h265: 'H.265 / HEVC',
  vp9: 'VP9',
  mpeg4: 'MPEG-4 Part 2'
}

const app = document.querySelector('#app')

const state = {
  file: null,
  inputUrl: '',
  outputUrl: '',
  isWorking: false,
  uploadStartedAt: 0,
  activeRequest: null,
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
  state.inputUrl = URL.createObjectURL(file)

  refs.preview.src = state.inputUrl
  refs.preview.classList.add('is-visible')
  refs.emptyState.classList.add('hidden')
  refs.fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`
  refs.statusText.textContent = '已选择文件'
  refs.convertBtn.disabled = false
  renderProgress(0)
}

function convertVideoCodec() {
  if (!state.file || state.isWorking) return

  cleanupOutput()
  state.isWorking = true
  state.didCancel = false
  state.uploadStartedAt = performance.now()
  refs.convertBtn.disabled = true
  refs.cancelBtn.classList.remove('hidden')
  refs.statusText.textContent = '上传视频'
  renderProgress(0)

  const codec = refs.codecSelect.value
  const formData = new FormData()
  formData.append('video', state.file)
  formData.append('codec', codec)

  const request = new XMLHttpRequest()
  state.activeRequest = request
  request.open('POST', '/api/convert')
  request.responseType = 'blob'

  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return
    const uploadProgress = event.loaded / event.total
    const percent = Math.min(45, Math.round(uploadProgress * 45))
    const elapsedSeconds = Math.max((performance.now() - state.uploadStartedAt) / 1000, 0.1)
    const uploadSpeed = event.loaded / elapsedSeconds

    refs.statusText.textContent = `上传视频 ${formatBytes(event.loaded)} / ${formatBytes(event.total)}`
    renderProgress(percent, `${Math.round(uploadProgress * 100)}% · ${formatBytes(uploadSpeed)}/s`)
  }

  request.onloadstart = () => {
    refs.statusText.textContent = '上传视频'
  }

  request.onload = async () => {
    refs.progressShell.classList.remove('is-indeterminate')

    if (request.status < 200 || request.status >= 300) {
      refs.statusText.textContent = await readError(request.response)
      finishRequest()
      return
    }

    const filename = getFilenameFromDisposition(request.getResponseHeader('Content-Disposition')) || `video-${codec}.mp4`
    state.outputUrl = URL.createObjectURL(request.response)
    refs.downloadBtn.href = state.outputUrl
    refs.downloadBtn.download = filename
    refs.downloadBtn.classList.remove('hidden')
    refs.statusText.textContent = `已转换为 ${CODECS[codec]}`
    renderProgress(100)
    finishRequest()
  }

  request.onerror = () => {
    refs.progressShell.classList.remove('is-indeterminate')
    if (state.didCancel) {
      refs.statusText.textContent = '已停止上传并清理'
      renderProgress(0)
      finishRequest()
      return
    }

    refs.statusText.textContent = '网络错误，转换失败'
    finishRequest()
  }

  request.onabort = () => {
    refs.progressShell.classList.remove('is-indeterminate')
    refs.statusText.textContent = '已停止上传并清理'
    renderProgress(0)
    finishRequest()
  }

  request.upload.onload = () => {
    refs.statusText.textContent = `上传完成，服务器转码为 ${CODECS[codec]}`
    refs.progressShell.classList.add('is-indeterminate')
    renderProgress(45, '转码中')
  }

  request.send(formData)
}

function cancelActiveRequest() {
  if (!state.activeRequest || !state.isWorking) return

  state.didCancel = true
  refs.statusText.textContent = '正在停止'
  refs.cancelBtn.disabled = true
  state.activeRequest.abort()
}

function finishRequest() {
  state.isWorking = false
  state.activeRequest = null
  refs.convertBtn.disabled = !state.file
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

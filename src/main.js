import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import './styles.css'

const CORE_VERSION = '0.12.10'
const CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`

const CODECS = {
  h264: {
    label: 'H.264 / AVC',
    extension: 'mp4',
    mime: 'video/mp4',
    args: ['-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', 'faststart']
  },
  h265: {
    label: 'H.265 / HEVC',
    extension: 'mp4',
    mime: 'video/mp4',
    args: ['-c:v', 'libx265', '-crf', '28', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', 'faststart']
  },
  vp9: {
    label: 'VP9',
    extension: 'webm',
    mime: 'video/webm',
    args: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k']
  },
  mpeg4: {
    label: 'MPEG-4 Part 2',
    extension: 'mp4',
    mime: 'video/mp4',
    args: ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '160k', '-movflags', 'faststart']
  }
}

const app = document.querySelector('#app')
const ffmpeg = new FFmpeg()

const state = {
  file: null,
  inputUrl: '',
  outputUrl: '',
  isLoaded: false,
  isWorking: false
}

app.innerHTML = `
  <main class="shell">
    <section class="workspace simple-workspace">
      <aside class="panel controls">
        <div class="brand">
          <div class="brand-mark">FF</div>
          <div>
            <h1>视频编码转换器</h1>
            <p>只转换视频编码</p>
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
            开始转换编码
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
          <div class="progress-shell" aria-label="转换进度">
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
  downloadBtn: document.querySelector('#downloadBtn'),
  preview: document.querySelector('#preview'),
  emptyState: document.querySelector('#emptyState'),
  statusText: document.querySelector('#statusText'),
  progressBar: document.querySelector('#progressBar'),
  progressText: document.querySelector('#progressText')
}

ffmpeg.on('progress', ({ progress }) => {
  renderProgress(Math.max(0, Math.min(1, progress || 0)))
})

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

async function ensureFFmpegLoaded() {
  if (state.isLoaded) return

  refs.statusText.textContent = '加载 FFmpeg'
  refs.convertBtn.disabled = true

  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
  })

  state.isLoaded = true
}

async function convertVideoCodec() {
  if (!state.file || state.isWorking) return

  cleanupOutput()
  state.isWorking = true
  refs.convertBtn.disabled = true
  refs.statusText.textContent = '准备转换'
  renderProgress(0)

  const codecKey = refs.codecSelect.value
  const codec = CODECS[codecKey]
  const inputName = `input.${getExtension(state.file.name) || 'mp4'}`
  const outputName = `${sanitizeName(removeExtension(state.file.name)) || 'video'}-${codecKey}.${codec.extension}`

  try {
    await ensureFFmpegLoaded()

    refs.statusText.textContent = `转换为 ${codec.label}`
    await ffmpeg.writeFile(inputName, await fetchFile(state.file))
    await ffmpeg.exec(['-y', '-i', inputName, ...codec.args, outputName])

    const data = await ffmpeg.readFile(outputName)
    state.outputUrl = URL.createObjectURL(new Blob([data], { type: codec.mime }))

    refs.downloadBtn.href = state.outputUrl
    refs.downloadBtn.download = outputName
    refs.downloadBtn.classList.remove('hidden')
    refs.statusText.textContent = '转换完成'
    renderProgress(1)

    await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)])
  } catch (error) {
    refs.statusText.textContent = error?.message || '转换失败'
  } finally {
    state.isWorking = false
    refs.convertBtn.disabled = !state.file
  }
}

function renderProgress(progress) {
  const percent = Math.round(progress * 100)
  refs.progressBar.style.width = `${percent}%`
  refs.progressText.textContent = `${percent}%`
}

function cleanupOutput() {
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
  state.outputUrl = ''
  refs.downloadBtn.classList.add('hidden')
  refs.downloadBtn.removeAttribute('href')
}

function getExtension(name) {
  return name.includes('.') ? name.split('.').pop().toLowerCase() : ''
}

function removeExtension(name) {
  return name.replace(/\.[^/.]+$/, '')
}

function sanitizeName(name) {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

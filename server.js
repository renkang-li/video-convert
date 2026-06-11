import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { extname, join, resolve } from 'node:path'
import express from 'express'
import multer from 'multer'

const PORT = Number(process.env.PORT || 33219)
const HOST = process.env.HOST || '0.0.0.0'
const DIST_DIR = resolve('dist')
const TMP_DIR = resolve(process.env.UPLOAD_DIR || 'tmp')
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048)
const CHUNK_UPLOAD_MB = Number(process.env.CHUNK_UPLOAD_MB || 16)
const TMP_FILE_MAX_AGE_MS = Number(process.env.TMP_FILE_MAX_AGE_MIN || 30) * 60 * 1000
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

const app = express()
app.disable('x-powered-by')

const storage = multer.diskStorage({
  destination(request, file, callback) {
    callback(null, TMP_DIR)
  },
  filename(request, file, callback) {
    const filename = randomUUID()
    const filePath = join(TMP_DIR, filename)
    request.uploadTempPaths = [...(request.uploadTempPaths || []), filePath]
    callback(null, filename)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 1
  }
})

const chunkStorage = multer.diskStorage({
  destination(request, file, callback) {
    const uploadId = request.params.uploadId
    const chunkIndex = Number(request.params.chunkIndex)

    if (!isValidUploadId(uploadId) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      callback(new Error('上传分片参数无效'))
      return
    }

    const chunkDir = getChunkDir(uploadId)
    mkdir(chunkDir, { recursive: true })
      .then(() => callback(null, chunkDir))
      .catch((error) => callback(error))
  },
  filename(request, file, callback) {
    const chunkPath = getChunkPath(request.params.uploadId, request.params.chunkIndex)
    request.uploadTempPaths = [...(request.uploadTempPaths || []), chunkPath]
    callback(null, `${Number(request.params.chunkIndex)}.part`)
  }
})

const chunkUpload = multer({
  storage: chunkStorage,
  limits: {
    fileSize: CHUNK_UPLOAD_MB * 1024 * 1024,
    files: 1
  }
})

await mkdir(TMP_DIR, { recursive: true })
await cleanupStaleTempFiles()
setInterval(cleanupStaleTempFiles, 5 * 60 * 1000).unref()

app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  next()
})

app.use(express.json({ limit: '1mb' }))

app.use('/api/convert', (request, response, next) => {
  const startedAt = Date.now()
  const uploadSize = Number(request.headers['content-length'] || 0)
  let finished = false

  response.on('finish', () => {
    finished = true
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.log(`[convert] status=${response.statusCode} duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
  })

  request.on('aborted', () => {
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.warn(`[convert] aborted duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
    setTimeout(() => cleanupFiles(...(request.uploadTempPaths || [])), 1000).unref()
  })

  response.on('close', () => {
    if (finished) return
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.warn(`[convert] closed duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
    setTimeout(() => cleanupFiles(...(request.uploadTempPaths || [])), 1000).unref()
  })

  next()
})

app.use('/api/uploads', (request, response, next) => {
  const startedAt = Date.now()
  const uploadSize = Number(request.headers['content-length'] || 0)
  let finished = false

  response.on('finish', () => {
    finished = true
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.log(`[upload] ${request.method} ${request.path} status=${response.statusCode} duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
  })

  request.on('aborted', () => {
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.warn(`[upload] aborted ${request.method} ${request.path} duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
    setTimeout(() => cleanupFiles(...(request.uploadTempPaths || [])), 1000).unref()
  })

  response.on('close', () => {
    if (finished) return
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.warn(`[upload] closed ${request.method} ${request.path} duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
    setTimeout(() => cleanupFiles(...(request.uploadTempPaths || [])), 1000).unref()
  })

  next()
})

app.use('/api/convert-url', (request, response, next) => {
  const startedAt = Date.now()
  let finished = false

  response.on('finish', () => {
    finished = true
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.log(`[url] status=${response.statusCode} duration=${durationSeconds}s`)
  })

  response.on('close', () => {
    if (finished) return
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.warn(`[url] closed duration=${durationSeconds}s`)
    setTimeout(() => cleanupFiles(...(request.uploadTempPaths || [])), 1000).unref()
  })

  next()
})

app.post('/api/uploads', async (request, response) => {
  const uploadId = randomUUID()
  await mkdir(getChunkDir(uploadId), { recursive: true })
  response.json({ uploadId, chunkSizeMb: CHUNK_UPLOAD_MB })
})

app.post('/api/uploads/:uploadId/chunks/:chunkIndex', chunkUpload.single('chunk'), (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: '缺少上传分片' })
    return
  }

  response.json({ ok: true, size: request.file.size })
})

app.post('/api/uploads/:uploadId/complete', async (request, response) => {
  const { uploadId } = request.params
  const codecName = request.body?.codec
  const totalChunks = Number(request.body?.totalChunks)
  const originalName = String(request.body?.filename || 'video')
  const codec = CODECS[codecName]

  if (!isValidUploadId(uploadId)) {
    response.status(400).json({ error: '上传会话无效' })
    return
  }

  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 20000) {
    response.status(400).json({ error: '分片数量无效' })
    return
  }

  if (!codec) {
    response.status(400).json({ error: '目标编码不支持' })
    return
  }

  const uploadDir = getUploadDir(uploadId)
  const inputPath = join(uploadDir, 'input')
  const outputPath = join(uploadDir, `output.${codec.extension}`)
  const outputName = `${sanitizeName(removeExtension(originalName)) || 'video'}-${codecName}.${codec.extension}`
  const abortController = new AbortController()
  request.uploadTempPaths = [uploadDir]

  response.on('close', () => {
    if (!response.writableEnded) abortController.abort()
  })

  try {
    await mergeChunks(uploadId, totalChunks, inputPath, abortController.signal)
    await runFFmpeg(['-hide_banner', '-y', '-i', inputPath, ...codec.args, outputPath], abortController.signal)

    if (abortController.signal.aborted || response.destroyed) {
      await cleanupFiles(uploadDir)
      return
    }

    response.setHeader('Content-Type', codec.mime)
    response.setHeader('Content-Disposition', contentDisposition(outputName))
    response.setHeader('Cache-Control', 'no-store')
    createReadStream(outputPath).pipe(response)
    response.on('finish', () => cleanupFiles(uploadDir))
    response.on('close', () => cleanupFiles(uploadDir))
  } catch (error) {
    await cleanupFiles(uploadDir)
    if (abortController.signal.aborted || response.destroyed) return
    response.status(500).json({ error: error.message || '转换失败' })
  }
})

app.delete('/api/uploads/:uploadId', async (request, response) => {
  const { uploadId } = request.params

  if (!isValidUploadId(uploadId)) {
    response.status(400).json({ error: '上传会话无效' })
    return
  }

  await cleanupFiles(getUploadDir(uploadId))
  response.status(204).end()
})

app.post('/api/convert-url', async (request, response) => {
  const codecName = request.body?.codec
  const codec = CODECS[codecName]
  const remoteUrl = String(request.body?.url || '').trim()

  if (!codec) {
    response.status(400).json({ error: '目标编码不支持' })
    return
  }

  let parsedUrl
  try {
    parsedUrl = validateRemoteUrl(remoteUrl)
  } catch (error) {
    response.status(400).json({ error: error.message })
    return
  }

  const jobDir = join(TMP_DIR, randomUUID())
  const inputPath = join(jobDir, 'input')
  const outputPath = join(jobDir, `output.${codec.extension}`)
  const originalName = getFilenameFromUrl(parsedUrl) || 'video'
  const outputName = `${sanitizeName(removeExtension(originalName)) || 'video'}-${codecName}.${codec.extension}`
  const abortController = new AbortController()
  request.uploadTempPaths = [jobDir]

  response.on('close', () => {
    if (!response.writableEnded) abortController.abort()
  })

  try {
    await mkdir(jobDir, { recursive: true })
    await downloadRemoteVideo(parsedUrl, inputPath, abortController.signal)
    await runFFmpeg(['-hide_banner', '-y', '-i', inputPath, ...codec.args, outputPath], abortController.signal)

    if (abortController.signal.aborted || response.destroyed) {
      await cleanupFiles(jobDir)
      return
    }

    response.setHeader('Content-Type', codec.mime)
    response.setHeader('Content-Disposition', contentDisposition(outputName))
    response.setHeader('Cache-Control', 'no-store')
    createReadStream(outputPath).pipe(response)
    response.on('finish', () => cleanupFiles(jobDir))
    response.on('close', () => cleanupFiles(jobDir))
  } catch (error) {
    await cleanupFiles(jobDir)
    if (abortController.signal.aborted || response.destroyed) return
    response.status(500).json({ error: error.message || '链接下载或转换失败' })
  }
})

app.post('/api/convert', upload.single('video'), async (request, response) => {
  const file = request.file
  const codecName = request.body?.codec
  const codec = CODECS[codecName]
  const abortController = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) abortController.abort()
  })

  if (!file) {
    response.status(400).json({ error: '请选择视频文件' })
    return
  }

  if (!codec) {
    await removeFile(file.path)
    response.status(400).json({ error: '目标编码不支持' })
    return
  }

  const outputPath = join(TMP_DIR, `${randomUUID()}.${codec.extension}`)
  request.uploadTempPaths = [...(request.uploadTempPaths || []), outputPath]
  const outputName = `${sanitizeName(removeExtension(file.originalname)) || 'video'}-${codecName}.${codec.extension}`

  try {
    await runFFmpeg(['-hide_banner', '-y', '-i', file.path, ...codec.args, outputPath], abortController.signal)

    if (abortController.signal.aborted || response.destroyed) {
      await cleanupFiles(file.path, outputPath)
      return
    }

    response.setHeader('Content-Type', codec.mime)
    response.setHeader('Content-Disposition', contentDisposition(outputName))
    response.setHeader('Cache-Control', 'no-store')
    createReadStream(outputPath).pipe(response)
    response.on('finish', () => cleanupFiles(file.path, outputPath))
    response.on('close', () => cleanupFiles(file.path, outputPath))
  } catch (error) {
    await cleanupFiles(file.path, outputPath)
    if (abortController.signal.aborted || response.destroyed) return
    response.status(500).json({ error: error.message || '转换失败' })
  }
})

app.use((request, response, next) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    next()
    return
  }

  const filePath = resolveStaticPath(request.path)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendFile(response, join(DIST_DIR, 'index.html'))
    return
  }

  sendFile(response, filePath)
})

app.use((error, request, response, next) => {
  cleanupFiles(...(request.uploadTempPaths || []))

  if (request.aborted || response.destroyed) {
    return
  }

  if (response.headersSent) {
    next(error)
    return
  }

  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    response.status(413).json({ error: `文件太大，最大支持 ${MAX_UPLOAD_MB} MB` })
    return
  }

  response.status(500).json({ error: error.message || '服务器错误' })
})

app.listen(PORT, HOST, () => {
  console.log(`Video codec converter is running at http://${HOST}:${PORT}`)
})

function runFFmpeg(args, signal) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(FFMPEG_BIN, args)
    const logs = []
    let didAbort = false
    let didClose = false

    if (signal?.aborted) {
      process.kill('SIGTERM')
      reject(new Error('转换已停止'))
      return
    }

    signal?.addEventListener('abort', () => {
      didAbort = true
      process.kill('SIGTERM')
      setTimeout(() => {
        if (!didClose) process.kill('SIGKILL')
      }, 3000).unref()
    }, { once: true })

    process.stderr.on('data', (data) => {
      logs.push(data.toString())
      if (logs.length > 30) logs.shift()
    })

    process.on('error', (error) => {
      reject(new Error(`无法启动 FFmpeg：${error.message}`))
    })

    process.on('close', (code) => {
      didClose = true

      if (didAbort || signal?.aborted) {
        reject(new Error('转换已停止'))
        return
      }

      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(`FFmpeg 转换失败：${logs.join('').trim()}`))
    })
  })
}

function resolveStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname)
  const filePath = resolve(DIST_DIR, `.${decodedPath}`)

  if (!filePath.startsWith(DIST_DIR)) return join(DIST_DIR, 'index.html')
  if (decodedPath.endsWith('/')) return join(filePath, 'index.html')
  return filePath
}

function sendFile(response, filePath) {
  const extension = extname(filePath)

  response.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream')
  response.setHeader('Cache-Control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  createReadStream(filePath).pipe(response)
}

async function cleanupFiles(...paths) {
  await Promise.allSettled(paths.map((path) => removeFile(path)))
}

async function removeFile(path) {
  if (!path) return
  await rm(path, { force: true, recursive: true })
}

async function cleanupStaleTempFiles() {
  const now = Date.now()

  try {
    const entries = await readdir(TMP_DIR)

    await Promise.allSettled(entries.map(async (entry) => {
      const filePath = join(TMP_DIR, entry)
      const fileStat = await stat(filePath)
      if (!fileStat.isFile() && !fileStat.isDirectory()) return
      if (now - fileStat.mtimeMs < TMP_FILE_MAX_AGE_MS) return

      await removeFile(filePath)
      console.warn(`[tmp] removed stale file ${entry} size=${formatBytes(fileStat.size)}`)
    }))
  } catch (error) {
    console.warn(`[tmp] cleanup failed: ${error.message}`)
  }
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function removeExtension(name) {
  return name.replace(/\.[^/.]+$/, '')
}

function sanitizeName(name) {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
}

function validateRemoteUrl(value) {
  if (!value) throw new Error('请输入视频链接')

  let parsedUrl
  try {
    parsedUrl = new URL(value)
  } catch {
    throw new Error('视频链接格式无效')
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('只支持 HTTP 或 HTTPS 链接')
  }

  const hostname = parsedUrl.hostname.toLowerCase()
  if (PRIVATE_HOSTS.has(hostname)) {
    throw new Error('不支持本机或内网地址')
  }

  if (isPrivateIp(hostname)) {
    throw new Error('不支持内网 IP 地址')
  }

  return parsedUrl
}

function isPrivateIp(hostname) {
  const version = isIP(hostname)
  if (!version) return false

  if (version === 4) {
    const [a, b] = hostname.split('.').map(Number)
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }

  return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')
}

function getFilenameFromUrl(url) {
  const pathname = decodeURIComponent(url.pathname)
  const filename = pathname.split('/').filter(Boolean).pop()
  return filename || 'video'
}

async function downloadRemoteVideo(url, filePath, signal) {
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'video-convert/1.0'
    }
  })

  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length') || 0)
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024
  if (contentLength > maxBytes) {
    throw new Error(`文件太大，最大支持 ${MAX_UPLOAD_MB} MB`)
  }

  if (!response.body) {
    throw new Error('下载失败：响应内容为空')
  }

  await writeResponseBody(response.body, filePath, maxBytes, signal)
}

function writeResponseBody(body, filePath, maxBytes, signal) {
  return new Promise((resolvePromise, reject) => {
    const reader = body.getReader()
    const writeStream = createWriteStream(filePath)
    let downloadedBytes = 0
    let settled = false

    function finish(error) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)

      if (error) {
        writeStream.destroy()
        reject(error)
        return
      }

      writeStream.end(resolvePromise)
    }

    function abort() {
      reader.cancel().catch(() => {})
      finish(new Error('下载已停止'))
    }

    async function pump() {
      try {
        while (true) {
          if (signal?.aborted) {
            abort()
            return
          }

          const { done, value } = await reader.read()
          if (done) {
            finish()
            return
          }

          downloadedBytes += value.byteLength
          if (downloadedBytes > maxBytes) {
            await reader.cancel()
            finish(new Error(`文件太大，最大支持 ${MAX_UPLOAD_MB} MB`))
            return
          }

          if (!writeStream.write(value)) {
            await new Promise((resolveDrain) => writeStream.once('drain', resolveDrain))
          }
        }
      } catch (error) {
        finish(error)
      }
    }

    writeStream.on('error', finish)
    signal?.addEventListener('abort', abort, { once: true })
    pump()
  })
}

function isValidUploadId(uploadId) {
  return typeof uploadId === 'string' && UPLOAD_ID_PATTERN.test(uploadId)
}

function getUploadDir(uploadId) {
  return join(TMP_DIR, uploadId)
}

function getChunkDir(uploadId) {
  return join(getUploadDir(uploadId), 'chunks')
}

function getChunkPath(uploadId, chunkIndex) {
  return join(getChunkDir(uploadId), `${Number(chunkIndex)}.part`)
}

async function mergeChunks(uploadId, totalChunks, inputPath, signal) {
  const writeStream = createWriteStream(inputPath)

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      if (signal?.aborted) throw new Error('上传已停止')

      const chunkPath = getChunkPath(uploadId, index)
      await stat(chunkPath)
      await appendFileToStream(chunkPath, writeStream, signal)
    }
  } finally {
    await new Promise((resolvePromise) => writeStream.end(resolvePromise))
  }
}

function appendFileToStream(filePath, writeStream, signal) {
  return new Promise((resolvePromise, reject) => {
    const readStream = createReadStream(filePath)

    function cleanup() {
      readStream.off('error', reject)
      readStream.off('end', resolvePromise)
      signal?.removeEventListener('abort', abort)
    }

    function abort() {
      cleanup()
      readStream.destroy()
      reject(new Error('上传已停止'))
    }

    readStream.on('error', (error) => {
      cleanup()
      reject(error)
    })

    readStream.on('end', () => {
      cleanup()
      resolvePromise()
    })

    signal?.addEventListener('abort', abort, { once: true })

    readStream.on('data', (chunk) => {
      if (!writeStream.write(chunk)) {
        readStream.pause()
        writeStream.once('drain', () => readStream.resume())
      }
    })
  })
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

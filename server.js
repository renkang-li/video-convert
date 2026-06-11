import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { extname, join, resolve } from 'node:path'
import express from 'express'
import multer from 'multer'

const PORT = Number(process.env.PORT || 33219)
const HOST = process.env.HOST || '0.0.0.0'
const DIST_DIR = resolve('dist')
const TMP_DIR = resolve(process.env.UPLOAD_DIR || 'tmp')
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048)
const TMP_FILE_MAX_AGE_MS = Number(process.env.TMP_FILE_MAX_AGE_MIN || 30) * 60 * 1000

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

const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
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
  })

  response.on('close', () => {
    if (finished) return
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.warn(`[convert] closed status=${response.statusCode} duration=${durationSeconds}s request=${formatBytes(uploadSize)}`)
  })

  next()
})

app.post('/api/convert', upload.single('video'), async (request, response) => {
  const file = request.file
  const codecName = request.body?.codec
  const codec = CODECS[codecName]

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
  const outputName = `${sanitizeName(removeExtension(file.originalname)) || 'video'}-${codecName}.${codec.extension}`

  try {
    await runFFmpeg(['-hide_banner', '-y', '-i', file.path, ...codec.args, outputPath])

    response.setHeader('Content-Type', codec.mime)
    response.setHeader('Content-Disposition', contentDisposition(outputName))
    response.setHeader('Cache-Control', 'no-store')
    createReadStream(outputPath).pipe(response)
    response.on('finish', () => cleanupFiles(file.path, outputPath))
    response.on('close', () => cleanupFiles(file.path, outputPath))
  } catch (error) {
    await cleanupFiles(file.path, outputPath)
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

function runFFmpeg(args) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(FFMPEG_BIN, args)
    const logs = []

    process.stderr.on('data', (data) => {
      logs.push(data.toString())
      if (logs.length > 30) logs.shift()
    })

    process.on('error', (error) => {
      reject(new Error(`无法启动 FFmpeg：${error.message}`))
    })

    process.on('close', (code) => {
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
  await rm(path, { force: true })
}

async function cleanupStaleTempFiles() {
  const now = Date.now()

  try {
    const entries = await readdir(TMP_DIR)

    await Promise.allSettled(entries.map(async (entry) => {
      const filePath = join(TMP_DIR, entry)
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) return
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

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

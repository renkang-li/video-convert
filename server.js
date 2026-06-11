import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const PORT = Number(process.env.PORT || 33219)
const HOST = process.env.HOST || '0.0.0.0'
const DIST_DIR = resolve('dist')

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
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
}

const securityHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff'
}

const server = createServer((request, response) => {
  const filePath = resolveRequestPath(request.url || '/')

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendFile(response, join(DIST_DIR, 'index.html'))
    return
  }

  sendFile(response, filePath)
})

server.listen(PORT, HOST, () => {
  console.log(`Video codec converter is running at http://${HOST}:${PORT}`)
})

function resolveRequestPath(url) {
  const { pathname } = new URL(url, `http://${HOST}:${PORT}`)
  const decodedPath = decodeURIComponent(pathname)
  const safePath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(DIST_DIR, safePath)

  if (!filePath.startsWith(DIST_DIR)) return join(DIST_DIR, 'index.html')
  if (decodedPath.endsWith('/')) return join(filePath, 'index.html')
  return filePath
}

function sendFile(response, filePath) {
  const extension = extname(filePath)
  const headers = {
    ...securityHeaders,
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream'
  }

  if (filePath.includes('/assets/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['Cache-Control'] = 'no-cache'
  }

  response.writeHead(200, headers)
  createReadStream(filePath).pipe(response)
}

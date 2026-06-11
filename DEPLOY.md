# 部署说明

这个项目是纯前端视频编码转换器，生产环境先构建静态文件，再用 `server.js` 提供服务。

## 直接部署

```bash
npm ci
npm run build
npm start
```

默认监听端口是 `33219`：

```text
http://服务器IP:33219/
```

需要改端口时可以设置环境变量：

```bash
PORT=33219 npm start
```

## Docker 部署

```bash
docker build -t video-convert .
docker run -d --name video-convert -p 33219:33219 video-convert
```

## Nginx 反向代理

如果前面有 Nginx，反代到本服务即可，同时保留下面两个响应头：

```nginx
location / {
  proxy_pass http://127.0.0.1:33219;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy require-corp always;
}
```

这两个 header 是 ffmpeg.wasm 在浏览器里稳定运行需要的。

# 部署说明

这个项目是服务端视频编码转换器。浏览器上传视频，Node 服务接收文件后调用服务器本机的 `ffmpeg` 转码，再返回转换后的视频。

服务器需要安装原生 FFmpeg：

```bash
ffmpeg -version
```

如果没有安装，Ubuntu/Debian 可以执行：

```bash
sudo apt update
sudo apt install -y ffmpeg
```

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

可选环境变量：

```bash
PORT=33219
HOST=0.0.0.0
FFMPEG_PATH=ffmpeg
MAX_UPLOAD_MB=2048
UPLOAD_DIR=tmp
```

## Docker 部署

```bash
docker build -t video-convert .
docker run -d --name video-convert -p 33219:33219 video-convert
```

## Nginx 反向代理

如果前面有 Nginx，反代到本服务即可。大文件上传时建议同步调大 `client_max_body_size`：

```nginx
client_max_body_size 2048m;

location / {
  proxy_pass http://127.0.0.1:33219;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

FROM python:3.12-alpine

# ffmpeg 用于获取视频时长与生成截图（视频封面、看图连词配图）
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY server.py ./
COPY defaults ./defaults
COPY web ./web

# 媒体根目录：宿主机目录会挂载到这里（只读）
RUN mkdir -p /media/root /app/data/thumbs

ENV EK_PORT=13002 \
    EK_DATA=/app/data \
    EK_MEDIA_ROOT=/media/root \
    TZ=Asia/Shanghai

EXPOSE 13002

CMD ["python", "-u", "server.py"]

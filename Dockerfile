# 注意：用的是 slim（Debian/glibc），不是 alpine。
# 语音识别依赖 CTranslate2，只有 glibc 轮子，musl（Alpine）装不上。
FROM python:3.12-slim

ARG WHISPER_MODEL=base

# ffmpeg：视频时长、抽帧（封面/连词配图）、抽音轨、剥内嵌字幕
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py asr.py ./
COPY defaults ./defaults
COPY web ./web

# 构建时把 Whisper 模型烤进镜像：这样 NAS 运行时不用联网拉模型
# （构建机需要能访问 huggingface.co；GitHub Actions 可以，本地构建若被墙可跳过）
RUN pip install --no-cache-dir faster-whisper==1.1.0 \
    && python -c "from faster_whisper import WhisperModel; \
WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8'); \
print('whisper model ready:', '${WHISPER_MODEL}')" \
    || echo "[警告] Whisper 模型下载失败，字幕提取仍可用，语音识别不可用"

# 媒体根目录：宿主机目录会挂载到这里（只读）
RUN mkdir -p /media/root /app/data/thumbs

ENV EK_PORT=13002 \
    EK_DATA=/app/data \
    EK_MEDIA_ROOT=/media/root \
    EK_WHISPER_MODEL=${WHISPER_MODEL} \
    TZ=Asia/Shanghai

EXPOSE 13002

CMD ["python", "-u", "server.py"]

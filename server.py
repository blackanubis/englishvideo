#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小孩英语启蒙学习网页 - 后端服务
仅使用 Python 标准库，无第三方依赖（语音识别为可选依赖，缺失时自动降级）。
提供：静态页面、配置读写、目录浏览、视频扫描、ffmpeg 抽帧、
      Range 视频流（iPad 必需）、词库、图词标注、学习记录、
      字幕/语音提取单词。
"""

import asr
import csv
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DEFAULTS_DIR = os.path.join(BASE_DIR, "defaults")
DATA_DIR = os.environ.get("EK_DATA", os.path.join(BASE_DIR, "data"))
THUMB_DIR = os.path.join(DATA_DIR, "thumbs")

# 图标相关 MIME（部分系统的 mimetypes 不认识 .svg / .webmanifest）
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/x-icon", ".ico")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("application/manifest+json", ".webmanifest")

CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
LIBRARY_FILE = os.path.join(DATA_DIR, "library.json")
PROGRESS_FILE = os.path.join(DATA_DIR, "progress.json")
ANNOT_FILE = os.path.join(DATA_DIR, "annotations.json")
WORDS_FILE = os.path.join(DATA_DIR, "words.csv")

MEDIA_ROOT = os.environ.get("EK_MEDIA_ROOT", "/media/root")
HOST_ROOT = os.environ.get("EK_HOST_ROOT", "")
PORT = int(os.environ.get("EK_PORT", "13002"))

VIDEO_EXT = (".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".flv")
IOS_OK_EXT = (".mp4", ".m4v", ".mov")  # iPad Safari 实际能播的

DEFAULT_CONFIG = {
    "videoDirs": [],
    "dailyMinutes": 20,
    "plan": {"video": 8, "speak": 5, "game": 5, "summary": 2},
    "categories": ["animals", "fruit", "colors", "numbers"],
    "wordsPerDay": 10,
    "pairsPerRound": 6,
    "reviewWords": 10,
    "frameInterval": 15,
    "maxFramesPerVideo": 40,
    "lastVideo": None,
}

SCAN_STATE = {
    "running": False,
    "message": "",
    "total": 0,
    "done": 0,
    "startedAt": 0,
}
LOCK = threading.Lock()


# ---------- 基础工具 ----------

def ensure_files():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(THUMB_DIR, exist_ok=True)
    if not os.path.exists(WORDS_FILE):
        src = os.path.join(DEFAULTS_DIR, "words.csv")
        if os.path.exists(src):
            shutil.copyfile(src, WORDS_FILE)
    if not os.path.exists(CONFIG_FILE):
        save_json(CONFIG_FILE, DEFAULT_CONFIG)
    if not os.path.exists(PROGRESS_FILE):
        save_json(PROGRESS_FILE, {"days": {}, "mastered": {}, "lastDate": None})
    if not os.path.exists(ANNOT_FILE):
        save_json(ANNOT_FILE, {"items": {}})


def load_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_config():
    cfg = load_json(CONFIG_FILE, {})
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg or {})
    plan = dict(DEFAULT_CONFIG["plan"])
    plan.update((cfg or {}).get("plan", {}) or {})
    merged["plan"] = plan
    return merged


def have_ffmpeg():
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def hw_probe():
    """探测硬件编解码能力。

    Intel UHD 核显（QSV）对 Whisper 语音识别没有任何帮助（CTranslate2 只认 NVIDIA CUDA），
    但对「mkv/avi 转 mp4」这类转码任务可以提速数倍，所以单独探测出来供设置页显示。
    """
    out = {"dri": False, "driNodes": [], "qsv": False, "vaapi": False,
           "nvidia": False}
    try:
        if os.path.isdir("/dev/dri"):
            nodes = sorted(os.listdir("/dev/dri"))
            out["dri"] = bool(nodes)
            out["driNodes"] = nodes[:6]
    except Exception:
        pass
    if shutil.which("ffmpeg"):
        try:
            p = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                               capture_output=True, timeout=25)
            t = (p.stdout or b"").decode("utf-8", "replace")
            out["qsv"] = "h264_qsv" in t
            out["vaapi"] = "h264_vaapi" in t
            out["nvidia"] = "h264_nvenc" in t
        except Exception:
            pass
    return out


def safe_under(child, root):
    """判断 child 是否在 root 之内，防目录穿越"""
    try:
        child = os.path.realpath(child)
        root = os.path.realpath(root)
    except Exception:
        return False
    return child == root or child.startswith(root.rstrip(os.sep) + os.sep)


def to_display_path(p):
    """把容器内路径显示成 NAS 上的真实路径"""
    if HOST_ROOT and p.startswith(MEDIA_ROOT):
        return HOST_ROOT.rstrip("/") + p[len(MEDIA_ROOT):]
    return p


def to_container_path(p):
    """把 NAS 路径转回容器内路径（家长直接填 NAS 路径也能用）"""
    if HOST_ROOT and p.startswith(HOST_ROOT.rstrip("/")):
        return MEDIA_ROOT + p[len(HOST_ROOT.rstrip("/")):]
    return p


def pretty_title(filename):
    name = os.path.splitext(filename)[0]
    name = re.sub(r"^[Ss]?\d{1,2}[Ee]?\d{0,3}\s*[-_. ]*", "", name)
    name = re.sub(r"^\d{1,3}\s*[-_. ]*", "", name)
    name = name.replace("_", " ").replace(".", " ").strip()
    return name or filename


def natkey(s):
    """自然排序键：001 < 002 < 010 < 100，而不是按字符串的 1 < 10 < 2"""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", s or "")]


def sort_library(lib):
    """视频一律按原始文件名的正向（升序）自然排序返回，
    不用 title——title 会把开头的序号剥掉，排序就乱了"""
    return sorted(lib, key=lambda v: natkey(v.get("name") or v.get("path") or ""))


def vid_of(path):
    return hashlib.md5(path.encode("utf-8")).hexdigest()[:12]


# ---------- 视频扫描与抽帧 ----------

def probe_duration(path):
    if not have_ffmpeg():
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, timeout=20)
        return float(out.stdout.decode().strip() or 0) or None
    except Exception:
        return None


def probe_media(path):
    """用 ffprobe 探测时长与编码。返回 {duration, vcodec, acodec}，缺失时不带对应键。"""
    if not shutil.which("ffprobe"):
        return {}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=codec_name,codec_type",
             "-of", "json", path],
            capture_output=True, timeout=20)
        data = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
    except Exception:
        return {}
    info = {}
    try:
        info["duration"] = float(data["format"]["duration"]) or None
    except Exception:
        pass
    for s in data.get("streams", []):
        t = s.get("codec_type")
        if t == "video" and "vcodec" not in info:
            info["vcodec"] = s.get("codec_name")
        elif t == "audio" and "acodec" not in info:
            info["acodec"] = s.get("codec_name")
    return info


def grab_frame(path, out_jpg, at_sec, width=480):
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(at_sec), "-i", path, "-frames:v", "1",
             "-vf", "scale=%d:-2" % width, "-q:v", "5", out_jpg],
            capture_output=True, timeout=60)
        return os.path.exists(out_jpg)
    except Exception:
        return False


def collect_videos():
    cfg = load_config()
    files = []
    for d in cfg.get("videoDirs", []):
        d = to_container_path(d)
        if not os.path.isdir(d):
            continue
        for root, dirs, names in os.walk(d):
            dirs.sort()
            for n in sorted(names):
                if n.lower().endswith(VIDEO_EXT) and not n.startswith("."):
                    files.append(os.path.join(root, n))
    # 与前端展示保持一致：按文件名正向自然排序
    return sorted(files, key=lambda p: (natkey(os.path.basename(p)),
                                        os.path.dirname(p)))


def run_scan(full=False):
    if SCAN_STATE["running"]:
        return
    SCAN_STATE.update({"running": True, "message": "正在扫描视频", "total": 0,
                       "done": 0, "startedAt": time.time()})

    def worker():
        try:
            files = collect_videos()
            SCAN_STATE["total"] = len(files)
            old = {v["path"]: v for v in load_json(LIBRARY_FILE, [])}
            library = []
            ffmpeg_ok = have_ffmpeg()
            for idx, path in enumerate(files):
                v = old.get(path) or {}
                item = {
                    "id": vid_of(path),
                    "path": path,
                    "displayPath": to_display_path(path),
                    "name": os.path.basename(path),
                    "title": pretty_title(os.path.basename(path)),
                    "ext": os.path.splitext(path)[1].lower(),
                    "size": os.path.getsize(path),
                    "duration": v.get("duration"),
                    "vcodec": v.get("vcodec"),
                    "acodec": v.get("acodec"),
                    "cover": None,
                    "frames": v.get("frames", []),
                    "iosOk": os.path.splitext(path)[1].lower() in IOS_OK_EXT,
                }
                if full or item["duration"] is None or not item["vcodec"]:
                    info = probe_media(path)
                    if info.get("duration"):
                        item["duration"] = info["duration"]
                    item["vcodec"] = info.get("vcodec") or item["vcodec"]
                    item["acodec"] = info.get("acodec") or item["acodec"]
                library.append(item)
                SCAN_STATE["done"] = idx + 1
                SCAN_STATE["message"] = "已扫描 %d/%d" % (idx + 1, len(files))
            save_json(LIBRARY_FILE, library)
            if ffmpeg_ok:
                make_thumbs(library)
            else:
                SCAN_STATE["message"] = "扫描完成（未检测到 ffmpeg，跳过截图）"
        except Exception as e:
            SCAN_STATE["message"] = "扫描出错：%s" % e
        finally:
            SCAN_STATE["running"] = False

    threading.Thread(target=worker, daemon=True).start()


def make_thumbs(library):
    cfg = load_config()
    interval = int(cfg.get("frameInterval", 15) or 15)
    maxf = int(cfg.get("maxFramesPerVideo", 40) or 40)
    for i, item in enumerate(library):
        if SCAN_STATE.get("cancel"):
            break
        SCAN_STATE["message"] = "正在生成截图 %d/%d" % (i + 1, len(library))
        vdir = os.path.join(THUMB_DIR, item["id"])
        os.makedirs(vdir, exist_ok=True)
        dur = item.get("duration") or 0
        cover = os.path.join(vdir, "cover.jpg")
        if not os.path.exists(cover):
            grab_frame(item["path"], cover, max(dur * 0.1, 1))
        if os.path.exists(cover):
            item["cover"] = "/api/thumbs/%s/cover.jpg" % item["id"]
        if dur > 0 and (not item.get("frames")):
            frames = []
            t = interval
            n = 0
            while t < dur and n < maxf:
                fp = os.path.join(vdir, "%03d.jpg" % n)
                if grab_frame(item["path"], fp, t):
                    frames.append("/api/thumbs/%s/%03d.jpg" % (item["id"], n))
                    n += 1
                t += interval
            item["frames"] = frames
        save_json(LIBRARY_FILE, library)
    SCAN_STATE["message"] = "扫描与截图完成"


# ---------- 词库 ----------

def read_words():
    words = []
    if not os.path.exists(WORDS_FILE):
        return words
    with open(WORDS_FILE, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if not row.get("word"):
                continue
            words.append({
                "word": (row.get("word") or "").strip(),
                "zh": (row.get("zh") or "").strip(),
                "category": (row.get("category") or "").strip(),
                "emoji": (row.get("emoji") or "").strip(),
                "sentence": (row.get("sentence") or "").strip(),
            })
    return words


# ---------- HTTP Handler ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "EnglishKids/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # --- 响应辅助 ---

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_bytes(self, body, ctype, code=200, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_file(self, path, ctype=None, attachment=False):
        if not os.path.isfile(path):
            self.send_json({"error": "not found"}, 404)
            return
        size = os.path.getsize(path)
        if ctype is None:
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        partial = False
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                partial = True
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                if start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        if attachment:
            self.send_header("Content-Disposition",
                             'attachment; filename="%s"' % os.path.basename(path))
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def send_transcode(self, path):
        """实时转码为 H.264/AAC 720p fragmented MP4 流（不支持拖动进度，但保证能播）"""
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
               "-vf", "scale=-2:720",
               "-c:a", "aac", "-b:a", "128k", "-ac", "2",
               "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL)
        except Exception as e:
            sys.stderr.write("[transcode] ffmpeg 启动失败: %s\n" % e)
            return
        try:
            while True:
                chunk = proc.stdout.read(262144)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            pass  # 客户端断开（暂停/换集）属正常
        finally:
            try:
                proc.kill()
            except Exception:
                pass

    # --- 路由 ---

    def do_HEAD(self):
        self.route()

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def route(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/"):
            self.api(path, qs)
            return

        rel = path.lstrip("/") or "index.html"
        target = os.path.abspath(os.path.join(WEB_DIR, rel))
        if not safe_under(target, WEB_DIR):
            self.send_json({"error": "forbidden"}, 403)
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.exists(target):
            target = os.path.join(WEB_DIR, "index.html")
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if target.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif target.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif target.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        self.send_file(target, ctype)

    def api(self, path, qs):
        if path == "/api/health":
            cfg = load_config()
            lib = load_json(LIBRARY_FILE, [])
            bad = [v for v in lib if not v.get("iosOk")]
            self.send_json({
                "ok": True,
                "ffmpeg": have_ffmpeg(),
                "mediaRoot": MEDIA_ROOT,
                "hostRoot": HOST_ROOT,
                "videoDirs": cfg.get("videoDirs", []),
                "videoCount": len(lib),
                "badFormatCount": len(bad),
                "badFormats": [v["name"] for v in bad[:10]],
                "scan": SCAN_STATE,
                "asr": asr.whisper_status(),
                "hw": hw_probe(),
            })
            return

        if path == "/api/config":
            if self.command == "POST":
                data = self.read_body()
                cfg = load_config()
                cfg.update(data or {})
                cfg["videoDirs"] = [to_container_path(p) for p in cfg.get("videoDirs", [])]
                save_json(CONFIG_FILE, cfg)
                self.send_json({"ok": True, "config": public_config(cfg)})
            else:
                self.send_json({"config": public_config(load_config())})
            return

        if path == "/api/browse":
            want = qs.get("path", [""])[0]
            base = want or MEDIA_ROOT
            base = to_container_path(base)
            if not safe_under(base, MEDIA_ROOT):
                base = MEDIA_ROOT
            if not os.path.isdir(base):
                base = MEDIA_ROOT
            entries = []
            try:
                for name in sorted(os.listdir(base)):
                    full = os.path.join(base, name)
                    if not os.path.isdir(full) or name.startswith("."):
                        continue
                    cnt = 0
                    for root, dirs, files in os.walk(full):
                        cnt += sum(1 for f in files if f.lower().endswith(VIDEO_EXT))
                        if cnt > 999:
                            break
                    entries.append({
                        "name": name,
                        "path": to_display_path(full),
                        "containerPath": full,
                        "videoCount": cnt,
                    })
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
                return
            parts = []
            cur = base
            while safe_under(cur, MEDIA_ROOT) and cur != MEDIA_ROOT:
                parts.insert(0, {"name": os.path.basename(cur) or cur,
                                 "path": to_display_path(cur)})
                cur = os.path.dirname(cur)
            self.send_json({
                "current": to_display_path(base),
                "containerPath": base,
                "parent": to_display_path(os.path.dirname(base)) if base != MEDIA_ROOT else None,
                "crumbs": [{"name": "根目录", "path": to_display_path(MEDIA_ROOT)}] + parts,
                "entries": entries,
            })
            return

        if path == "/api/scan" and self.command == "POST":
            data = self.read_body()
            run_scan(bool(data.get("full")))
            self.send_json({"ok": True, "scan": SCAN_STATE})
            return

        if path == "/api/scan/status":
            self.send_json({"scan": SCAN_STATE})
            return

        if path == "/api/videos":
            lib = load_json(LIBRARY_FILE, [])
            self.send_json({"videos": sort_library(lib), "scan": SCAN_STATE})
            return

        if path == "/api/stream":
            vp = qs.get("path", [""])[0]
            if not vp:
                vid = qs.get("id", [""])[0]
                lib = load_json(LIBRARY_FILE, [])
                match = next((v for v in lib if v["id"] == vid), None)
                vp = match["path"] if match else ""
            vp = to_container_path(vp)
            cfg = load_config()
            allowed = any(safe_under(vp, to_container_path(d))
                          for d in cfg.get("videoDirs", [])) or safe_under(vp, MEDIA_ROOT)
            if not allowed or not os.path.isfile(vp):
                self.send_json({"error": "video not found or not allowed"}, 404)
                return
            ctype = mimetypes.guess_type(vp)[0] or "video/mp4"
            if qs.get("transcode", ["0"])[0] in ("1", "true"):
                # 兼容模式：服务器实时转码为 H.264/AAC 720p（应对 HEVC 等浏览器解不了的编码）
                if not shutil.which("ffmpeg"):
                    self.send_json({"error": "ffmpeg not available"}, 503)
                    return
                self.send_transcode(vp)
                return
            self.send_file(vp, ctype)
            return

        if path.startswith("/api/thumbs/"):
            rel = path[len("/api/thumbs/"):]
            target = os.path.abspath(os.path.join(THUMB_DIR, rel))
            if not safe_under(target, THUMB_DIR) or not os.path.isfile(target):
                self.send_json({"error": "not found"}, 404)
                return
            self.send_file(target, "image/jpeg")
            return

        if path == "/api/words":
            cats = None
            cfg = load_config()
            if cfg.get("categories"):
                cats = set(cfg["categories"])
            words = read_words()
            if cats:
                words = [w for w in words if not w["category"] or w["category"] in cats]
            self.send_json({"words": words})
            return

        if path == "/api/categories":
            seen = {}
            for w in read_words():
                c = w.get("category") or "other"
                seen[c] = seen.get(c, 0) + 1
            self.send_json({"categories": [{"id": k, "count": v} for k, v in seen.items()]})
            return

        if path == "/api/annotations":
            if self.command == "POST":
                data = self.read_body()
                save_json(ANNOT_FILE, {"items": (data or {}).get("items", {})})
                self.send_json({"ok": True})
            else:
                self.send_json(load_json(ANNOT_FILE, {"items": {}}))
            return

        if path == "/api/annotate" and self.command == "POST":
            data = self.read_body()
            img = (data or {}).get("image")
            word = (data or {}).get("word")
            if not img or not word:
                self.send_json({"error": "missing image or word"}, 400)
                return
            ann = load_json(ANNOT_FILE, {"items": {}})
            items = ann.setdefault("items", {})
            items.setdefault(word.lower(), [])
            if img not in items[word.lower()]:
                items[word.lower()].append(img)
            save_json(ANNOT_FILE, ann)
            self.send_json({"ok": True, "items": items})
            return

        if path == "/api/annotate/remove" and self.command == "POST":
            data = self.read_body()
            img, word = (data or {}).get("image"), (data or {}).get("word")
            ann = load_json(ANNOT_FILE, {"items": {}})
            items = ann.setdefault("items", {})
            if word and img in items.get(word.lower(), []):
                items[word.lower()].remove(img)
            save_json(ANNOT_FILE, ann)
            self.send_json({"ok": True, "items": items})
            return

        if path == "/api/progress":
            if self.command == "POST":
                data = self.read_body()
                save_json(PROGRESS_FILE, data or {})
                self.send_json({"ok": True})
            else:
                self.send_json(load_json(PROGRESS_FILE, {"days": {}}))
            return

        if path == "/api/reset" and self.command == "POST":
            save_json(PROGRESS_FILE, {"days": {}, "mastered": {}, "lastDate": None})
            self.send_json({"ok": True})
            return

        # ---- 字幕 / 语音提取单词 ----

        if path == "/api/asr/status":
            self.send_json({"state": asr.STATE, "caps": asr.whisper_status()})
            return

        if path == "/api/asr/start" and self.command == "POST":
            data = self.read_body()
            ids = (data or {}).get("ids") or []
            force = bool((data or {}).get("force"))
            fast = bool((data or {}).get("fast"))
            sec = float((data or {}).get("sec") or 0)
            if sec > 0:
                asr.FAST_SEC = sec
            lib = load_json(LIBRARY_FILE, [])
            items = [v for v in lib if (not ids or v["id"] in ids)]
            if not items:
                self.send_json({"error": "没有可处理的视频，先扫描视频库"}, 400)
                return
            asr.run_job(items, force, fast)
            self.send_json({"ok": True, "count": len(items), "fast": fast,
                            "sec": asr.FAST_SEC})
            return

        if path == "/api/asr/suggest":
            try:
                limit = int(qs.get("limit", ["200"])[0])
            except Exception:
                limit = 200
            try:
                min_count = int(qs.get("minCount", ["2"])[0])
            except Exception:
                min_count = 2
            self.send_json({"words": asr.suggest(limit=limit, min_count=min_count)})
            return

        if path == "/api/asr/import" and self.command == "POST":
            data = self.read_body() or {}
            picked = data.get("words") or []
            lib = {v["id"]: v for v in load_json(LIBRARY_FILE, [])}
            ann = load_json(ANNOT_FILE, {"items": {}})
            items = ann.setdefault("items", {})
            rows = []
            framed = 0
            for p in picked:
                w = (p.get("word") or "").strip()
                if not w:
                    continue
                rows.append({"word": w, "zh": p.get("zh", ""),
                             "category": p.get("category", ""),
                             "emoji": p.get("emoji", ""),
                             "sentence": (p.get("sample") or "")[:80]})
                if p.get("useFrame"):
                    vid = (p.get("videoId") or "").strip()
                    v = lib.get(vid)
                    if v:
                        url = asr.frame_for_word(vid, v.get("path"), w,
                                                 float(p.get("time") or 0))
                        if url:
                            items.setdefault(w.lower(), [])
                            if url not in items[w.lower()]:
                                items[w.lower()].append(url)
                                framed += 1
            asr.append_words(rows)
            save_json(ANNOT_FILE, ann)
            self.send_json({"ok": True, "added": len(rows), "framed": framed})
            return

        if path == "/api/asr/clear" and self.command == "POST":
            for d in (asr.TRANS_DIR, asr.SUB_DIR):
                try:
                    for n in os.listdir(d):
                        os.remove(os.path.join(d, n))
                except Exception:
                    pass
            self.send_json({"ok": True})
            return

        if path == "/api/subtitle":
            vid = re.sub(r"[^A-Za-z0-9_-]", "", qs.get("id", [""])[0])
            fp = os.path.join(asr.SUB_DIR, "%s.srt" % vid)
            if not os.path.isfile(fp):
                self.send_json({"error": "no subtitle"}, 404)
                return
            self.send_file(fp, "text/vtt; charset=utf-8")
            return

        self.send_json({"error": "unknown api"}, 404)


def public_config(cfg):
    out = dict(cfg)
    out["videoDirs"] = [to_display_path(p) for p in cfg.get("videoDirs", [])]
    out["hostRoot"] = HOST_ROOT
    out["mediaRoot"] = MEDIA_ROOT
    return out


def main():
    ensure_files()
    cfg = load_config()
    if not cfg.get("videoDirs"):
        print("[提示] 尚未配置视频目录，请打开网页 → 家长设置 → 选择视频目录")
    if not have_ffmpeg():
        print("[警告] 未检测到 ffmpeg，将无法获取时长与生成截图")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("英语启蒙服务已启动： http://<NAS-IP>:%d" % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()

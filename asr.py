#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从视频里提取单词：字幕优先（内嵌 / 外挂），没有字幕才用 Whisper 转写。

输出：「文本 + 时间戳」→ 清洗成候选词表 → 家长勾选 → 进 words.csv。
faster_whisper 是可选依赖，缺失时字幕路线依然可用。
"""

import csv
import json
import os
import re
import shutil
import subprocess
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULTS_DIR = os.path.join(BASE_DIR, "defaults")
DATA_DIR = os.environ.get("EK_DATA", os.path.join(BASE_DIR, "data"))
THUMB_DIR = os.path.join(DATA_DIR, "thumbs")

ASR_DIR = os.path.join(DATA_DIR, "asr")
TRANS_DIR = os.path.join(ASR_DIR, "transcripts")
SUB_DIR = os.path.join(ASR_DIR, "subs")
AUDIO_DIR = os.path.join(ASR_DIR, "audio")
WORD_FRAME_DIR = os.path.join(THUMB_DIR, "asr")

MODEL_SIZE = os.environ.get("EK_WHISPER_MODEL", "base")
MODEL_DIR = os.environ.get("EK_WHISPER_DIR", os.path.join(BASE_DIR, "models"))
DICT_FILE = os.path.join(DEFAULTS_DIR, "dict-en-zh.csv")

# 运行设备：auto(有 NVIDIA CUDA 就用 GPU) / cuda / cpu
# 注意：Intel 核显、AMD 核显均不支持——CTranslate2 只认 NVIDIA CUDA
DEVICE_PREF = os.environ.get("EK_WHISPER_DEVICE", "auto").strip().lower()
THREADS = int(os.environ.get("EK_WHISPER_THREADS", "0") or 0)
# 快速模式：每集只转写前 N 秒（0 = 全片）。儿歌词汇重复度高，
# 前 90~120 秒基本能覆盖全部生词，速度提升 3~5 倍
FAST_SEC = float(os.environ.get("EK_ASR_MAX_SEC", "0") or 0)

DEVICE_INFO = {"device": None, "compute": None, "threads": 0,
               "cuda": False, "cudaName": None, "fast": FAST_SEC}

SUB_EXT = (".srt", ".vtt", ".ass", ".ssa")

STATE = {
    "running": False,
    "message": "",
    "total": 0,
    "done": 0,
    "startedAt": 0,
    "results": [],
}

_MODEL = None
_DICT = None
_LOCK = threading.Lock()

# 只留实词：这些高频虚词/代词/助动词一律丢掉
STOPWORDS = set("""
a an the this that these those i me my mine we us our you your he him his she her it its they them their
is am are was were be been being do does did doing have has had having will would can could shall should
may might must let lets dont don't isnt isn't didn't doesn't
and or but so if then than because as when where what which who whom whose how why
to of in on at for with from by about into over under again very too also just now
here there up down out off away back all any some no not nor only own same s t
oh ah hey yeah yeahs la la la ooh oohh hmm hooray yippee wow oops uh um er
one two three four five six seven eight nine ten
im ive id ill youre hes shes theyre its lets thats whats
gonna wanna gotta ain't
""".split())

# 分类种子词：命中即归到对应主题，方便连词/跟读按主题出词
CATEGORY_SEEDS = {
    "animals": """cat dog bird fish cow pig duck sheep horse chicken rabbit bear lion tiger monkey elephant
        frog mouse goat donkey deer wolf fox snake turtle penguin dolphin whale zebra giraffe panda bee ant
        butterfly horsey birdie doggy kitty piggy duckling lamb calf puppy kitten""",
    "fruit": """apple banana orange grape pear peach plum cherry strawberry watermelon lemon melon mango
        pineapple kiwi berry berries coconut papaya""",
    "colors": """red blue yellow green orange black white purple pink brown gray grey gold silver""",
    "numbers": """zero one two three four five six seven eight nine ten eleven twelve twenty hundred thousand
        first second third""",
    "body": """head face eye eyes ear ears nose mouth tooth teeth hair hand hands arm arms leg legs foot feet
        finger fingers toe toes knee shoulder belly tummy neck back chin cheek lip tongue""",
    "family": """mom dad mother father mum papa baby brother sister grandma grandpa aunt uncle family
        boy girl man woman child children son daughter friend friends""",
    "actions": """run jump walk swim eat drink sleep sing dance play read write draw fly climb sit stand
        look listen wash brush drive ride catch throw kick hop skip clap wash cook help give take make
        open close push pull carry hold""",
    "transport": """car bus train plane ship boat bike bicycle truck taxi subway rocket tractor firetruck
        ambulance helicopter scooter wagon""",
}
_SEED_MAP = {}
for _c, _ws in CATEGORY_SEEDS.items():
    for _w in _ws.split():
        _SEED_MAP[_w] = _c


# ---------- 依赖探测 ----------

def have_ffmpeg():
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def have_whisper():
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _hf_hub():
    home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"),
                                                     ".cache", "huggingface")
    return os.path.join(home, "hub")


def model_ready():
    """镜像构建时已把模型烤进 HF 缓存，或外部挂载了模型目录"""
    if os.path.isdir(MODEL_DIR) and os.listdir(MODEL_DIR):
        return True
    hub = _hf_hub()
    if os.path.isdir(hub):
        for n in os.listdir(hub):
            low = n.lower()
            if "faster-whisper" in low and MODEL_SIZE in low:
                return True
    return False


def cuda_count():
    """返回可用的 NVIDIA GPU 数量。Intel / AMD 核显一律返回 0"""
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count()
    except Exception:
        return 0


def cuda_name():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name",
                              "--format=csv,noheader"],
                             capture_output=True, timeout=10)
        return (out.stdout.decode().strip().splitlines() or [""])[0] or None
    except Exception:
        return None


def whisper_status():
    n = cuda_count()
    return {
        "ffmpeg": have_ffmpeg(),
        "whisper": have_whisper(),
        "modelReady": model_ready(),
        "modelSize": MODEL_SIZE,
        "modelDir": MODEL_DIR,
        "cuda": n,
        "cudaName": cuda_name() if n else None,
        "prefer": DEVICE_PREF,
        "runtime": DEVICE_INFO,
        "cores": os.cpu_count() or 1,
        "fastSec": FAST_SEC,
    }


def load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    from faster_whisper import WhisperModel

    n = cuda_count()
    device, compute = "cpu", "int8"
    if DEVICE_PREF in ("auto", "cuda") and n > 0:
        device, compute = "cuda", "float16"
    if DEVICE_PREF == "cpu":
        device, compute = "cpu", "int8"

    threads = THREADS or max(1, min(8, os.cpu_count() or 4))
    path = MODEL_DIR if (os.path.isdir(MODEL_DIR) and os.listdir(MODEL_DIR)) \
        else MODEL_SIZE
    kwargs = {"device": device, "compute_type": compute}
    if device == "cpu":
        kwargs["cpu_threads"] = threads
    _MODEL = WhisperModel(path, **kwargs)

    DEVICE_INFO.update({"device": device, "compute": compute, "cuda": n > 0,
                        "cudaName": cuda_name() if n else None,
                        "threads": threads if device == "cpu" else 0,
                        "fast": FAST_SEC})
    print("[asr] 识别引擎：%s / %s%s" % (
        device, compute,
        " (%d 线程)" % threads if device == "cpu" else " (GPU)"))
    return _MODEL


# ---------- 字幕解析 ----------

def _t2s(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt(text):
    segs = []
    for block in re.split(r"\r?\n\r?\n", text.strip()):
        m = re.search(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
                      r"(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})", block)
        if not m:
            continue
        lines = block.splitlines()
        body = [l for l in lines if not re.match(r"^\d+$", l.strip()) and "-->" not in l]
        txt = " ".join(x.strip() for x in body).strip()
        txt = re.sub(r"<[^>]+>", "", txt)
        if txt:
            segs.append({
                "start": _t2s(*m.groups()[:4]),
                "end": _t2s(*m.groups()[4:]),
                "text": txt,
            })
    return segs


def parse_vtt(text):
    body = re.sub(r"^WEBVTT.*?\n\n", "", text, flags=re.S)
    return parse_srt(body)


def parse_ass(text):
    segs = []

    def _a2s(val):
        m = re.match(r"(\d+):(\d{2}):(\d{2})[.](\d{1,2})", val)
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + \
            int(m.group(4)) / 100.0 if m else 0.0

    for line in text.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        parts = line[len("Dialogue:"):].split(",", 9)
        if len(parts) < 10:
            continue
        txt = re.sub(r"\{[^}]*\}", "", parts[9]).replace("\\N", " ").replace("\\n", " ")
        txt = re.sub(r"<[^>]+>", "", txt).strip()
        if txt:
            segs.append({"start": _a2s(parts[1].strip()),
                         "end": _a2s(parts[2].strip()), "text": txt})
    return segs


def find_external_subtitle(video_path):
    """同目录同名字幕：xxx.srt / xxx.zh.srt / xxx.eng.vtt 等"""
    d = os.path.dirname(video_path)
    stem = os.path.splitext(os.path.basename(video_path))[0]
    if not os.path.isdir(d):
        return None
    try:
        names = os.listdir(d)
    except Exception:
        return None
    stem_l = stem.lower()
    cands = [n for n in names if n.lower().endswith(SUB_EXT)
             and os.path.splitext(n)[0].split(".")[0].lower() == stem_l]
    if not cands:
        return None
    # 英文优先：文件名带 en/eng 的排前面
    cands.sort(key=lambda n: (0 if re.search(r"[._-](en|eng)", n.lower()) else 1, n))
    return os.path.join(d, cands[0])


def extract_embedded_subtitle(video_path, out_srt):
    """从视频里剥出第一条文本字幕流"""
    if not have_ffmpeg():
        return False
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "s",
             "-show_entries", "stream=index:stream_tags=language",
             "-of", "json", video_path],
            capture_output=True, timeout=30)
        streams = json.loads(probe.stdout.decode("utf-8", "replace") or "{}").get("streams", [])
    except Exception:
        streams = []
    if not streams:
        return False
    order = sorted(streams, key=lambda s: (
        0 if (s.get("tags") or {}).get("language", "").lower().startswith("en") else 1,
        s.get("index", 99)))
    for s in order:
        try:
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video_path,
                            "-map", "0:s:%d" % s.get("index", 0), "-c:s", "srt", out_srt],
                           capture_output=True, timeout=120)
            if os.path.exists(out_srt) and os.path.getsize(out_srt) > 0:
                return True
        except Exception:
            continue
    return False


def load_subtitle_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except Exception:
        return []
    ext = os.path.splitext(path)[1].lower()
    if ext == ".vtt":
        return parse_vtt(text)
    if ext in (".ass", ".ssa"):
        return parse_ass(text)
    return parse_srt(text)


# ---------- 转写 ----------

def transcribe_audio(video_path, max_sec=0):
    """ffmpeg 抽 16k 单声道 wav → faster-whisper 转写（带词级时间戳）

    max_sec > 0 时只取前 max_sec 秒（快速模式），用于只要词表、不要完整字幕。
    """
    if not have_ffmpeg() or not have_whisper():
        return []
    if max_sec <= 0:
        max_sec = FAST_SEC
    os.makedirs(AUDIO_DIR, exist_ok=True)
    wav = os.path.join(AUDIO_DIR, "%d.wav" % time.time_ns())
    try:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", video_path,
               "-vn", "-ac", "1", "-ar", "16000"]
        if max_sec > 0:
            cmd += ["-t", str(max_sec)]
        cmd += ["-f", "wav", wav]
        subprocess.run(cmd, capture_output=True, timeout=600)
        if not os.path.exists(wav):
            return []
        model = load_model()
        segments, _info = model.transcribe(wav, language="en", beam_size=5,
                                           vad_filter=True, word_timestamps=True)
        out = []
        for seg in segments:
            words = []
            try:
                for w in seg.words or []:
                    words.append({"w": w.word.strip(), "start": w.start, "end": w.end})
            except Exception:
                pass
            out.append({"start": seg.start, "end": seg.end,
                        "text": (seg.text or "").strip(), "words": words})
        return out
    except Exception as e:
        print("[asr] 转写失败：%s" % e)
        return []
    finally:
        try:
            os.remove(wav)
        except Exception:
            pass


def write_srt(vid, segments):
    os.makedirs(SUB_DIR, exist_ok=True)
    out = os.path.join(SUB_DIR, "%s.srt" % vid)
    lines = []
    for i, s in enumerate(segments, 1):
        lines.append(str(i))
        lines.append("%s --> %s" % (srt_time(s["start"]), srt_time(s["end"])))
        lines.append(s["text"])
        lines.append("")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return out


def srt_time(t):
    t = max(0.0, float(t or 0))
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


# ---------- 任务 ----------

def transcript_path(vid):
    return os.path.join(TRANS_DIR, "%s.json" % vid)


def ensure_transcript(item, force=False, fast=False):
    """返回 (source, segments)。source: subtitle | asr | none

    fast=True 时语音识别只跑前 FAST_SEC 秒，且不生成完整字幕文件。
    """
    os.makedirs(TRANS_DIR, exist_ok=True)
    tp = transcript_path(item["id"])
    if not force and os.path.exists(tp):
        try:
            with open(tp, "r", encoding="utf-8") as f:
                d = json.load(f)
            return d.get("source", "none"), d.get("segments", [])
        except Exception:
            pass

    segments, source = [], "none"

    ext = find_external_subtitle(item["path"])
    if ext:
        segments = load_subtitle_file(ext)
        if segments:
            source = "subtitle"

    if not segments:
        os.makedirs(SUB_DIR, exist_ok=True)
        tmp = os.path.join(SUB_DIR, "_tmp_%s.srt" % item["id"])
        if extract_embedded_subtitle(item["path"], tmp):
            segments = load_subtitle_file(tmp)
            if segments:
                source = "subtitle"
        try:
            os.remove(tmp)
        except Exception:
            pass

    if not segments:
        segments = transcribe_audio(item["path"], FAST_SEC if fast else 0)
        if segments:
            source = "asr"

    # 快速模式的字幕是残缺的，不写入（播放页的 CC 只认完整字幕）
    if segments and source == "asr" and not fast:
        try:
            write_srt(item["id"], segments)
        except Exception:
            pass

    with open(tp, "w", encoding="utf-8") as f:
        json.dump({"id": item["id"], "title": item.get("title"), "source": source,
                   "segments": segments, "at": time.time(), "fast": bool(fast)},
                  f, ensure_ascii=False)
    return source, segments


def run_job(items, force=False, fast=False):
    if STATE["running"]:
        return
    STATE.update({"running": True, "message": "准备中", "total": len(items),
                  "done": 0, "startedAt": time.time(), "results": [],
                  "fast": bool(fast)})

    def worker():
        results = []
        if fast:
            try:
                load_model()  # 提前加载，避免把首次加载算进第一个视频
            except Exception:
                pass
        try:
            for i, item in enumerate(items):
                STATE["message"] = "处理 %d/%d：%s" % (i + 1, len(items), item.get("title"))
                src, segs = ensure_transcript(item, force, fast)
                results.append({"id": item["id"], "title": item.get("title"),
                                "source": src, "segments": len(segs)})
                STATE["results"] = results
                STATE["done"] = i + 1
            ok = sum(1 for r in results if r["source"] != "none")
            STATE["message"] = "完成：%d/%d 个视频拿到文本（字幕 %d，识别 %d）" % (
                ok, len(results),
                sum(1 for r in results if r["source"] == "subtitle"),
                sum(1 for r in results if r["source"] == "asr"))
        except Exception as e:
            STATE["message"] = "提取出错：%s" % e
        finally:
            STATE["running"] = False

    threading.Thread(target=worker, daemon=True).start()


# ---------- 词典与候选词 ----------

def load_dict():
    global _DICT
    if _DICT is not None:
        return _DICT
    d = {}
    if os.path.exists(DICT_FILE):
        try:
            with open(DICT_FILE, "r", encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    w = (row.get("word") or "").strip().lower()
                    zh = (row.get("zh") or "").strip()
                    if w and zh:
                        d[w] = zh
        except Exception:
            pass
    _DICT = d
    return d


def norm_word(w):
    w = re.sub(r"[^a-z']", "", w.lower())
    w = w.strip("'")
    if w.endswith("'s"):
        w = w[:-2]
    return w


def singular(w, dct):
    """轻度还原：apples→apple、singing→sing、babies→baby。
    只在还原后的形式确实在词典里时才替换，避免乱砍词。"""
    if w in dct:
        return w
    cands = []
    if w.endswith("ies"):
        cands.append(w[:-3] + "y")
    if w.endswith("es"):
        cands.append(w[:-2])
    if w.endswith("s"):
        cands.append(w[:-1])
    if w.endswith("ing"):
        cands += [w[:-3], w[:-3] + "e"]
    if w.endswith("ed"):
        cands += [w[:-2], w[:-1]]
    for c in cands:
        if c and len(c) >= 3 and c in dct:
            return c
    return w


def suggest(limit=200, min_count=2, categories=None):
    """聚合成候选词表：词频 + 出现集数 + 样例句 + 时间戳"""
    dct = load_dict()
    known = set()
    words_file = os.path.join(DATA_DIR, "words.csv")
    if os.path.exists(words_file):
        try:
            with open(words_file, "r", encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    known.add((row.get("word") or "").strip().lower())
        except Exception:
            pass

    agg = {}
    if not os.path.isdir(TRANS_DIR):
        return []
    for name in sorted(os.listdir(TRANS_DIR)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(TRANS_DIR, name), "r", encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            continue
        vid, title = d.get("id"), d.get("title")
        per_video = {}
        for seg in d.get("segments", []):
            text = seg.get("text") or ""
            tokens = [norm_word(t) for t in re.split(r"\s+", text)]
            tokens = [t for t in tokens if t and len(t) >= 3]
            for idx, raw in enumerate(tokens):
                w = singular(raw, dct)
                if not w or w in STOPWORDS or w.isdigit():
                    continue
                # 词级时间戳优先，其次用句子起点粗略估算
                t = seg.get("start") or 0
                for wd in seg.get("words") or []:
                    if norm_word(wd.get("w", "")) == w:
                        t = wd.get("start") or t
                        break
                e = agg.setdefault(w, {"word": w, "count": 0, "videos": {},
                                       "sample": text, "sampleVideo": vid,
                                       "sampleTitle": title, "sampleTime": t})
                e["count"] += 1
                per_video[w] = per_video.get(w, 0) + 1
                if vid not in e["videos"]:
                    e["videos"][vid] = {"id": vid, "title": title,
                                        "count": 0, "time": t}

        for w, c in per_video.items():
            agg[w]["videos"][vid]["count"] = c

    out = []
    for w, e in agg.items():
        if e["count"] < min_count:
            continue
        cat = _SEED_MAP.get(w, "")
        if not cat:
            cat = "video"
        e["category"] = cat
        e["zh"] = dct.get(w, "")
        e["inLibrary"] = w in known
        e["videoCount"] = len(e["videos"])
        out.append(e)
    out.sort(key=lambda x: (-x["videoCount"], -x["count"], x["word"]))
    return out[:limit]


# ---------- 导入 ----------

def grab_frame(video_path, out_jpg, at_sec, width=480):
    try:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(max(at_sec - 0.3, 0)),
                        "-i", video_path, "-frames:v", "1", "-vf", "scale=%d:-2" % width,
                        "-q:v", "5", out_jpg], capture_output=True, timeout=60)
        return os.path.exists(out_jpg)
    except Exception:
        return False


def append_words(rows):
    """rows: [{word, zh, category, emoji, sentence}] → 追加进 data/words.csv（去重）"""
    words_file = os.path.join(DATA_DIR, "words.csv")
    if not os.path.exists(words_file):
        src = os.path.join(DEFAULTS_DIR, "words.csv")
        if os.path.exists(src):
            shutil.copyfile(src, words_file)
    exist = {}
    if os.path.exists(words_file):
        with open(words_file, "r", encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                exist[(r.get("word") or "").strip().lower()] = r.get("category") or ""
    with open(words_file, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for r in rows:
            key = (r.get("word") or "").strip().lower()
            if not key or key in exist:
                continue
            w.writerow([r.get("word"), r.get("zh", ""), r.get("category", ""),
                        r.get("emoji", ""), r.get("sentence", "")])
            exist[key] = r.get("category", "")
    return len(exist)


def frame_for_word(vid, video_path, word, at_sec):
    """在"说出这个词的那一刻"截一帧，返回可访问 URL"""
    os.makedirs(WORD_FRAME_DIR, exist_ok=True)
    safe = re.sub(r"[^a-z0-9]+", "_", word.lower())
    fn = "%s_%s.jpg" % (safe, vid)
    out = os.path.join(WORD_FRAME_DIR, fn)
    if not os.path.exists(out) and video_path and os.path.isfile(video_path):
        if not grab_frame(video_path, out, at_sec):
            return None
    return "/api/thumbs/asr/%s" % fn if os.path.exists(out) else None

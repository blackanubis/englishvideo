/* 英语启蒙乐园 - 前端主逻辑（原生 JS，iPad 触屏优先） */

var S = {
  config: { plan: { video: 8, speak: 5, game: 5, summary: 2 }, dailyMinutes: 20 },
  videos: [],
  words: [],
  progress: { days: {}, mastered: {} },
  ann: {},
  route: "today",
  timer: null,
  tick: null,
  player: null,      // {id, time}
  speakIdx: 0,
  game: null,
  review: null,      // {words, idx, phase:"speak"|"game"|"done", readCount}
  videoHinted: false,
  asrCands: [],   // 从字幕/语音提取出来的候选词
  asrCaps: null,  // {ffmpeg, whisper, modelReady, modelSize}
  asrRunning: false
};

/* ============ 工具 ============ */
function pad(n) { return (n < 10 ? "0" : "") + n; }
function keyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayKey() { return keyOf(new Date()); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function fmtMin(sec) { return Math.round((sec || 0) / 60); }
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return "未知";
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + pad(s);
}
function toast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(function () { t.classList.add("hidden"); }, 2400);
}
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ============ 朗读 ============ */
var voiceReady = false, enVoice = null;
function pickVoice() {
  if (!window.speechSynthesis) return;
  var vs = speechSynthesis.getVoices() || [];
  enVoice = vs.filter(function (v) { return /^en(-|_)?/i.test(v.lang || ""); })[0] || null;
  voiceReady = vs.length > 0;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text) {
  if (!window.speechSynthesis || !text) return;
  var u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.8;
  if (enVoice) u.voice = enVoice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ============ 进度 ============ */
function today() {
  var k = todayKey();
  if (!S.progress.days) S.progress.days = {};
  if (!S.progress.days[k]) {
    S.progress.days[k] = {
      videoSec: 0, speakSec: 0, gameSec: 0, summarySec: 0,
      videos: [], words: {}, game: { rounds: 0, right: 0, wrong: 0 }, done: false
    };
  }
  var d = S.progress.days[k];
  if (!d.game) d.game = { rounds: 0, right: 0, wrong: 0 };
  if (!d.videos) d.videos = [];
  if (!d.words) d.words = {};
  return d;
}
var saveTimer = null;
function saveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    Api.saveProgress(S.progress).catch(function () { });
  }, 800);
}
function addSec(mod, sec) {
  if (!sec || sec <= 0) return;
  var key = mod + "Sec";
  today()[key] = (today()[key] || 0) + sec;
  saveProgress();
}
function startTimer(mod) {
  stopTimer();
  S.timer = { mod: mod, start: Date.now() };
  S.tick = setInterval(function () { flushTimer(); }, 10000);
}
function flushTimer() {
  if (!S.timer) return;
  var now = Date.now();
  addSec(S.timer.mod, (now - S.timer.start) / 1000);
  S.timer.start = now;
  updateHeader();
}
function stopTimer() { flushTimer(); S.timer = null; clearInterval(S.tick); S.tick = null; }

function learnedSec() {
  var d = today();
  return (d.videoSec || 0) + (d.speakSec || 0) + (d.gameSec || 0) + (d.summarySec || 0);
}
function streakDays() {
  var d = new Date(), n = 0;
  for (var i = 0; i < 400; i++) {
    var day = S.progress.days[keyOf(d)];
    var active = day && ((day.videoSec || 0) + (day.speakSec || 0) + (day.gameSec || 0)) > 60;
    if (active) n++;
    else if (i > 0) break;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/* ============ 词库 ============ */
function dedupe(list) {
  var seen = {}, out = [];
  list.forEach(function (w) {
    var k = w.word.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1; out.push(w);
  });
  return out;
}
function pickWords(n) {
  var list = S.words.slice();
  if (!list.length) return [];
  var seed = Math.floor(new Date().getTime() / 86400000);
  list.sort(function (a, b) {
    var ma = S.progress.mastered[a.word] || 0, mb = S.progress.mastered[b.word] || 0;
    if (ma !== mb) return ma - mb;
    return ((S.words.indexOf(a) + seed) % 97) - ((S.words.indexOf(b) + seed) % 97);
  });
  var pool = list.slice(0, Math.min(list.length, Math.max(n, 12)));
  return shuffle(pool).slice(0, n);
}
function wordImage(w) {
  var a = S.ann[String(w.word).toLowerCase()];
  if (a && a.length) return '<img src="' + esc(a[Math.floor(Math.random() * a.length)]) + '" alt="">';
  return w.emoji || "❓";
}

/* ============ 路由 ============ */
function go(route) {
  if (S.route === route) return;
  S.route = route;
  if (route === "video") stopTimer();
  else if (route === "speak" || route === "game" || route === "summary") startTimer(route);
  else stopTimer();
  location.hash = "#/" + route;
  render();
}
function updateHeader() {
  var p = Math.min(100, Math.round(learnedSec() / ((S.config.dailyMinutes || 20) * 60) * 100));
  document.getElementById("ring").style.setProperty("--p", p);
  document.getElementById("ringText").textContent = p + "%";
  document.getElementById("subTitle").textContent =
    "今天已学 " + fmtMin(learnedSec()) + " / " + (S.config.dailyMinutes || 20) + " 分钟 · 连续 " + streakDays() + " 天";
}

function render() {
  document.querySelectorAll(".tab").forEach(function (b) {
    b.classList.toggle("on", b.dataset.tab === S.route);
  });
  stopTimer();
  if (S.route === "speak" || S.route === "game" || S.route === "summary" ||
    S.route === "review") startTimer(S.route);
  updateHeader();

  var v = document.getElementById("view");
  if (S.route === "video") v.innerHTML = viewVideo();
  else if (S.route === "speak") v.innerHTML = viewSpeak();
  else if (S.route === "game") v.innerHTML = viewGame();
  else if (S.route === "review") v.innerHTML = viewReview();
  else if (S.route === "summary") v.innerHTML = viewSummary();
  else if (S.route === "parent") v.innerHTML = viewParent();
  else v.innerHTML = viewToday();

  bind();
}

/* ============ 页面：今日 ============ */
function viewToday() {
  var d = today(), plan = S.config.plan || { video: 8, speak: 5, game: 5, summary: 2 };
  var vDone = (d.videoSec || 0) >= plan.video * 60 * 0.98;
  var readCount = Object.keys(d.words || {}).length;
  var sTarget = S.config.wordsPerDay || 10;
  var sDone = readCount >= sTarget;
  var gDone = (d.game && d.game.rounds >= 1);
  var sumDone = (d.summarySec || 0) >= 45 || d.done;

  var next = !vDone ? "video" : (!sDone ? "speak" : (!gDone ? "game" : "summary"));
  var allDone = vDone && sDone && gDone;

  var h = "";
  h += '<div class="hero"><h1>今天学什么？</h1><p>一共 ' + (S.config.dailyMinutes || 20) +
    ' 分钟，按顺序完成四项就能拿到今日小星星</p>' +
    '<div style="margin-top:14px"><button class="btn orange" data-act="go" data-route="' + next + '">' +
    (allDone ? "再看一遍总结" : "开始学习") + '</button></div></div>';

  h += taskCard("📺", "看视频", fmtMin(d.videoSec) + " / " + plan.video + " 分钟" +
    (d.videos.length ? " · 已看 " + d.videos.length + " 集" : ""), vDone, "video");
  h += taskCard("🗣️", "跟读单词", readCount + " / " + sTarget + " 个词", sDone, "speak");
  h += taskCard("🧩", "看图连词", (d.game ? d.game.rounds : 0) + " 轮 · 正确 " +
    (d.game ? d.game.right : 0) + " 次", gDone, "game");

  // 复习：至少学过 3 个词才出现，避免一开始就有空任务
  var rv = d.review || {};
  if (learnedCount() >= 3) {
    h += taskCard("🔁", "复习单词", (rv.count || 0) + " / " +
      (S.config.reviewWords || 10) + " 个词", !!rv.done, "review");
  }
  h += taskCard("🏆", "学习总结", sumDone ? "已查看" : "看看今天的收获", sumDone, "summary");

  if (allDone) {
    h += '<div class="card" style="text-align:center"><div style="font-size:44px">🌟</div>' +
      '<div style="font-size:18px;font-weight:700;margin-top:6px">今天全部完成啦，真棒！</div>' +
      '<div class="muted">连续学习 ' + streakDays() + ' 天</div></div>';
  }
  return h;
}
function taskCard(emo, title, sub, done, route) {
  return '<div class="task' + (done ? " done" : "") + '" data-act="go" data-route="' + route + '">' +
    '<div class="emo">' + emo + '</div><div><div class="t">' + title + '</div>' +
    '<div class="s">' + sub + '</div></div><div class="go">' + (done ? "✅" : "›") + '</div></div>';
}

/* ============ 页面：看视频 ============ */
function viewVideo() {
  var plan = S.config.plan || { video: 8 };
  var h = '<div class="section-title">📺 看视频（今日 ' + plan.video + ' 分钟）</div>';
  if (!S.videos.length) {
    h += '<div class="empty"><div class="e">📂</div><p>还没有视频</p>' +
      '<p class="muted">请点右上角齿轮 → 选择视频目录 → 扫描</p>' +
      '<div style="margin-top:14px"><button class="btn" data-act="go" data-route="parent">去设置</button></div></div>';
    return h;
  }
  var cur = currentVideo();
  if (!cur) return "";
  h += '<video class="player" id="player" playsinline controls preload="metadata" ' +
    (cur.cover ? 'poster="' + esc(cur.cover) + '"' : '') +
    ' src="' + Api.streamUrl(cur) + '"></video>';
  h += '<div class="viderr" id="vidErr"></div>';
  h += '<div class="card"><div class="t" style="font-size:18px;font-weight:700">' + esc(cur.title) + '</div>' +
    '<div class="muted">' + esc(cur.displayPath || cur.name) +
    (cur.iosOk ? "" : ' <span class="badge">iPad 可能播不了</span>') + '</div>' +
    '<div class="btnrow" style="margin-top:12px">' +
    '<button class="btn sm ghost" data-act="prev">⏮ 上一集</button>' +
    '<button class="btn sm ghost" data-act="next">⏭ 下一集</button>' +
    '<button class="btn sm orange" data-act="go" data-route="speak">去跟读 ›</button>' +
    '</div></div>';

  h += '<div class="section-title">全部视频（' + S.videos.length + '）</div><div class="vgrid">';
  S.videos.forEach(function (v) {
    var thumb = v.cover
      ? '<img class="vthumb" src="' + esc(v.cover) + '" alt="">'
      : '<div class="vthumb ph">🎬</div>';
    h += '<div class="vcard' + (v.id === cur.id ? " active" : "") + '" data-act="play" data-id="' + v.id + '">' +
      thumb + '<div class="vmeta"><div class="vtitle">' + esc(v.title) +
      (v.iosOk ? "" : '<span class="badge">格式</span>') + '</div>' +
      '<div class="vsub">' + fmtDur(v.duration) + '</div></div></div>';
  });
  h += '</div>';
  return h;
}
function currentVideo() {
  if (!S.videos.length) return null;
  var last = S.config.lastVideo;
  var v = S.videos.filter(function (x) { return x.id === last; })[0];
  return v || S.videos[0];
}
function stepVideo(delta) {
  var cur = currentVideo();
  var i = S.videos.indexOf(cur);
  var n = (i + delta + S.videos.length) % S.videos.length;
  S.config.lastVideo = S.videos[n].id;
  S.player = null;
  Api.saveConfig({ lastVideo: S.videos[n].id });
  render();
}

/* ============ 页面：跟读 ============ */
function viewSpeak() {
  var n = S.config.wordsPerDay || 10;
  if (!S.words.length) return '<div class="empty"><div class="e">📖</div><p>词库为空</p></div>';
  if (!S.speakList || S.speakList.length !== Math.min(n, S.words.length)) S.speakList = pickWords(Math.min(n, S.words.length));
  var list = S.speakList;
  if (S.speakIdx >= list.length) S.speakIdx = list.length - 1;
  var w = list[S.speakIdx];
  var d = today();
  var rec = (d.words || {})[w.word] || { times: 0, ok: false };

  var h = '<div class="section-title">🗣️ 跟读单词（' + (S.speakIdx + 1) + '/' + list.length + '）</div>';
  h += '<div class="card wordcard">' +
    '<div class="wpic">' + wordImage(w) + '</div>' +
    '<div class="wword">' + esc(w.word) + '</div>' +
    '<div class="wzh">' + esc(w.zh) + '</div>' +
    (w.sentence ? '<div class="wsen">' + esc(w.sentence) + '</div>' : '') +
    '<div class="btnrow" style="margin-top:18px;justify-content:center">' +
    '<button class="btn orange" data-act="listen">🔊 听发音</button>' +
    '<button class="btn green" data-act="read">✅ 我读过了</button>' +
    (canRecord() ? '<button class="btn ghost" data-act="rec">🎤 录一遍</button>' : '') +
    '</div>' +
    '<div class="dots">' + list.map(function (x, i) {
      var r = (d.words || {})[x.word];
      var cls = i === S.speakIdx ? "on" : (r && r.ok ? "ok" : "");
      return '<span class="dot ' + cls + '"></span>';
    }).join("") + '</div>' +
    '<div class="muted" style="margin-top:10px">已跟读 ' + rec.times + ' 次</div>' +
    '</div>';
  h += '<div class="btnrow"><button class="btn sm ghost" data-act="prevword">上一个</button>' +
    '<button class="btn sm ghost" data-act="skip">跳到下一个</button>' +
    '<button class="btn sm" data-act="go" data-route="game">去连词游戏 ›</button></div>';
  if (S.recUrl) {
    h += '<div class="card"><div class="muted">刚才的录音</div>' +
      '<audio controls src="' + S.recUrl + '" style="width:100%;margin-top:8px"></audio></div>';
  }
  return h;
}
function canRecord() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}
function markRead(ok) {
  var list = S.speakList;
  var w = list[S.speakIdx];
  var d = today();
  if (!d.words[w.word]) d.words[w.word] = { times: 0, ok: false };
  d.words[w.word].times += 1;
  if (ok) d.words[w.word].ok = true;
  if (ok) {
    S.progress.mastered[w.word] = (S.progress.mastered[w.word] || 0) + 1;
    touchLearned(w.word, "read");
    toast("真棒！" + w.word + " 学会了");
  }
  saveProgress();
}

/* ---- 学习档案：复习功能的数据来源 ----
   progress.learned = { word: {read, match, reviewed, first, last, zh, emoji} }
   read    = 跟读掌握次数
   match   = 连词连对次数
   reviewed= 被复习抽中次数 */
function learnedMap() {
  if (!S.progress.learned) S.progress.learned = {};
  return S.progress.learned;
}
function findWord(w) {
  for (var i = 0; i < S.words.length; i++) {
    if (S.words[i].word === w) return S.words[i];
  }
  return null;
}
function touchLearned(word, kind) {
  if (!word) return;
  var L = learnedMap();
  var e = L[word] || { read: 0, match: 0, reviewed: 0 };
  e[kind] = (e[kind] || 0) + 1;
  var k = todayKey();
  if (!e.first) e.first = k;
  e.last = k;
  var w = findWord(word);
  if (w && !e.zh) { e.zh = w.zh; e.emoji = w.emoji; }
  L[word] = e;
  saveProgress();
}
/* 老数据迁移：把历史跟读记录和 mastered 补进 learned，
   这样装了新版本也能复习以前学过的词 */
function migrateLearned() {
  var L = learnedMap();
  var days = S.progress.days || {};
  Object.keys(days).forEach(function (k) {
    var ws = (days[k] || {}).words || {};
    Object.keys(ws).forEach(function (w) {
      if (!ws[w] || !ws[w].ok) return;
      var e = L[w] || { read: 0, match: 0, reviewed: 0 };
      e.read = Math.max(e.read || 0, 1);
      if (!e.first || k < e.first) e.first = k;
      if (!e.last || k > e.last) e.last = k;
      var wo = findWord(w);
      if (wo && !e.zh) { e.zh = wo.zh; e.emoji = wo.emoji; }
      L[w] = e;
    });
  });
  var m = S.progress.mastered || {};
  Object.keys(m).forEach(function (w) {
    var e = L[w] || { read: 0, match: 0, reviewed: 0 };
    e.read = Math.max(e.read || 0, m[w] || 0);
    if (!e.first) e.first = todayKey();
    if (!e.last) e.last = todayKey();
    L[w] = e;
  });
}
function daysSince(dateStr) {
  if (!dateStr) return 999;
  var a = new Date(dateStr + "T00:00:00");
  var b = new Date(todayKey() + "T00:00:00");
  if (isNaN(a.getTime())) return 999;
  return Math.max(0, Math.round((b - a) / 86400000));
}
/* 抽复习词：越久没碰、掌握得越少的越优先；再在候选里随机取，
   保证每次复习的词不完全一样 */
function pickReview(n) {
  var L = learnedMap();
  var pool = Object.keys(L).filter(function (w) {
    var e = L[w] || {};
    return ((e.read || 0) + (e.match || 0)) > 0;
  });
  if (!pool.length) return [];
  pool.sort(function (a, b) {
    var ea = L[a], eb = L[b];
    var ga = daysSince(ea.last), gb = daysSince(eb.last);
    if (ga !== gb) return gb - ga;                    // 久未复习优先
    var ma = (ea.read || 0) + (ea.match || 0);
    var mb = (eb.read || 0) + (eb.match || 0);
    if (ma !== mb) return ma - mb;                    // 掌握得少的优先
    return (ea.reviewed || 0) - (eb.reviewed || 0);
  });
  var take = pool.slice(0, Math.max(n * 2, n + 2));
  return shuffle(take).slice(0, Math.min(n, take.length));
}
function reviewWordsToObjs(keys) {
  var L = learnedMap();
  return keys.map(function (k) {
    var e = L[k] || {};
    var w = findWord(k) || {};
    var a = S.ann[String(k).toLowerCase()];
    return {
      word: k,
      zh: w.zh || e.zh || "",
      emoji: w.emoji || e.emoji || "",
      img: (a && a.length) ? a[Math.floor(Math.random() * a.length)] : null
    };
  });
}
function startReview() {
  var n = S.config.reviewWords || 10;
  var keys = pickReview(n);
  if (!keys.length) {
    toast("还没有学过的单词，先去跟读和连词吧");
    return;
  }
  S.review = { words: reviewWordsToObjs(keys), idx: 0, phase: "speak", readCount: 0 };
  render();
}
function markReviewed(ok) {
  var r = S.review;
  if (!r) return;
  var w = r.words[r.idx];
  if (ok && w) {
    var L = learnedMap();
    var e = L[w.word] || { read: 0, match: 0, reviewed: 0 };
    e.reviewed = (e.reviewed || 0) + 1;
    e.last = todayKey();
    L[w.word] = e;
    touchLearned(w.word, "read");
    r.readCount++;
  }
  if (r.idx < r.words.length - 1) {
    r.idx++;
  } else {
    r.phase = "game";
    newRound(r.words);
  }
  saveProgress();
  render();
}
function finishReview() {
  var r = S.review;
  if (!r) return;
  r.phase = "done";
  var d = today();
  d.review = { count: r.words.length, done: true, at: Date.now() };
  saveProgress();
  render();
}
function nextWord(auto) {
  if (S.speakIdx < S.speakList.length - 1) {
    S.speakIdx++;
    render();
  } else {
    var d = today();
    var target = S.config.wordsPerDay || 10;
    if (Object.keys(d.words || {}).length >= target) {
      toast("今天的单词都读完啦");
      go("game");
    } else {
      S.speakIdx = 0;
      render();
    }
  }
}
function startRecord() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    var chunks = [];
    var mr = new MediaRecorder(stream);
    mr.ondataavailable = function (e) { chunks.push(e.data); };
    mr.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      S.recUrl = URL.createObjectURL(new Blob(chunks, { type: "audio/webm" }));
      render();
      toast("录好啦，点播放听听自己读的");
    };
    mr.start();
    toast("开始录音，3 秒后自动结束");
    setTimeout(function () { if (mr.state !== "inactive") mr.stop(); }, 3000);
  }).catch(function () {
    toast("这个浏览器不让用麦克风，用「我读过了」就好啦");
  });
}

/* ============ 页面：看图连词 ============ */
function newRound(words) {
  var n = S.config.pairsPerRound || 6;
  // 复习的连词会直接传入指定词表；普通连词才从词库随机抽
  if (!words) words = pickWords(Math.min(n, S.words.length || n));
  words = words.map(function (w) {
    var a = S.ann[String(w.word).toLowerCase()];
    return {
      word: w.word, zh: w.zh, emoji: w.emoji,
      img: w.img || ((a && a.length) ? a[Math.floor(Math.random() * a.length)] : null)
    };
  });
  // 注意：left / right 是左右两列的索引数组；
  // 计数必须用 rightCount / wrongCount，不能叫 right / wrong，否则会把数组覆盖掉
  S.game = {
    words: words,
    left: shuffle(words.map(function (w, i) { return i; })),
    right: shuffle(words.map(function (w, i) { return i; })),
    sel: null, matched: {},
    rightCount: 0, wrongCount: 0, start: Date.now(), finished: false
  };
}
/* 连词棋盘：普通连词和复习连词共用同一套渲染 */
function gameBoardHtml(g) {
  return '<div class="board" id="board">' +
    '<svg class="lines" id="lines"></svg>' +
    '<div class="col" id="colL">' + g.left.map(function (wi) {
      var w = g.words[wi];
      var cls = g.matched[wi] ? " done" : (g.sel === wi ? " sel" : "");
      return '<div class="pic' + cls + '" data-act="pic" data-i="' + wi + '">' +
        (w.img ? '<img src="' + esc(w.img) + '" alt="">' : (w.emoji || "❓")) + '</div>';
    }).join("") + '</div>' +
    '<div class="col" id="colR">' + g.right.map(function (wi) {
      var w = g.words[wi];
      var cls = g.matched[wi] ? " done" : "";
      return '<div class="wd' + cls + '" data-act="wd" data-i="' + wi + '">' + esc(w.word) + '</div>';
    }).join("") + '</div></div>';
}
function viewGame() {
  if (!S.words.length) return '<div class="empty"><div class="e">🧩</div><p>词库为空</p></div>';
  if (!S.game) newRound();
  var g = S.game;
  var h = '<div class="section-title">🧩 看图连单词</div>';
  h += '<div class="muted" style="margin-bottom:8px">先点一张图片，再点右边的单词，连对了会有一条绿线</div>';
  h += '<div class="card">' + gameBoardHtml(g) +
    '<div class="btnrow" style="margin-top:14px">' +
    '<button class="btn sm ghost" data-act="newround">换一组</button>' +
    '<button class="btn sm" data-act="go" data-route="summary">看总结 ›</button></div></div>';

  if (g.finished) {
    var sec = Math.round((Date.now() - g.start) / 1000);
    h += '<div class="card" style="text-align:center"><div style="font-size:40px">' +
      (g.wrongCount === 0 ? "🎉" : "👏") + '</div>' +
      '<div style="font-size:18px;font-weight:700">这一轮完成！</div>' +
      '<div class="muted">用时 ' + sec + ' 秒 · 正确 ' + g.rightCount + ' 次 · 错 ' + g.wrongCount + ' 次</div>' +
      '<div style="margin-top:12px"><button class="btn green" data-act="newround">再来一轮</button></div></div>';
  }
  return h;
}
function drawLines() {
  var g = S.game;
  if (!g) return;
  var svg = document.getElementById("lines");
  var board = document.getElementById("board");
  if (!svg || !board) return;
  var br = board.getBoundingClientRect();
  svg.setAttribute("width", br.width);
  svg.setAttribute("height", br.height);
  var html = "";
  Object.keys(g.matched).forEach(function (wi) {
    var pe = document.querySelector('.pic[data-i="' + wi + '"]');
    var we = document.querySelector('.wd[data-i="' + wi + '"]');
    if (!pe || !we) return;
    var pr = pe.getBoundingClientRect(), wr = we.getBoundingClientRect();
    var x1 = pr.right - br.left, y1 = pr.top + pr.height / 2 - br.top;
    var x2 = wr.left - br.left, y2 = wr.top + wr.height / 2 - br.top;
    var mx = (x1 + x2) / 2;
    html += '<path d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 +
      '" fill="none" stroke="#43c59e" stroke-width="4" stroke-linecap="round"/>';
  });
  svg.innerHTML = html;
}
function onPickPic(i) {
  var g = S.game;
  if (g.matched[i]) return;
  g.sel = i;
  speak(g.words[i].word);
  render();
}
function onPickWord(i) {
  var g = S.game;
  if (g.matched[i]) return;
  if (g.sel === null) { toast("先点一张图片哦"); return; }
  if (g.sel === i) {
    g.matched[i] = true;
    g.rightCount++;
    g.sel = null;
    touchLearned(g.words[i].word, "match");   // 连对也算一次掌握，复习会优先抽这些词
    speak(g.words[i].word);
    var d = today();
    d.game.right = (d.game.right || 0) + 1;
    saveProgress();
    if (Object.keys(g.matched).length === g.words.length) {
      g.finished = true;
      d.game.rounds = (d.game.rounds || 0) + 1;
      saveProgress();
    }
    render();
  } else {
    g.wrongCount++;
    var d2 = today();
    d2.game.wrong = (d2.game.wrong || 0) + 1;
    saveProgress();
    var el = document.querySelector('.wd[data-i="' + i + '"]');
    if (el) {
      el.classList.add("shake");
      setTimeout(function () { el.classList.remove("shake"); }, 350);
    }
  }
}

/* ============ 页面：复习 ============ */
function learnedCount() {
  var L = learnedMap();
  return Object.keys(L).filter(function (w) {
    var e = L[w] || {};
    return ((e.read || 0) + (e.match || 0)) > 0;
  }).length;
}
function learnedKeys() {
  var L = learnedMap();
  return Object.keys(L).filter(function (w) {
    var e = L[w] || {};
    return ((e.read || 0) + (e.match || 0)) > 0;
  });
}
function viewReview() {
  var r = S.review;
  var n = S.config.reviewWords || 10;
  var total = learnedCount();

  // 入口
  if (!r) {
    var h = '<div class="section-title">🔁 复习学过的单词</div>';
    h += '<div class="card"><div style="font-weight:700;margin-bottom:6px">已经学过 ' + total + ' 个词</div>' +
      '<div class="muted">从跟读和连词里学过的词中，挑最容易忘的来复习：' +
      '先逐个读一遍，再做一轮连词。越久没碰、掌握得越少的词越容易被抽到。</div>' +
      '<div class="btnrow" style="margin-top:12px">' +
      (total
        ? '<button class="btn orange" data-act="reviewstart">开始复习（' + Math.min(n, total) + ' 个词）</button>'
        : '<button class="btn" data-act="go" data-route="speak">先去跟读单词</button>') +
      '</div></div>';
    if (total) {
      var L = learnedMap();
      var keys = learnedKeys().sort(function (a, b) {
        return (L[b].last || "") < (L[a].last || "") ? -1 : 1;
      }).slice(0, 40);
      h += '<div class="card"><div style="font-weight:700;margin-bottom:8px">学过的词</div>' +
        '<div class="chips">' + keys.map(function (k) {
          var e = L[k] || {};
          return '<span class="chip">' + esc(k) +
            (e.zh ? ' <span class="muted">' + esc(e.zh) + '</span>' : '') +
            ' <span class="muted">读' + (e.read || 0) + '·连' + (e.match || 0) + '</span></span>';
        }).join("") + '</div></div>';
    }
    return h;
  }

  // 阶段一：发音复习
  if (r.phase === "speak") {
    var w = r.words[r.idx];
    var hs = '<div class="section-title">🔁 复习发音（' + (r.idx + 1) + '/' + r.words.length + '）</div>';
    hs += '<div class="card wordcard">' +
      '<div class="wpic">' + wordImage(w) + '</div>' +
      '<div class="wword">' + esc(w.word) + '</div>' +
      '<div class="wzh">' + esc(w.zh) + '</div>' +
      '<div class="btnrow" style="margin-top:18px;justify-content:center">' +
      '<button class="btn orange" data-act="reviewlisten">🔊 听发音</button>' +
      '<button class="btn green" data-act="reviewread">✅ 我读过了</button>' +
      '<button class="btn ghost" data-act="reviewskip">跳过</button>' +
      '</div>' +
      '<div class="dots">' + r.words.map(function (x, i) {
        var cls = i < r.idx ? "ok" : (i === r.idx ? "on" : "");
        return '<span class="dot ' + cls + '"></span>';
      }).join("") + '</div>' +
      '<div class="muted" style="margin-top:10px">已读 ' + r.readCount + ' 个</div></div>';
    return hs;
  }

  // 阶段二：连词复习
  if (r.phase === "game") {
    var g = S.game;
    var hg = '<div class="section-title">🔁 复习连词</div>';
    hg += '<div class="muted" style="margin-bottom:8px">把刚才复习的 ' + r.words.length +
      ' 个词连起来，先点图片再点单词</div>';
    if (!g) { newRound(r.words); g = S.game; }
    hg += '<div class="card">' + gameBoardHtml(g) + '</div>';
    if (g.finished) {
      hg += '<div class="card" style="text-align:center"><div style="font-size:40px">🎉</div>' +
        '<div style="font-size:18px;font-weight:700">全部连对啦</div>' +
        '<div class="muted">连对 ' + g.rightCount + ' 次 · 错 ' + g.wrongCount + ' 次</div>' +
        '<div style="margin-top:12px"><button class="btn green" data-act="reviewdone">完成复习</button></div></div>';
    } else {
      hg += '<div class="btnrow" style="margin-top:14px">' +
        '<button class="btn sm ghost" data-act="reviewnewround">换一种连法</button>' +
        '<button class="btn sm" data-act="reviewdone">结束复习</button></div>';
    }
    return hg;
  }

  // 完成
  var hd = '<div class="section-title">🔁 复习完成</div>';
  hd += '<div class="card" style="text-align:center"><div style="font-size:44px">🏅</div>' +
    '<div style="font-size:18px;font-weight:700;margin-top:6px">复习了 ' + r.words.length + ' 个词</div>' +
    '<div class="muted" style="margin-top:8px">' +
    r.words.map(function (x) { return esc(x.word); }).join("、") + '</div>' +
    '<div class="btnrow" style="margin-top:14px;justify-content:center">' +
    '<button class="btn" data-act="reviewstart">再换一组</button>' +
    '<button class="btn ghost" data-act="go" data-route="today">回今日</button></div></div>';
  return hd;
}

/* ============ 页面：总结 ============ */
function viewSummary() {
  var d = today();
  var d2 = today();
  if (!d2.done) { d2.done = true; saveProgress(); }
  var total = learnedSec();
  var rate = (d.game.right + d.game.wrong) > 0
    ? Math.round(d.game.right / (d.game.right + d.game.wrong) * 100) : 0;

  var h = '<div class="section-title">🏆 今日总结</div>';
  h += '<div class="hero" style="text-align:center"><h1>' + fmtMin(total) + ' 分钟</h1>' +
    '<p>连续学习 ' + streakDays() + ' 天 · 累计 ' + Object.keys(S.progress.days || {}).length + ' 天</p></div>';

  h += '<div class="card">' + row("看视频", fmtMin(d.videoSec) + " 分钟 · " + d.videos.length + " 集") +
    row("跟读单词", Object.keys(d.words || {}).length + " 个") +
    row("连词游戏", d.game.rounds + " 轮 · 正确率 " + rate + "%") +
    (d.review && d.review.done ? row("复习单词", d.review.count + " 个 ✅") : "") +
    row("学习总结", "已打卡 ✅") + '</div>';

  if (d.videos.length) {
    h += '<div class="card"><div style="font-weight:700;margin-bottom:8px">今天看过的视频</div>' +
      d.videos.map(function (v) { return '<div class="muted">· ' + esc(v.title) + '</div>'; }).join("") + '</div>';
  }
  var learned = Object.keys(d.words || {}).filter(function (w) { return d.words[w].ok; });
  if (learned.length) {
    h += '<div class="card"><div style="font-weight:700;margin-bottom:8px">今天学会的词</div>' +
      '<div class="chips">' + learned.map(function (w) {
        return '<span class="chip on">' + esc(w) + '</span>';
      }).join("") + '</div></div>';
  }

  h += '<div class="card"><div style="font-weight:700;margin-bottom:14px">最近 7 天</div>' +
    '<div class="bars">' + last7().map(function (x) {
      var max = Math.max(20, Math.max.apply(null, last7().map(function (y) { return y.min; })));
      var hp = Math.max(4, Math.round(x.min / max * 110));
      return '<div class="bar' + (x.min > 0 ? " on" : "") + '" style="height:' + hp + 'px">' +
        '<span>' + x.label + '</span></div>';
    }).join("") + '</div><div style="height:24px"></div>' +
    '<div class="muted">柱子高度 = 当天学习分钟数</div></div>';

  h += '<div class="card" style="text-align:center"><div style="font-size:34px">' +
    (total >= (S.config.dailyMinutes || 20) * 60 ? "🌟" : "💪") + '</div>' +
    '<div style="font-weight:700">' + cheer(total) + '</div></div>';
  h += '<div class="btnrow"><button class="btn sm ghost" data-act="go" data-route="parent">家长设置</button></div>';
  return h;
}
function row(k, v) {
  return '<div class="stat"><span class="muted">' + k + '</span><b>' + v + '</b></div>';
}
function last7() {
  var out = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    var k = keyOf(d);
    var day = S.progress.days[k];
    var sec = day ? ((day.videoSec || 0) + (day.speakSec || 0) + (day.gameSec || 0)) : 0;
    out.push({ label: (d.getMonth() + 1) + "/" + d.getDate(), min: Math.round(sec / 60), sec: sec });
  }
  return out;
}
function cheer(sec) {
  var target = (S.config.dailyMinutes || 20) * 60;
  if (sec >= target) return "今天的目标完成啦，明天继续！";
  if (sec >= target * 0.6) return "已经学了大半，很厉害！";
  if (sec > 0) return "开了个好头，明天再玩一会儿吧！";
  return "今天还没开始，点下面的按钮出发～";
}

/* ============ 页面：家长设置 ============ */
function viewParent() {
  var cfg = S.config;
  var dirs = cfg.videoDirs || [];
  var h = '<div class="section-title">⚙️ 家长设置</div>';

  h += '<div class="card"><div style="font-weight:700;margin-bottom:8px">视频目录</div>';
  if (!dirs.length) {
    h += '<div class="muted">还没有选择目录。点下面的按钮，在 NAS 上找到放视频的文件夹。</div>';
  } else {
    h += dirs.map(function (d) {
      return '<div class="dir"><div><div class="n">' + esc(d) + '</div></div>' +
        '<button class="btn sm ghost" data-act="removedir" data-path="' + esc(d) + '">移除</button></div>';
    }).join("");
  }
  h += '<div class="btnrow" style="margin-top:12px">' +
    '<button class="btn orange" data-act="browse">📂 选择视频目录</button>' +
    '<button class="btn" data-act="scan">🔍 扫描视频</button>' +
    '<button class="btn ghost" data-act="scanfull">重新扫描并生成截图</button></div>';
  h += '<div class="muted" id="scanInfo" style="margin-top:10px">当前收录 ' + S.videos.length + ' 个视频</div></div>';

  h += '<div class="card"><div style="font-weight:700;margin-bottom:8px">🖼️ 图词标注（可选）</div>' +
    '<div class="muted">给视频截图标上单词，标过的图会出现在「看图连词」里，不标也没关系，会自动用彩色图标。</div>' +
    '<div style="margin-top:12px"><button class="btn ghost" data-act="annotate">开始标注</button></div>' +
    '<div class="muted" style="margin-top:8px">已标注单词：' + Object.keys(S.ann).length + ' 个</div></div>';

  h += '<div class="card"><div style="font-weight:700;margin-bottom:8px">🎙️ 从视频里提取单词</div>' +
    '<div class="muted">优先读视频自带的字幕；没有字幕就用语音识别转写。' +
    '提取完会出一张候选词表，你勾选后进入跟读和连词。</div>' +
    '<div id="asrCaps" class="muted" style="margin-top:8px"></div>' +
    '<div class="asrmode" style="margin-top:12px">' +
    '<label><input type="checkbox" id="asrFast" checked> 快速模式</label>' +
    '<select id="asrSec">' +
    '<option value="60">每集只听前 60 秒</option>' +
    '<option value="90" selected>每集只听前 90 秒</option>' +
    '<option value="120">每集只听前 120 秒</option>' +
    '<option value="180">每集只听前 180 秒</option>' +
    '</select>' +
    '<div class="muted" style="margin-top:4px">儿歌词汇重复度高，听前一两分钟就能拿到几乎全部生词，' +
    '速度提升 3~5 倍。缺点是<b>不生成完整字幕</b>，要字幕就取消勾选。</div></div>' +
    '<div class="btnrow" style="margin-top:12px">' +
    '<button class="btn orange" data-act="asrstart">开始提取</button>' +
    '<button class="btn" data-act="asrsuggest">查看候选词</button>' +
    '<button class="btn ghost" data-act="asrstartforce">强制重新提取</button>' +
    '<button class="btn ghost" data-act="asrclear">清空提取结果</button></div>' +
    '<div class="muted" id="asrInfo" style="margin-top:10px"></div></div>';

  var p = cfg.plan || {};
  h += '<div class="card"><div style="font-weight:700;margin-bottom:12px">⏱️ 每日安排</div>' +
    field("每天总时长（分钟）", '<input type="number" id="cfDaily" value="' + (cfg.dailyMinutes || 20) + '">') +
    field("看视频（分钟）", '<input type="number" id="cfVideo" value="' + (p.video || 8) + '">') +
    field("跟读单词（分钟）", '<input type="number" id="cfSpeak" value="' + (p.speak || 5) + '">') +
    field("看图连词（分钟）", '<input type="number" id="cfGame" value="' + (p.game || 5) + '">') +
    field("每天跟读词数", '<input type="number" id="cfWords" value="' + (cfg.wordsPerDay || 10) + '">') +
    field("连词每组对数", '<input type="number" id="cfPairs" value="' + (cfg.pairsPerRound || 6) + '">') +
    field("每次复习词数", '<input type="number" id="cfReview" value="' + (cfg.reviewWords || 10) + '">') +
    field("抽帧间隔（秒）", '<input type="number" id="cfFrame" value="' + (cfg.frameInterval || 15) + '">') +
    '<button class="btn" data-act="savesettings">保存设置</button></div>';

  h += '<div class="card"><div style="font-weight:700;margin-bottom:10px">📚 词库主题</div>' +
    '<div class="chips">' + S.cats.map(function (c) {
      var on = (cfg.categories || []).indexOf(c.id) >= 0;
      return '<span class="chip' + (on ? " on" : "") + '" data-act="cat" data-id="' + c.id + '">' +
        esc(c.id) + " (" + c.count + ")</span>";
    }).join("") + '</div>' +
    '<div class="muted" style="margin-top:10px">主题名取自 data/words.csv 的 category 列，改词库直接编辑这个文件</div></div>';

  h += '<div class="card" id="healthCard"><div style="font-weight:700;margin-bottom:8px">🩺 自检</div>' +
    '<div class="muted">加载中…</div></div>';

  h += '<div class="card"><div style="font-weight:700;margin-bottom:10px">📦 数据</div>' +
    '<div class="btnrow">' +
    '<button class="btn sm ghost" data-act="export">导出学习记录</button>' +
    '<button class="btn sm ghost" data-act="reset">清空学习记录</button>' +
    '<button class="btn sm ghost" data-act="go" data-route="today">返回今日</button></div></div>';
  return h;
}
function field(label, input) {
  return '<div class="field"><label>' + label + '</label>' + input + '</div>';
}

/* ============ 弹层 ============ */
function openSheet(html) {
  document.getElementById("sheet").innerHTML = html;
  document.getElementById("modal").classList.remove("hidden");
}
function closeSheet() {
  document.getElementById("modal").classList.add("hidden");
  document.getElementById("sheet").innerHTML = "";
}

var browsePath = "";
function openBrowse() {
  browsePath = "";
  loadBrowse("");
}
function loadBrowse(path) {
  Api.browse(path).then(function (res) {
    browsePath = res.containerPath || path;
    var h = '<h3>选择视频目录</h3>';
    h += '<div class="crumbs">' + res.crumbs.map(function (c) {
      return '<span class="crumb" data-act="cd" data-path="' + esc(c.path) + '">' + esc(c.name) + '</span>';
    }).join("") + '</div>';
    if (!res.entries.length) {
      h += '<div class="muted">这个目录下没有子文件夹</div>';
    } else {
      h += res.entries.map(function (e) {
        return '<div class="dir" data-act="open" data-path="' + esc(e.containerPath) + '">' +
          '<div><div class="n">📁 ' + esc(e.name) + '</div>' +
          '<div class="muted">' + esc(e.path) + '</div></div>' +
          '<div class="c">' + (e.videoCount ? e.videoCount + " 个视频" : "") + '</div></div>';
      }).join("");
    }
    h += '<div class="btnrow" style="margin-top:14px">' +
      '<button class="btn green" data-act="usethis" data-path="' + esc(res.containerPath) + '">就用这个目录</button>' +
      '<button class="btn ghost" data-act="closesheet">取消</button></div>';
    openSheet(h);
    bindSheet();
  }).catch(function (e) {
    toast("读取目录失败：" + e.message);
  });
}
function useDir(containerPath) {
  var dirs = (S.config.videoDirs || []).slice();
  var disp = Api.browse(containerPath);
  disp.then(function (r) {
    var shown = r.current;
    if (dirs.indexOf(shown) < 0) dirs.push(shown);
    S.config.videoDirs = dirs;
    Api.saveConfig({ videoDirs: dirs }).then(function () {
      closeSheet();
      toast("已保存，开始扫描视频…");
      doScan(false);
      render();
    });
  });
}

var annotVideo = null;
function openAnnotate() {
  if (!S.videos.length) { toast("先扫描视频再来标注"); return; }
  annotVideo = S.videos[0].id;
  renderAnnotate();
}
function renderAnnotate() {
  var v = S.videos.filter(function (x) { return x.id === annotVideo; })[0];
  var frames = (v && v.frames) || [];
  var h = '<h3>图词标注</h3>';
  h += '<div class="field"><label>选择视频</label><select id="annVideo">' +
    S.videos.map(function (x) {
      // 这里显示原始文件名（不做任何改写），方便按集数核对；鼠标悬停看完整路径
      return '<option value="' + x.id + '"' + (x.id === annotVideo ? " selected" : "") +
        ' title="' + esc(x.displayPath || x.path || x.name) + '">' +
        esc(x.name) + '</option>';
    }).join("") + '</select></div>';
  if (!frames.length) {
    h += '<div class="muted">这个视频还没有截图。去设置页点「重新扫描并生成截图」，等跑完再来。</div>';
  } else {
    h += '<div class="muted" style="margin-bottom:10px">点一张截图，再选择它对应的单词</div>';
    h += '<div class="frames">' + frames.map(function (f) {
      var lb = "";
      Object.keys(S.ann).forEach(function (w) {
        if (S.ann[w].indexOf(f) >= 0) lb = w;
      });
      return '<div class="frame' + (lb ? " tag" : "") + '" data-act="frame" data-src="' + esc(f) + '">' +
        '<img src="' + esc(f) + '" alt="">' + (lb ? '<div class="lb">' + esc(lb) + '</div>' : '') + '</div>';
    }).join("") + '</div>';
  }
  h += '<div class="btnrow" style="margin-top:14px"><button class="btn ghost" data-act="closesheet">关闭</button></div>';
  openSheet(h);
  bindSheet();
}
function pickWordFor(img) {
  var h = '<h3>这张图是哪个单词？</h3>';
  h += '<div class="field"><input type="text" id="wSearch" placeholder="输入单词或中文筛选"></div>';
  h += '<div class="chips" id="wList">' + S.words.slice(0, 60).map(function (w) {
    return '<span class="chip" data-act="tag" data-word="' + esc(w.word) + '" data-img="' + esc(img) + '">' +
      esc(w.word) + " " + esc(w.zh) + '</span>';
  }).join("") + '</div>';
  h += '<div class="btnrow" style="margin-top:14px"><button class="btn ghost" data-act="closesheet">取消</button></div>';
  openSheet(h);
  bindSheet();
  var input = document.getElementById("wSearch");
  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    var chips = document.querySelectorAll("#wList .chip");
    chips.forEach(function (c) {
      var t = c.textContent.toLowerCase();
      c.style.display = (!q || t.indexOf(q) >= 0) ? "" : "none";
    });
  });
}

/* ============ 事件绑定 ============ */
function bindSheet() {
  document.getElementById("sheet").onclick = function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.dataset.act;
    if (act === "closesheet") closeSheet();
    else if (act === "cd") loadBrowse(el.dataset.path);
    else if (act === "open") loadBrowse(el.dataset.path);
    else if (act === "usethis") useDir(el.dataset.path);
    else if (act === "frame") pickWordFor(el.dataset.src);
    else if (act === "asrall" || act === "asrnone") {
      var on = act === "asrall";
      document.querySelectorAll(".asrlist .asrchk input[type=checkbox]:not(.asrimg)").forEach(function (c) {
        if (!c.disabled) c.checked = on;
      });
    } else if (act === "asrframe") {
      document.querySelectorAll(".asrlist .asrrow").forEach(function (row) {
        var zh = row.querySelector(".asrzh");
        var cb = row.querySelector(".asrchk input[type=checkbox]");
        if (cb && !cb.disabled) cb.checked = !!(zh && zh.value.trim());
      });
    } else if (act === "asrimport") importSuggest();
    else if (act === "tag") {
      Api.annotate(el.dataset.img, el.dataset.word).then(function (r) {
        S.ann = r.items || {};
        closeSheet();
        toast("已标注为 " + el.dataset.word);
        render();
      });
    }
  };
  var sel = document.getElementById("annVideo");
  if (sel) {
    sel.onchange = function () {
      annotVideo = sel.value;
      renderAnnotate();
    };
  }
}

function bind() {
  var view = document.getElementById("view");

  view.onclick = function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.dataset.act;
    if (act === "go") go(el.dataset.route);
    else     if (act === "play") {
      S.config.lastVideo = el.dataset.id;
      S.player = null;
      Api.saveConfig({ lastVideo: el.dataset.id });
      render();
    } else if (act === "prev") stepVideo(-1);
    else if (act === "next") stepVideo(1);
    else if (act === "listen") speak(S.speakList[S.speakIdx].word);
    else if (act === "read") { markRead(true); nextWord(); }
    else if (act === "rec") startRecord();
    else if (act === "prevword") { if (S.speakIdx > 0) { S.speakIdx--; render(); } }
    else if (act === "skip") nextWord();
    else if (act === "pic") onPickPic(parseInt(el.dataset.i, 10));
    else if (act === "wd") onPickWord(parseInt(el.dataset.i, 10));
    else if (act === "newround") { newRound(); render(); }
    else if (act === "reviewstart") startReview();
    else if (act === "reviewlisten") {
      if (S.review) speak(S.review.words[S.review.idx].word);
    } else if (act === "reviewread") markReviewed(true);
    else if (act === "reviewskip") markReviewed(false);
    else if (act === "reviewdone") finishReview();
    else if (act === "reviewnewround") {
      if (S.review) { newRound(S.review.words); render(); }
    }
    else if (act === "browse") openBrowse();
    else if (act === "scan") doScan(false);
    else if (act === "scanfull") doScan(true);
    else if (act === "removedir") {
      var dirs = (S.config.videoDirs || []).filter(function (d) { return d !== el.dataset.path; });
      Api.saveConfig({ videoDirs: dirs }).then(function () {
        S.config.videoDirs = dirs;
        toast("已移除");
        render();
      });
    } else if (act === "annotate") openAnnotate();
    else if (act === "asrstart") startAsr(false);
    else if (act === "asrstartforce") startAsr(true);
    else if (act === "asrsuggest") openSuggest();
    else if (act === "asrclear") {
      if (confirm("清空已提取的字幕/转写结果？词库不受影响。")) {
        Api.asrClear().then(function () { toast("已清空"); loadAsrCaps(); });
      }
    }
    else if (act === "savesettings") saveSettings();
    else if (act === "cat") toggleCat(el.dataset.id);
    else if (act === "export") exportProgress();
    else if (act === "reset") {
      if (confirm("确定清空全部学习记录？此操作不可恢复。")) {
        Api.reset().then(function () {
          S.progress = { days: {}, mastered: {} };
          toast("已清空");
          render();
        });
      }
    }
  };

  var player = document.getElementById("player");
  if (player) {
    var last = S.player && S.player.id === S.config.lastVideo ? S.player.time : 0;
    player.currentTime = last || 0;
    var prevT = last || 0;
    // 播放失败时把服务端的诊断原因显示出来，省得开 F12 抓 404
    player.addEventListener("error", function () {
      var box = document.getElementById("vidErr");
      if (!box) return;
      var c = player.error ? player.error.code : 0;
      var msg = { 1: "视频加载被中断", 2: "网络错误，视频流中断",
                  3: "视频解码失败", 4: "找不到视频，或格式不支持" }[c] || "视频加载失败";
      box.style.display = "block";
      box.innerHTML = "⚠️ " + msg + "，正在查询原因…";
      var cv = currentVideo();
      if (!cv || !Api.streamUrl) return;
      fetch(Api.streamUrl(cv), { headers: { "Range": "bytes=0-0" } })
        .then(function (r) { return r.ok ? null : r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (!j) { box.innerHTML = "⚠️ " + msg + "（服务器能读到文件，多半是浏览器不支持该编码）。"; return; }
          var d = j.detail || {};
          box.innerHTML = "⚠️ " + msg + "。<br>原因：<b>" + esc(j.reason || "未知") + "</b>　" +
            esc(j.hint || "") +
            "<br><span style=\"font-size:12px;opacity:.75\">容器内路径：" + esc(d.wanted || "") +
            "　存在：" + (d.exists ? "是" : "否") + "　允许播放：" + (d.allowed ? "是" : "否") + "</span>";
        })
        .catch(function () { box.innerHTML = "⚠️ " + msg + "。"; });
    });
    player.addEventListener("timeupdate", function () {
      var t = player.currentTime;
      if (!player.paused && t > prevT && t - prevT < 2) {
        addSec("video", t - prevT);
        S.player = { id: S.config.lastVideo, time: t };
        checkVideoBudget();
      }
      prevT = t;
      S.player = { id: S.config.lastVideo, time: t };
    });
    player.addEventListener("ended", function () {
      var d = today();
      var cur = currentVideo();
      if (!d.videos.some(function (v) { return v.id === cur.id; })) {
        d.videos.push({ id: cur.id, title: cur.title });
        saveProgress();
      }
      stepVideo(1);
    });
    player.addEventListener("pause", function () {
      if (player.currentTime > 5) {
        var d = today(), cur = currentVideo();
        if (!d.videos.some(function (v) { return v.id === cur.id; })) {
          d.videos.push({ id: cur.id, title: cur.title });
          saveProgress();
        }
      }
    });
  }

  if (S.route === "game") {
    setTimeout(drawLines, 30);
    window.addEventListener("resize", drawLines);
  }
  if (S.route === "parent") { loadHealth(); loadAsrCaps(); }
}

function checkVideoBudget() {
  var plan = S.config.plan || { video: 8 };
  if (S.videoHinted) return;
  if ((today().videoSec || 0) >= plan.video * 60) {
    S.videoHinted = true;
    toast("视频时间到啦，去跟读单词吧！");
  }
}
function doScan(full) {
  toast("开始扫描，请稍候…");
  Api.scan(full).then(function () {
    var timer = setInterval(function () {
      Api.scanStatus().then(function (r) {
        var el = document.getElementById("scanInfo");
        if (el) {
          el.textContent = r.scan.running
            ? (r.scan.message + "（" + r.scan.done + "/" + r.scan.total + "）")
            : (r.scan.message || "完成") + " · 共 " + S.videos.length + " 个视频";
        }
        if (!r.scan.running) {
          clearInterval(timer);
          Api.videos().then(function (v) {
            S.videos = v.videos || [];
            render();
          });
        }
      });
    }, 1500);
  });
}
function saveSettings() {
  var n = function (id, def) { return parseInt(document.getElementById(id).value, 10) || def; };
  var cfg = {
    dailyMinutes: n("cfDaily", 20),
    plan: {
      video: n("cfVideo", 8), speak: n("cfSpeak", 5),
      game: n("cfGame", 5), summary: 2
    },
    wordsPerDay: n("cfWords", 10),
    pairsPerRound: n("cfPairs", 6),
    reviewWords: n("cfReview", 10),
    frameInterval: n("cfFrame", 15)
  };
  Api.saveConfig(cfg).then(function (r) {
    S.config = r.config || S.config;
    toast("已保存");
    render();
  });
}
function toggleCat(id) {
  var cats = (S.config.categories || []).slice();
  var i = cats.indexOf(id);
  if (i >= 0) cats.splice(i, 1); else cats.push(id);
  Api.saveConfig({ categories: cats }).then(function (r) {
    S.config.categories = cats;
    Api.words().then(function (w) {
      S.words = dedupe(w.words || []);
      render();
    });
  });
}
function refreshWords() {
  Promise.all([Api.words(), Api.categories(), Api.annotations()]).then(function (r) {
    S.words = dedupe((r[0].words) || []);
    S.cats = r[1].categories || [];
    S.ann = (r[2].items) || {};
    render();
  });
}
function exportProgress() {
  var blob = new Blob([JSON.stringify(S.progress, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "english-kids-progress-" + todayKey() + ".json";
  a.click();
  toast("已导出");
}
function loadHealth() {
  Api.health().then(function (h) {
    var el = document.getElementById("healthCard");
    if (!el) return;
    var bad = h.badFormats || [];
    el.innerHTML = '<div style="font-weight:700;margin-bottom:8px">🩺 自检</div>' +
      '<div class="stat"><span class="muted">ffmpeg（截图/时长）</span><b>' +
      (h.ffmpeg ? "可用 ✅" : "不可用 ⚠️") + '</b></div>' +
      '<div class="stat"><span class="muted">媒体根目录</span><b>' + esc(h.hostRoot || h.mediaRoot) + '</b></div>' +
      '<div class="stat"><span class="muted">已收录视频</span><b>' + h.videoCount + '</b></div>' +
      '<div class="stat"><span class="muted">iPad 可能播不了</span><b>' + (h.badFormatCount || 0) + ' 个</b></div>' +
      (bad.length ? '<div class="muted" style="margin-top:8px">建议转成 mp4：' +
        bad.map(esc).join("、") + '</div>' : '') +
      hwLine(h.hw, h.asr) +
      '<div class="muted" style="margin-top:8px">服务端口 13002 · 仅局域网访问</div>';
  });
}

/* 硬件加速能力：Intel 核显只帮得上转码，帮不上语音识别 */
function hwLine(hw, asr) {
  hw = hw || {};
  asr = asr || {};
  var gpu = (asr.cuda || 0) > 0;
  var lines = [];
  lines.push('<div class="stat"><span class="muted">语音识别引擎</span><b>' +
    (gpu ? 'GPU ' + esc(asr.cudaName || 'NVIDIA') : 'CPU' +
      ((asr.runtime && asr.runtime.device === "cpu" && asr.runtime.threads)
        ? ' ' + asr.runtime.threads + ' 线程' : '')) + '</b></div>');
  if (hw.qsv || hw.vaapi) {
    lines.push('<div class="stat"><span class="muted">视频转码硬件加速</span><b>' +
      (hw.qsv ? 'Intel QSV ✅' : 'VAAPI ✅') + '</b></div>');
  } else if (hw.dri) {
    lines.push('<div class="stat"><span class="muted">核显设备</span><b>已识别但缺驱动</b></div>');
  } else {
    lines.push('<div class="stat"><span class="muted">视频转码硬件加速</span><b>无（走 CPU）</b></div>');
  }
  lines.push('<div class="muted" style="margin-top:6px">' +
    (gpu ? 'NVIDIA 独显可用，语音识别走 GPU。'
         : 'Intel / AMD 核显不能加速语音识别（模型只支持 NVIDIA CUDA），' +
           '只能用「快速模式」少听几分钟来提速。') + '</div>');
  return lines.join("");
}

/* ============ 从视频提取单词 ============ */
function loadAsrCaps() {
  Api.asrStatus().then(function (r) {
    S.asrCaps = r.caps || {};
    S.asrRunning = !!(r.state && r.state.running);
    var el = document.getElementById("asrCaps");
    if (el) {
      var c = S.asrCaps;
      var rt = c.runtime || {};
      var engine = c.cuda > 0
        ? 'GPU（' + esc(c.cudaName || 'NVIDIA') + '）'
        : (rt.device === "cpu" && rt.threads
          ? 'CPU ' + rt.threads + ' 线程 / 共 ' + (c.cores || '?') + ' 核'
          : 'CPU');
      el.innerHTML = 'ffmpeg ' + (c.ffmpeg ? '✅' : '⚠️') +
        ' · 语音识别 ' + (c.whisper ? '✅' : '⚠️ 未安装') +
        ' · 模型 ' + (c.modelReady ? esc(c.modelSize || '') : '未就绪') +
        ' · 引擎 <b>' + engine + '</b>' +
        (c.cuda > 0 ? '' : '<span class="muted">（Intel / AMD 核显不支持加速，只能走 CPU）</span>') +
        '<br>' + (c.whisper && c.modelReady
          ? '没有字幕的视频会自动转写。用「快速模式」只听前一两分钟，快很多'
          : '只能提取已有字幕的视频；想用语音识别需要带模型的镜像');
    }
    renderAsrProgress(r.state);
    if (S.asrRunning && S.route === "parent") setTimeout(loadAsrCaps, 1500);
  });
}

// 提取进度条：整体 % + 第几集 + 当前阶段 + 预计剩余时间
function fmtEta(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return sec + " 秒";
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + " 分 " + (s ? s + " 秒" : "");
  return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
}
function renderAsrProgress(st) {
  var el = document.getElementById("asrInfo");
  if (!el) return;
  if (!st) { el.innerHTML = ""; return; }
  if (!st.running) {
    el.innerHTML = st.message ? esc(st.message) : "";
    if (S.asrRunning) {          // 刚跑完
      S.asrRunning = false;
      toast("提取完成：" + (st.message || ""));
    }
    return;
  }
  var pct = Math.max(0, Math.min(100, st.pct || 0));
  var eta = st.etaSec > 0 ? " · 预计还需 " + fmtEta(st.etaSec) : "";
  el.innerHTML =
    '<div class="progwrap">' +
    '<div class="progbar"><i style="width:' + pct + '%"></i></div>' +
    '<div class="progtxt"><b>' + pct + '%</b>' +
    ' · 第 ' + (st.current || 0) + '/' + (st.total || 0) + ' 集' +
    (st.title ? ' · ' + esc(st.title) : '') + '</div>' +
    '<div class="muted">' + esc(st.phase || "") + ' ' + Math.round(st.itemPct || 0) + '%' +
    eta + '</div></div>';
}
function startAsr(force) {
  if (!S.videos.length) { toast("先扫描视频再来提取"); return; }
  var ids = S.videos.map(function (v) { return v.id; });
  var cb = document.getElementById("asrFast");
  var sel = document.getElementById("asrSec");
  var fast = !!(cb && cb.checked);
  var sec = parseInt((sel && sel.value) || "90", 10);
  Api.asrStart(ids, force, fast, sec).then(function () {
    toast(fast ? ("开始提取（快速模式，每集听前 " + sec + " 秒）")
               : "开始提取，字幕很快，语音识别会慢一些…");
    S.asrRunning = true;
    loadAsrCaps();
  }).catch(function (e) { toast("启动失败：" + e.message); });
}
function openSuggest() {
  Api.asrSuggest(200, 2).then(function (r) {
    S.asrCands = r.words || [];
    if (!S.asrCands.length) {
      toast("还没有候选词，先点「开始提取」");
      return;
    }
    renderSuggest();
  }).catch(function (e) { toast("读取候选词失败：" + e.message); });
}
function renderSuggest() {
  var cats = ["animals", "fruit", "colors", "numbers", "body", "family", "actions", "transport", "video"];
  var h = '<h3>候选词（按出现集数排序）</h3>';
  h += '<div class="muted" style="margin-bottom:10px">勾选要加入词库的词，中文可以直接改，' +
    '勾了「配图」会在说到这个词的那一刻自动截一帧当连词配图。</div>';
  h += '<div class="btnrow" style="margin-bottom:10px">' +
    '<button class="btn sm ghost" data-act="asrall">全选</button>' +
    '<button class="btn sm ghost" data-act="asrnone">全不选</button>' +
    '<button class="btn sm ghost" data-act="asrframe">只勾有中文的</button></div>';
  h += '<div class="asrlist">' + S.asrCands.map(function (w, i) {
    return '<div class="asrrow">' +
      '<label class="asrchk"><input type="checkbox" data-i="' + i + '"' +
      (w.inLibrary ? ' disabled' : '') + '> <b>' + esc(w.word) + '</b>' +
      (w.inLibrary ? ' <span class="muted">已在词库</span>' : '') + '</label>' +
      '<input type="text" class="asrzh" data-i="' + i + '" value="' + esc(w.zh || "") + '" placeholder="中文">' +
      '<select class="asrcat" data-i="' + i + '">' + cats.map(function (c) {
        return '<option value="' + c + '"' + (c === w.category ? ' selected' : '') + '>' + c + '</option>';
      }).join("") + '</select>' +
      '<div class="muted">' + w.videoCount + ' 集 / ' + w.count + ' 次</div>' +
      '<label class="asrchk"><input type="checkbox" class="asrimg" data-i="' + i + '" checked> 配图</label>' +
      '<div class="muted asrsamp">“' + esc((w.sample || "").slice(0, 70)) + '”</div>' +
      '</div>';
  }).join("") + '</div>';
  h += '<div class="btnrow" style="margin-top:14px">' +
    '<button class="btn green" data-act="asrimport">导入选中的词</button>' +
    '<button class="btn ghost" data-act="closesheet">关闭</button></div>';
  openSheet(h);
  bindSheet();
}
function importSuggest() {
  var picked = [];
  document.querySelectorAll(".asrlist .asrchk input[type=checkbox]:not(.asrimg)").forEach(function (cb) {
    if (!cb.checked || cb.disabled) return;
    var i = parseInt(cb.dataset.i, 10);
    var w = S.asrCands[i];
    var zh = document.querySelector('.asrzh[data-i="' + i + '"]');
    var cat = document.querySelector('.asrcat[data-i="' + i + '"]');
    var img = document.querySelector('.asrimg[data-i="' + i + '"]');
    var vs = Object.keys(w.videos || {});
    picked.push({
      word: w.word, zh: zh ? zh.value.trim() : "", category: cat ? cat.value : "video",
      sample: w.sample, useFrame: !!(img && img.checked),
      videoId: vs[0] || "", time: (w.videos[vs[0]] || {}).time || w.sampleTime || 0
    });
  });
  if (!picked.length) { toast("还没有勾选任何词"); return; }
  Api.asrImport(picked).then(function (r) {
    toast("已加入 " + r.added + " 个词" + (r.framed ? "，自动配图 " + r.framed + " 张" : ""));
    closeSheet();
    refreshWords();
  }).catch(function (e) { toast("导入失败：" + e.message); });
}

/* ============ 启动 ============ */
function init() {
  var hash = (location.hash || "").replace("#/", "");
  S.route = ["today", "video", "speak", "game", "review", "summary", "parent"].indexOf(hash) >= 0 ? hash : "today";

  Promise.all([
    Api.config(), Api.videos(), Api.words(), Api.progress(), Api.annotations(), Api.categories()
  ]).then(function (r) {
    S.config = r[0].config || S.config;
    S.videos = r[1].videos || [];
    S.words = dedupe(r[2].words || []);
    S.progress = r[3] || { days: {}, mastered: {} };
    if (!S.progress.days) S.progress.days = {};
    if (!S.progress.mastered) S.progress.mastered = {};
    S.ann = (r[4] && r[4].items) || {};
    S.cats = r[5].categories || [];
    if (!S.progress.learned) migrateLearned();
    today();
    render();
  }).catch(function (e) {
    document.getElementById("view").innerHTML =
      '<div class="empty"><div class="e">😴</div><p>连不上服务</p><p class="muted">' + esc(e.message) + '</p></div>';
  });

  document.querySelectorAll(".tab").forEach(function (b) {
    b.onclick = function () { go(b.dataset.tab); };
  });
  document.getElementById("btnParent").onclick = function () { go("parent"); };
  document.getElementById("modal").onclick = function (e) {
    if (e.target.id === "modal") closeSheet();
  };
  window.addEventListener("pagehide", function () { flushTimer(); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) flushTimer();
  });
  // iOS 首次朗读必须在用户手势里触发
  var unlock = function () {
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch (e) { }
    document.removeEventListener("click", unlock);
  };
  document.addEventListener("click", unlock);
}

init();

/* 与后端通信的封装 */
var Api = (function () {
  function req(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function post(url, body) {
    return req(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }
  return {
    health: function () { return req("/api/health"); },
    config: function () { return req("/api/config"); },
    saveConfig: function (c) { return post("/api/config", c); },
    browse: function (p) { return req("/api/browse?path=" + encodeURIComponent(p || "")); },
    videos: function () { return req("/api/videos"); },
    scan: function (full) { return post("/api/scan", { full: !!full }); },
    scanStatus: function () { return req("/api/scan/status"); },
    words: function () { return req("/api/words"); },
    categories: function () { return req("/api/categories"); },
    annotations: function () { return req("/api/annotations"); },
    annotate: function (img, word) { return post("/api/annotate", { image: img, word: word }); },
    annotateRemove: function (img, word) { return post("/api/annotate/remove", { image: img, word: word }); },
    progress: function () { return req("/api/progress"); },
    saveProgress: function (p) { return post("/api/progress", p); },
    reset: function () { return post("/api/reset", {}); },
    asrStatus: function () { return req("/api/asr/status"); },
    asrStart: function (ids, force, fast, sec) {
      return post("/api/asr/start", { ids: ids || [], force: !!force, fast: !!fast, sec: sec || 0 });
    },
    asrSuggest: function (limit, minCount) {
      return req("/api/asr/suggest?limit=" + (limit || 200) + "&minCount=" + (minCount || 2));
    },
    asrImport: function (words) { return post("/api/asr/import", { words: words }); },
    asrClear: function () { return post("/api/asr/clear", {}); },
    streamUrl: function (v) { return "/api/stream?id=" + encodeURIComponent(v.id); }
  };
})();

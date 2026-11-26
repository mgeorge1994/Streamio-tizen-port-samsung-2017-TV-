/* Native torrent engine bridge.
   Talks to the NaCl module embedded in index.html. The C++ side runs
   nacl_io (POSIX TCP/UDP sockets) and serves played torrents on
   http://127.0.0.1:11470, exactly like the Android app's local server. */
(function (w) {
  var module = null;
  var pending = [];
  var ready = false;
  var lastStart = null;   // retried until the module acknowledges it
  var info = { embed: false, mime: false, events: [], init: '-', pong: false, stage: '-', loaded: false, msgs: 0 };

  function note(s) {
    info.events.push(s);
    if (info.events.length > 10) info.events.shift();
  }

  // Post whenever the module element exists. Never gate this on `ready`:
  // Samsung can drop messages posted from Init() before JS attaches listeners,
  // so we must be able to ping the module to wake it up.
  function send(obj) {
    if (!module) { pending.push(obj); return; }
    try { module.postMessage(obj); } catch (e) { note('post-err'); }
  }

  var lastMessage = null, lastMessageAt = 0;
  // NaCl posts JSON strings, not dictionaries. Older builds dropped every
  // reply here, so pong/init/started/staged were never seen by the player.
  function decodeMessage(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return (typeof raw === 'object') ? raw : null;
  }
  function onMessage(e) {
    var d = decodeMessage(e.data);
    if (!d) return;
    // One NaCl message can surface on the embed, document and window.
    var key = String(e.data), now = Date.now();
    if (key === lastMessage && now - lastMessageAt < 50) return;
    lastMessage = key; lastMessageAt = now;
    info.msgs++;
    note('msg:' + (d.event || '?'));
    if (d.event === 'init') {
      info.init = d.ok ? 'ok' : 'FAIL';
      if (d.stage) info.loaded = true;
      ready = true;
      flush();
    }
    if (d.event === 'pong') { info.pong = true; ready = true; flush(); }
    if (d.event === 'started') {
      info.engineStarted = true;
      lastStart = null;   // acknowledged: stop re-posting the start command
    }
    if (d.event === 'stopped') { info.engineStarted = false; }
    if (d.event === 'stats') { info.lastStats = d.data || null; }
    if (d.event === 'stage') {
      info.stage = (d.name || '?') + ':' + (d.ok ? 'ok' : 'FAIL');
      ready = true;
      flush();
    }
  }

  function flush() {
    for (var i = 0; i < pending.length; i++) {
      try { module.postMessage(pending[i]); } catch (err) {}
    }
    pending = [];
  }

  function init() {
    module = document.getElementById('stremio-engine');
    var listener = document.getElementById('engine-listener');
    info.embed = !!module;
    try {
      info.mime = !!(navigator.mimeTypes && navigator.mimeTypes['application/x-nacl']);
    } catch (e) {}

    // Samsung may dispatch messages on the embed, its parent, the document,
    // or window. Listen everywhere so none are lost.
    w.addEventListener('message', onMessage, false);
    document.addEventListener('message', onMessage, false);
    var targets = [];
    if (listener) targets.push(listener);
    if (module) targets.push(module);
    for (var i = 0; i < targets.length; i++) attach(targets[i], targets[i] === module ? 'embed' : 'div');

    // Ping on load and periodically: the module responds even if its Init()
    // message was dropped before JS was ready.
    setTimeout(ping, 1500);
    setTimeout(ping, 4000);
    setTimeout(ping, 9000);
    setInterval(ping, 3000);
  }

  function ping() {
    note('ping');
    send({ cmd: 'ping' });
    // The player reads /stats over HTTP. Asking NaCl for stats every 3 s used
    // to add heavy work to its single message thread (v1.0.84 removed this).
    // Re-post the last start command only until the engine acknowledges it.
    if (lastStart && !info.engineStarted) send(lastStart);
  }

  function attach(el, tag) {
    var events = ['loadstart', 'load', 'progress', 'error', 'crash'];
    for (var i = 0; i < events.length; i++) {
      (function (name) {
        el.addEventListener(name, function () {
          note(tag + ':' + name);
          if (name === 'load') setTimeout(ping, 200);
        }, true);
      })(events[i]);
    }
    el.addEventListener('message', onMessage, false);
    el.addEventListener('message', onMessage, true);
  }

  w.Engine = {
    init: init,
    isReady: function () { return ready; },
    getInfo: function () { return info; },
    start: function (hash, fileIdx, sources, fileName) {
      if (!hash) return;
      // sources: Stremio peer sources ("tracker:udp://...", "dht:..."), as the
      // Android TV server receives them. fileIdx -1 = let the engine pick the
      // file (fileName = addon behaviorHints.filename, else largest video).
      lastStart = { cmd: 'start', hash: hash,
                    fileIdx: (typeof fileIdx === 'number') ? fileIdx : 0,
                    trackers: (sources || []).join(','), fileName: fileName || '' };
      info.engineStarted = false;
      send(lastStart);
    },
    stop: function () { lastStart = null; info.engineStarted = false; send({ cmd: 'stop' }); },
    // Background pre-load of another file of the running torrent (next episode).
    prefetch: function (fileIdx) { send({ cmd: 'prefetch', fileIdx: fileIdx }); },
    stats: function () { send({ cmd: 'stats' }); }
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);

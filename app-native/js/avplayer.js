/* Samsung AVPlay -- the TV's native media pipeline -- behind the small part of
   the HTMLMediaElement interface the player uses (src, load, play, pause,
   currentTime, duration, paused, readyState, buffered, events).
   The browser <video> on Tizen 3.0 cannot decode many torrent releases
   (MKV/HEVC/AC3/...). When it fails, app.js swaps in this player, which plays
   the same on-device URL (http://127.0.0.1:11470/...) through AVPlay.
   ES5 only (Chromium M47). */
(function (w) {
  function api() {
    try { return (w.webapis && w.webapis.avplay) ? w.webapis.avplay : null; } catch (e) { return null; }
  }

  function AvPlayer(container) {
    var self = this, av = api(), handlers = {}, durMs = 0, curMs = 0, url = '';
    var prepared = false, wantPlay = false, destroyed = false;
    self.isAvPlay = true;
    self.paused = true;
    self.readyState = 0;
    self.error = null;
    self.buffered = { length: 0, start: function () { return 0; }, end: function () { return 0; } };

    // AVPlay renders on a video plane behind the page; this object reserves it.
    var obj = document.createElement('object');
    obj.setAttribute('type', 'application/avplayer');
    obj.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px';
    container.appendChild(obj);

    function emit(type) {
      var list = handlers[type];
      if (!list || destroyed) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i].call(self, { type: type, target: self }); } catch (e) {}
      }
    }
    function fail(msg) {
      self.error = { code: 4, message: String(msg || 'AVPlay error') };
      setTimeout(function () { emit('error'); }, 0);
    }
    self.addEventListener = function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); };
    self.removeEventListener = function (type, fn) {
      var list = handlers[type] || [];
      for (var i = 0; i < list.length; i++) if (list[i] === fn) { list.splice(i, 1); return; }
    };

    Object.defineProperty(self, 'src', {
      get: function () { return url; },
      set: function (v) { url = v || ''; }
    });
    Object.defineProperty(self, 'duration', {
      get: function () { return durMs > 0 ? durMs / 1000 : NaN; }
    });
    Object.defineProperty(self, 'currentTime', {
      get: function () { return curMs / 1000; },
      set: function (sec) { seek(sec); }
    });

    function listener() {
      return {
        onbufferingstart: function () { self.readyState = 2; emit('waiting'); },
        onbufferingprogress: function () { emit('progress'); },
        onbufferingcomplete: function () {
          self.readyState = 4; emit('canplay');
          if (!self.paused) emit('playing');
        },
        oncurrentplaytime: function (ms) {
          curMs = ms;
          if (!durMs) { try { durMs = av.getDuration() || 0; } catch (e) {} }
          emit('timeupdate');
        },
        onstreamcompleted: function () { self.paused = true; emit('ended'); },
        onerror: function (type) { fail('AVPlay: ' + type); },
        onevent: function () {},
        onsubtitlechange: function () {},
        ondrmevent: function () {}
      };
    }

    self.load = function () {
      if (!av) { fail('AVPlay is not available on this device'); return; }
      if (!url) return;
      prepared = false;
      try {
        try { av.stop(); } catch (e1) {}
        try { av.close(); } catch (e2) {}
        av.open(url);
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setListener(listener());
        av.prepareAsync(function () {
          if (destroyed) return;
          prepared = true;
          try { durMs = av.getDuration() || 0; } catch (e) {}
          self.readyState = 4;
          emit('loadedmetadata');
          emit('canplay');
          if (wantPlay) self.play();
        }, function (err) {
          fail('AVPlay prepare failed: ' + (err && err.name ? err.name : err));
        });
      } catch (e) {
        fail('AVPlay: ' + (e && e.message ? e.message : e));
      }
    };
    self.play = function () {
      wantPlay = true;
      if (!prepared || destroyed) return;
      try { av.play(); self.paused = false; emit('play'); emit('playing'); } catch (e) {}
    };
    self.pause = function () {
      wantPlay = false;
      try { av.pause(); } catch (e) {}
      self.paused = true;
      emit('pause');
    };
    function seek(sec) {
      if (!prepared || destroyed) return;
      var ms = Math.max(0, Math.floor((Number(sec) || 0) * 1000));
      curMs = ms;            // like <video>: currentTime reports the target while seeking
      emit('seeking');
      try {
        av.seekTo(ms, function () { curMs = ms; emit('seeked'); emit('timeupdate'); },
                      function () { emit('seeked'); });
      } catch (e) { emit('seeked'); }
    }
    self.destroy = function () {
      destroyed = true;
      try { av.stop(); } catch (e1) {}
      try { av.close(); } catch (e2) {}
      if (obj.parentNode) obj.parentNode.removeChild(obj);
    };
  }

  AvPlayer.available = function () { return !!api(); };
  AvPlayer.diag = function () {
    return { webapis: typeof w.webapis, avplay: !!api(),
      ua: (w.navigator && w.navigator.userAgent) || '' };
  };
  w.AvPlayer = AvPlayer;
})(window);

/* app.js — shell, routing, player, remote handling */
var App = (function () {
  var view = null, history = [], current = null, toastTimer = null, loadTimer = null;
  var tabs = [
    { id: 'search', label: 'Search', icon: 'search', active: 'search' },
    { id: 'board', label: 'Home', icon: 'home', active: 'home' },
    { id: 'discover', label: 'Discover', icon: 'discover_outline', active: 'discover' },
    { id: 'library', label: 'Library', icon: 'library_outline', active: 'library' },
    { id: 'settings', label: 'Settings', icon: 'settings', active: 'settings' }
  ];

  function toast(msg) {
    var t = U.qs('#toast'); t.innerHTML = U.esc(msg); t.className = 'toast show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function buildSidebar() {
    var host = U.qs('#side-tabs');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        var e = U.el('div', 'tab');
        e.setAttribute('data-tab', t.id);
        e.innerHTML = '<span class="bar"></span><span class="tab-icon" style="background-image:' + U.icon(t.icon) + '"></span>' +
          '<span class="tab-label">' + U.esc(t.label) + '</span>';
        // Like the Android TV nav bar: focusing an item selects it immediately —
        // no separate OK press. Keep focus on the tab so you can walk the bar.
        e.onfocusin = function () {
          if (current && current.name === t.id) return;   // already showing this page
          navigate(t.id);
          Focus.set(e);                                   // navigate() clears focus + tab classes
        };
        e.onclick = function () { navigate(t.id); };
        host.appendChild(e);
      })(tabs[i]);
    }
  }
  function focusInSidebar() {
    var p = Focus.get();
    while (p && p !== document.body) { if (p.id === 'sidebar') return true; p = p.parentNode; }
    return false;
  }
  // Only touch this one class: never overwrite body.className wholesale (that
  // would wipe avplay-active during playback and put the page over the video).
  function setLoading(on) {
    if (!document.body) return;
    var bc = (' ' + document.body.className + ' ').replace(/ page-loading /g, ' ');
    document.body.className = (bc + (on ? ' page-loading' : '')).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
  }
  function isLoading() {
    return !!document.body && (' ' + document.body.className + ' ').indexOf(' page-loading ') !== -1;
  }
  function refreshTabIcons() {
    // Selected tab turns WHITE when focus is out in the content/buttons; it is
    // only indigo when the nav bar itself is being navigated.
    var inBar = focusInSidebar();
    var loading = isLoading();
    // Focus moved into the content (or the first shelf arrived): load styling
    // is no longer needed. Toggle only nav-idle — overwriting className would
    // wipe avplay-active during playback and put the page over the video.
    if (!inBar && loading) { setLoading(false); loading = false; }
    if (document.body) {
      var bc = (' ' + document.body.className + ' ').replace(/ nav-idle /g, ' ');
      document.body.className = (bc + (inBar ? '' : ' nav-idle')).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
    }
    var all = U.qsa('.tab');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      // Selecting a tab puts focus back on it, which otherwise kept the icon
      // enlarged and indigo (faint enough to look missing) until the network
      // calls completed — on every visit, first or second.
      if (!inBar) e.className = e.className.replace(/\sfocused/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      var isFocused = (' ' + e.className + ' ').indexOf(' focused ') !== -1;
      var isActive = (' ' + e.className + ' ').indexOf(' active ') !== -1;
      var def = null;
      for (var j = 0; j < tabs.length; j++) if (tabs[j].id === e.getAttribute('data-tab')) def = tabs[j];
      if (!def) continue;
      // The active tab ALWAYS keeps its filled white icon. While a page loads,
      // ignore the transient focus so it never shrinks into a faint purple icon
      // that reads as "missing". Only the colour changes once focus settles.
      // During a load the tab is still selected: keep its filled purple icon at
      // normal size. The old white variant made it look like a different tab.
      var iconFocused = isFocused || loading;
      var file = isActive ? (def.active + (iconFocused ? '_purple' : '')) : def.icon;
      var ic = U.qs('.tab-icon', e);
      if (ic) ic.style.backgroundImage = U.icon(file);
    }
    // Player buttons: focus is shown by turning the icon indigo, not by a box.
    var btns = U.qsa('.pbtn[data-icon]');
    for (var b = 0; b < btns.length; b++) {
      var btn = btns[b], bic = U.qs('i', btn);
      if (!bic) continue;
      var on = (' ' + btn.className + ' ').indexOf(' focused ') !== -1;
      // The primary play/pause icon stays white when focused — only the circle
      // highlight changes; secondary controls turn indigo.
      var isPlay = btn.id === 'pp';
      bic.style.backgroundImage = U.icon(btn.getAttribute('data-icon') + (on && !isPlay ? '_purple' : ''));
    }
  }
  function markTab(id) {
    var all = U.qsa('.tab');
    for (var i = 0; i < all.length; i++) {
      var e = all[i], active = e.getAttribute('data-tab') === id;
      // Keep the focused class on the tab being selected; clearing it here and
      // re-adding it in Focus.set() made the nav icon flicker on every switch.
      var focused = (' ' + e.className + ' ').indexOf(' focused ') !== -1;
      e.className = 'tab' + (active ? ' active' : '') + (focused ? ' focused' : '');
    }
    refreshTabIcons();
  }

  function navigate(name, params, replace) {
    if (current && !replace) history.push(current);
    current = { name: name, params: params || {} };
    // Keep the nav bar in its calm, readable state until the new page has had
    // a chance to render, whether the data comes from the network or cache.
    setLoading(true);
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(function () { setLoading(false); refreshTabIcons(); }, 1200);
    markTab(name);
    Focus.clear();
    Focus.setRoot(U.qs('#app'));
    if (Views.dispose) Views.dispose();
    if (name === 'board') Views.board(view);
    else if (name === 'discover') Views.discover(view, false);
    else if (name === 'library') Views.library(view);
    else if (name === 'search') Views.search(view);
    else if (name === 'settings') Views.settings(view);
    else if (name === 'addons') Views.addons(view);
    else if (name === 'meta') Views.meta(view, current.params.id, current.params.type || 'movie', current.params);
    else Views.board(view);
  }
  function back() {
    // A held Back key repeats on Tizen. The first press closes the player and
    // returns to the menu page it was opened from; ignore the repeats so we do
    // not immediately navigate away from that page too.
    if (!isLayerOpen() && lastLayerClose && Date.now() - lastLayerClose < 800) return;
    var dd = U.qs('.picker-options.open');
    if (dd) {
      dd.className = 'picker-options';
      var stale = U.qsa('.picker-options .focused');
      for (var i = 0; i < stale.length; i++) stale[i].className = stale[i].className.replace(/\sfocused/g, '');
      var v = dd.parentNode ? U.qs('.picker-value', dd.parentNode) : null;
      if (v) Focus.set(v);
      return;
    }
    if (isLayerOpen()) { closeLayers(); return; }
    if (history.length) { var prev = history.pop(); navigate(prev.name, prev.params, true); }
    else { navigate('board', {}, true); }
  }
  function openMeta(id, type, opts) {
    if (!id) return;
    var p = { id: id, type: type || 'movie' };
    if (opts && opts.fromContinue) p.fromContinue = true;
    navigate('meta', p);
  }
  function openStreams(videoId, type, title, metaData) {
    navigate('meta', { id: videoId, type: type, title: title, fromContinue: true });
  }
  // Continue Watching: resume straight into the torrent that was last played
  // for this item (same hash/file, same position). If it was never played from
  // this TV, fall back to the normal torrent list.
  function continueWatching(item) {
    if (!item) return;
    var type = item.type || 'movie';
    var vid = item.videoId || item.id;
    var s = API.lastStream([vid, item.id]);
    if (!s || !API.isPlayable(s)) { openMeta(vid, type, { fromContinue: true }); return; }
    var pid = item.id, em = /^(.+):(\d+):(\d+)$/.exec(String(vid || ''));
    if (em) pid = em[1];
    var pr = API.progress(pid) || API.progress(vid);
    var resume = (pr && pr.pos > 0 && !API.finished(pr) && (!em || pr.videoId === vid)) ? pr.pos : 0;
    var meta = { id: item.id, name: item.name, type: type, poster: item.poster,
      background: item.background, logo: item.logo };
    // Continue Watching already loaded the series meta; reuse it so the
    // player's previous/next episode buttons are available immediately.
    var cached = API.cachedMeta('series', item.id);
    if (cached && cached.meta && cached.meta.videos) meta = cached.meta;
    var parsed = API.parseStream(s);
    playStream(s, meta, { title: item.name, quality: parsed.quality, seeders: parsed.seeders,
      progressId: pid, resumePos: resume, videoId: vid, mediaType: type });
  }

  /* ---------------- layers ---------------- */
  function isLayerOpen() {
    return U.qs('#modal-layer').className.indexOf('hidden') === -1 ||
      U.qs('#keyboard-layer').className.indexOf('hidden') === -1 ||
      U.qs('#player-layer').className.indexOf('hidden') === -1;
  }
  function closeLayers() {
    var modal = U.qs('#modal-layer'), kb = U.qs('#keyboard-layer'), pl = U.qs('#player-layer');
    if (pl.className.indexOf('hidden') === -1) {
      var returnTo = playerReturnFocus;
      playerReturnFocus = null;
      stopPlayer(); pl.className = 'layer hidden';
      lastLayerClose = Date.now();
      // Back from video returns to the exact page/control it was opened from
      // (e.g. the torrent list), with focus restored there.
      Focus.setRoot(U.qs('#app'));
      if (returnTo && returnTo.parentNode) Focus.set(returnTo);
      else { var f = Focus.candidates()[0]; if (f) Focus.set(f); }
      return;
    }
    if (kb.className.indexOf('hidden') === -1) { kb.className = 'layer hidden'; Focus.setRoot(U.qs('#app')); Focus.first(); lastLayerClose = Date.now(); return; }
    if (modal.className.indexOf('hidden') === -1) { stopQrPolling(); modal.className = 'layer hidden'; Focus.setRoot(U.qs('#app')); Focus.first(); lastLayerClose = Date.now(); }
  }

  function modal(title, rows) {
    var layer = U.qs('#modal-layer');
    layer.className = 'layer'; clearLayer(layer);
    var m = U.el('div', 'modal');
    m.innerHTML = '<div class="m-close" data-focus="1"></div><h2>' + U.esc(title) + '</h2>';
    var close = U.qs('.m-close', m); close.onclick = function () { closeLayers(); };
    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var sw = r.color ? '<span class="m-swatch" style="background:' + U.attr(r.color) + '"></span>' : '';
        var e = U.el('div', 'm-row', sw + U.esc(r.label));
        e.setAttribute('data-focus', '1'); e.onclick = function () { closeLayers(); r.fn(); };
        m.appendChild(e);
      })(rows[i]);
    }
    layer.appendChild(m);
    Focus.setRoot(layer); Focus.first();
  }
  function clearLayer(layer) { while (layer.firstChild) layer.removeChild(layer.firstChild); }

  /* on-screen keyboard for text input (addon URL / credentials) */
  function textInput(title, initial, done, masked) {
    var layer = U.qs('#keyboard-layer');
    var prevRoot = Focus.getRoot();
    layer.className = 'layer'; clearLayer(layer);
    var init = initial !== undefined && initial !== null ? initial : (masked ? '' : 'https://');
    var box = U.el('div', 'modal wide-modal');
    box.innerHTML = '<h2>' + U.esc(title) + '</h2>' +
      '<div class="search-box" data-focus="1" id="ti-box"><input class="search-input" id="ti-input" type="' + (masked ? 'password' : 'text') + '" value="' + U.attr(init) + '" /></div>' +
      '<div id="ti-kb" class="keyboard" style="margin-top:24px"></div>';
    layer.appendChild(box);
    Focus.setRoot(layer);
    var input = U.qs('#ti-input', box);
    function finish() {
      var v = input.value;
      layer.className = 'layer hidden';
      Focus.setRoot(prevRoot);
      if (prevRoot) Focus.first();
      done(v);
    }
    U.keyboard(U.qs('#ti-kb', box), [
      { label: 'SPACE', fn: function () { input.value += ' '; } },
      { label: 'CLEAR', fn: function () { input.value = ''; } },
      { label: 'DONE', fn: finish }
    ], function (ch) {
      input.value += (/^[A-Z]$/.test(ch) ? ch.toLowerCase() : ch);
    }, function () {
      input.value = input.value.slice(0, -1);
    });
  }

  /* ---------------- account ---------------- */
  function updateProfile() {
    var a = API.auth();
    var nameEl = U.qs('#profile-name');
    var avatarEl = U.qs('#avatar');
    if (!nameEl) return;
    var name = a && a.user ? (a.user.email || a.user.username || 'Stremio User') : 'Guest';
    nameEl.innerHTML = U.esc(name.length > 16 ? name.slice(0, 15) + '…' : name);
    if (avatarEl) {
      avatarEl.style.backgroundImage = a && a.user && a.user.avatar
        ? 'url("' + U.attr(a.user.avatar) + '")'
        : 'url("assets/icons/person_outline.svg")';
      avatarEl.style.backgroundSize = a && a.user && a.user.avatar ? 'cover' : '58%';
      avatarEl.style.backgroundRepeat = 'no-repeat';
      avatarEl.style.backgroundPosition = 'center';
    }
  }

  function account() {
    var a = API.auth();
    if (a && a.authKey) {
      var name = a.user ? (a.user.email || a.user.username || 'Stremio User') : 'Signed in';
      modal('Account', [
        { label: name, fn: function () { toast(name); } },
        { label: 'Sync my addons', fn: function () { syncAddons(); } },
        { label: lastSyncError ? ('Sync error: ' + lastSyncError) : 'Sync status: OK',
          fn: function () { toast(lastSyncError || 'Account synced'); } },
        { label: 'Sign Out', fn: function () { API.logout(); updateProfile(); toast('Signed out'); } }
      ]);
      return;
    }
    modal('Sign in to Stremio', [
      { label: 'Sign in with QR Code', fn: qrSignIn },
      { label: 'Sign in with Email', fn: function () { credentials('login'); } },
      { label: 'Create Account', fn: function () { credentials('register'); } },
      { label: 'Continue as Guest', fn: function () { toast('Continuing as guest'); } }
    ]);
  }

  function qrSignIn() {
    var layer = U.qs('#modal-layer');
    layer.className = 'layer'; clearLayer(layer);
    var m = U.el('div', 'modal qr-modal');
    m.innerHTML = '<div class="m-close" data-focus="1"></div><h2>Sign in with QR code</h2>' +
      '<div class="qr-body" id="qr-body"><div class="empty">Creating link code…</div></div>';
    layer.appendChild(m);
    U.qs('.m-close', m).onclick = function () { stopQrPolling(); closeLayers(); };
    Focus.setRoot(layer); Focus.first();

    API.createLinkCode(function (link) {
      var body = U.qs('#qr-body', m);
      if (!body || layer.className.indexOf('hidden') !== -1) return;
      var qr = link.qrcode || ('https://link.stremio.com/qr?data=' + encodeURIComponent(link.link || ''));
      body.innerHTML = '<img class="qr-img" src="' + U.attr(qr) + '" />' +
        '<div class="qr-code">' + U.esc(link.code) + '</div>' +
        '<div class="qr-help">On your phone or computer, open stremio.com/acc-settings, sign in, then enter this 4-character code.</div>' +
        '<div class="qr-status" id="qr-status">Waiting for you to link…</div>';
      Focus.set(U.qs('.m-close', m));
      stopQrPolling();
      qrTimer = setInterval(function () {
        if (layer.className.indexOf('hidden') !== -1) { stopQrPolling(); return; }
        API.readLinkCode(link.code, function (res) {
          var key = res.authKey || (res.auth && res.auth.key);
          if (!key) return;
          stopQrPolling();
          function finish(session) {
            API.setAuth({ authKey: (session && session.authKey) || key, user: (session && session.user) || null });
            updateProfile();
            layer.className = 'layer hidden';
            Focus.setRoot(U.qs('#app')); Focus.first();
            toast('Signed in successfully');
            syncAddons();
          }
          API.loginWithToken(key, finish, function () { finish(null); });
        }, function () { /* not linked yet */ });
      }, 2500);
    }, function (e) {
      var body = U.qs('#qr-body', m);
      if (body && layer.className.indexOf('hidden') === -1)
        body.innerHTML = '<div class="empty">Could not start sign in: ' + U.esc(e) + '</div>';
    });
  }

  function credentials(mode) {
    textInput('Email address', '', function (email) {
      if (!email || email.indexOf('@') < 1) { toast('Invalid email'); return; }
      textInput('Password', '', function (password) {
        if (!password) { toast('Password required'); return; }
        toast('Signing in…');
        var done = function (d) {
          if (!d || !d.authKey) { toast('Sign in failed'); return; }
          API.setAuth({ authKey: d.authKey, user: d.user || null });
          updateProfile();
          toast('Signed in as ' + (d.user && d.user.email ? d.user.email : 'Stremio User'));
          syncAddons();
        };
        var fail = function (e) { toast('Sign in failed: ' + e); };
        if (mode === 'register') API.register(email, password, done, fail);
        else API.login(email, password, done, fail);
      }, true);
    });
  }

  var lastSyncError = '';
  function syncAddons() {
    var a = API.auth();
    if (!a || !a.authKey) { toast('Sign in first'); return; }
    toast('Syncing account…');
    lastSyncError = '';
    var addonCount = -1, libCount = -1, finished = false;
    function done() {
      if (finished) return;
      // Wait for both requests before showing the final result.
      if (addonCount < 0 || libCount < 0) return;
      finished = true;
      var msg = addonCount + ' addons, ' + libCount + ' library items synced';
      if (lastSyncError) msg += ' (' + lastSyncError + ')';
      toast(msg);
      if (current && (current.name === 'library' || current.name === 'board')) navigate(current.name, {}, true);
    }
    // Run both independently: a failed addon sync must never block the library.
    API.userAddons(a.authKey, function (list) {
      addonCount = list.length;
      if (list.length) API.saveAddons(list);
      done();
    }, function (e) { addonCount = 0; lastSyncError = 'addons: ' + e; done(); });
    API.syncLibrary(a.authKey, function (items) {
      libCount = items.length;
      done();
    }, function (e) { libCount = 0; lastSyncError = 'library: ' + e; done(); });
  }
  function syncLibrary() { syncAddons(); }

  function installAddon(after) {
    textInput('Install addon — manifest URL', 'https://', function (url) {
      if (!url || url.indexOf('http') !== 0) { toast('Invalid URL'); return; }
      toast('Fetching manifest…');
      API.fetchManifest(url, function (err, addon) {
        if (err) { toast('Could not load manifest'); return; }
        var adds = API.addons();
        for (var i = 0; i < adds.length; i++) if (adds[i].id === addon.id) adds.splice(i, 1);
        adds.push(addon); API.saveAddons(adds);
        toast(addon.name + ' installed');
        if (after) after();
      });
    });
  }

  /* ---------------- subtitles ---------------- */
  var lastSubtitleCss = '', lastSubtitleHtml = '', lastTimeText = '';
  function currentColor() { return U.get('subColor', '#FFFFFF'); }
  function colorName() {
    var c = String(currentColor()).toLowerCase();
    for (var i = 0; i < SUB_COLORS.length; i++) {
      if (String(SUB_COLORS[i].value).toLowerCase() === c) return SUB_COLORS[i].name;
    }
    return 'Custom';
  }
  function applySubtitleSettings() {
    var color = currentColor();
    var sizes = { '75%': 32, '100%': 46, '125%': 58, '150%': 70 };
    var px = (sizes[U.get('subSize', '100%')] || 46) + 'px';
    var css = '.subtitle{color:' + color + '!important;font-size:' + px + '!important}';
    // The inline style must be re-applied to a freshly rebuilt #subtitle even
    // when the document rule is unchanged.
    var el = U.qs('#subtitle');
    if (el && (el.style.color !== color || el.style.fontSize !== px)) {
      el.style.color = color; el.style.fontSize = px;
    }
    // Rewriting a <style> every timeupdate forced a full style recalculation
    // and eventually made the UI stop answering the remote. Write only on change.
    if (css === lastSubtitleCss) return;
    lastSubtitleCss = css;
    var st = document.getElementById('subtitle-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'subtitle-style';
      (document.head || document.documentElement).appendChild(st);
    }
    st.innerHTML = css;
  }
  function parseTime(s) {
    var p = String(s).replace(',', '.').split(':');
    var sec = parseFloat(p[p.length - 1]) || 0;
    if (p.length > 1) sec += (parseInt(p[p.length - 2], 10) || 0) * 60;
    if (p.length > 2) sec += (parseInt(p[p.length - 3], 10) || 0) * 3600;
    return sec;
  }
  function parseSubs(text) {
    var cues = [], blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n'), ti = -1;
      for (var j = 0; j < lines.length; j++) if (lines[j].indexOf('-->') >= 0) { ti = j; break; }
      if (ti < 0) continue;
      var m = lines[ti].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
      if (!m) continue;
      var out = [];
      for (var k = ti + 1; k < lines.length; k++) if (lines[k].replace(/^\s+|\s+$/g, '')) out.push(U.esc(lines[k]));
      if (!out.length) continue;
      cues.push({ start: parseTime(m[1]), end: parseTime(m[2]), lines: out });
    }
    return cues;
  }
  // Subtitle sync: a positive offset delays the subtitles (they appear later).
  // Saved per video so the same release stays in sync on every play.
  function subSyncLabel(v) {
    var n = Number(v) || 0;
    return (n > 0 ? '+' : '') + (Math.round(n * 10) / 10) + ' s';
  }
  function clampOffset(v) { return Math.max(-600, Math.min(600, Math.round((Number(v) || 0) * 10) / 10)); }
  function saveSubOffset() {
    if (subSyncKey) U.set('subSync:' + subSyncKey, subOffset);
  }
  function setSubOffset(v, save) {
    subOffset = clampOffset(v);
    if (save) saveSubOffset();
    updateSubtitle();
  }
  function adjustSubOffset(d) {
    setSubOffset(subOffset + d, true);
    toast('Subtitle sync: ' + subSyncLabel(subOffset));
  }
  // Start here: the current playback time is where the first subtitle words
  // must be heard. Align the nearest cue start to that point.
  function startSubtitleHere() {
    if (!player || !subCues.length) { toast('No subtitle loaded'); return; }
    var t = player.currentTime || 0, best = null, bestDist = Infinity, i, d;
    for (i = 0; i < subCues.length; i++) {
      d = Math.abs(subCues[i].start - t);
      if (d < bestDist) { bestDist = d; best = subCues[i]; }
    }
    if (!best) { toast('No subtitle cue'); return; }
    setSubOffset(t - best.start, true);
    toast('Subtitle start set at ' + U.fmtTime(t));
  }
  function loadSavedSubOffset(key) {
    subSyncKey = key || '';
    subAutoSync = U.get('subAutoSync', true) !== false;
    var v = subAutoSync && subSyncKey ? U.get('subSync:' + subSyncKey, 0) : 0;
    subOffset = clampOffset(v);
  }
  function loadSubtitles(url) {
    subUrl = url || '';
    subCues = []; lastSubtitleHtml = ''; updateSubtitle();
    API.getText(url, function (txt) {
      subCues = parseSubs(txt);
      updateSubtitle();
    }, function () { toast('Could not load subtitles'); });
  }
  function updateSubtitle() {
    var el = U.qs('#subtitle');
    if (!el) return;
    if (!subOn || !subCues.length || !player) { el.innerHTML = ''; return; }
    // A +2 s offset means the SRT is 2 s early: match it against t-2.
    var now = player.currentTime || 0, t = now - subOffset, found = null;
    for (var i = 0; i < subCues.length; i++) {
      if (t >= subCues[i].start && t <= subCues[i].end) { found = subCues[i]; break; }
    }
    var html = found ? found.lines.join('<br/>') : '';
    if (html !== lastSubtitleHtml) { lastSubtitleHtml = html; el.innerHTML = html; }
    // applySubtitleSettings() is called when the setting changes and when the
    // player is rebuilt. Never rewrite the document <style> on every frame.
  }

  /* ---------------- player ---------------- */
  var player = null, currentStream = null, osdTimer = null, osdVisible = true;
  var playerData = null, seekEl = null, fillEl = null, playing = false;
  var seekKeyupHandler = null, clearSeekTimer = null;
  // Hardware keys are routed through these hooks so they always act on the
  // current player, even while the on-screen controller is hidden.
  var playerToggle = null, playerJump = null, playerStop = null, playerInfo = null;
  var playerMute = null, playerVolume = null, playerStep = null, playerOk = null;
  var playerMenuReturnFocus = null;
  var playerMenuStack = [], playerMenuFocusStack = [];
  var playerMenuTitle = '', playerMenuRows = null, playerMenuFocus = 0, playerMenuRenderId = 0;
  var playerReturnFocus = null, lastLayerClose = 0;
  var subCues = [], subTracks = [], subOn = true, subUrl = '';
  var subOffset = 0, subSyncKey = '', subAutoSync = true;   // subtitle sync, seconds added to cue times
  var saveProgressNow = null;   // set by playUrl; called on exit to store the final position
  var nextEpisodeHooks = null;  // set by playUrl: pre-load of the next episode
  var cancelNextAutoplay = null; // set by playUrl; stops the Up-next countdown on exit
  var qrTimer = null, statsTimer = null, stallTimer = null, statsSlow = false;
  var focusReclaimTimer = null;
  // Module-level so the global key handler can log errors even when the player
  // closure is not in scope. playUrl() replaces this with its logger on start.
  var remoteLog = function () {};
  // All remote keys arrive on document. A native plugin (AVPlay object or the
  // NaCl embed) can silently take native focus; the picture keeps moving but
  // no key event ever reaches us. Pull focus back to a hidden HTML sink.
  function reclaimRemoteFocus(force) {
    var pl = U.qs('#player-layer');
    if (!pl || pl.className.indexOf('hidden') !== -1) return;
    var pm = U.qs('#pmenu', pl);
    if (pm && pm.className.indexOf('open') !== -1) return;
    var active = document.activeElement;
    var stolen = !!active && (active.tagName === 'OBJECT' || active.tagName === 'EMBED' ||
      active.id === 'stremio-engine' || active.id === 'video');
    if (!force && !stolen) return;
    var sink = U.qs('#remote-focus', pl);
    if (sink && sink.focus) { try { sink.focus(); } catch (e) {} }
    var pp = U.qs('#pp', pl);
    if (pp) Focus.set(pp);
    remoteLog('focus-reclaim', { tag: active ? active.tagName : '', id: active ? active.id : '' });
  }
  function stopQrPolling() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }
  function stopStatsPolling() { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } statsSlow = false; }
  function stopStallWatch() { if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } }

  var SUB_COLORS = [
    { name: 'White', value: '#FFFFFF' },
    { name: 'Red', value: '#FF3B30' },
    { name: 'Lime', value: '#4CD866' },
    { name: 'Yellow', value: '#F6C700' },
    { name: 'Blue', value: '#007AFF' },
    { name: 'Light Blue', value: '#5AC8FA' },
    { name: 'Pink', value: '#FF2D55' },
    { name: 'Orange', value: '#FF9500' },
    { name: 'Purple', value: '#7B5BF5' },
    { name: 'Cyan', value: '#00E5FF' }
  ];

  // Releases the TV's browser <video> can't decode: it parses them and keeps
  // reading but never starts (no error), e.g. "1080p AMZN WEB-DL x265 .mkv"
  // (HEVC + E-AC3). Those go straight to Samsung's native AVPlay.
  function prefersAvPlay(s) {
    var bh = (s && s.behaviorHints) || {};
    var label = [bh.filename || '', s.title || '', s.name || '', s.description || ''].join(' ');
    return /\.mkv\b|\bmkv\b|x\.?265|\bhevc\b|h\.?265|10.?bit|\bddp|e-?ac-?3|\batmos\b|\bdts\b|truehd|\bac-?3\b|\bav1\b|\bdolby ?vision\b|\bhdr10/i.test(label);
  }

  // Previous / next released episode, in season+episode order.
  function episodeNeighbors(meta, vid) {
    var vids = ((meta && meta.videos) || []).slice(0);
    if (!vids.length || !vid) return { prevId: '', nextId: '' };
    vids.sort(function (a, b) {
      var sa = Number(a.season) || 0, sb = Number(b.season) || 0;
      if (sa !== sb) return sa - sb;
      return (Number(a.episode) || 0) - (Number(b.episode) || 0);
    });
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].id !== vid) continue;
      return { prevId: i > 0 ? vids[i - 1].id : '',
        nextId: vids[i + 1] ? vids[i + 1].id : '' };
    }
    return { prevId: '', nextId: '' };
  }
  // Label + still for the "Up next" card. Uses the same episode list as the
  // next-episode button, so no extra metadata request is needed.
  function nextEpisodeInfo(meta, nextId) {
    var vids = ((meta && meta.videos) || []).slice(0);
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].id !== nextId) continue;
      var n = vids[i], se = Number(n.season) || 0, ep = Number(n.episode) || 0;
      return { title: 'S' + se + ' E' + ep + (n.title ? '  •  ' + n.title : ''),
        thumb: n.thumbnail || n.poster || '' };
    }
    return { title: 'Next episode', thumb: '' };
  }

  function playStream(s, meta, info) {
    currentStream = s; playerData = meta || {};
    API.markStreamWatched(s);   // show a "Viewed" indicator next time
    // Remember the exact source so Continue Watching resumes the same torrent.
    API.rememberStream([(info && info.videoId) || (meta && meta.id) || '',
      (info && info.progressId) || '', API.infoHash(s)], s);
    // Torrents are played by the on-device NaCl engine (127.0.0.1:11470).
    // It needs the raw info hash to fetch metadata over ut_metadata.
    var hash = API.infoHash(s);
    var fidx = API.fileIdx(s);
    if (hash && window.Engine) {
      // Peer sources like Android TV: the addon's stream.sources, plus any
      // tr= trackers in the magnet link.
      var sources = (s.sources && s.sources.slice) ? s.sources.slice() : [];
      if (s.magnet) {
        var tre = /[?&]tr=([^&]+)/g, tm;
        while ((tm = tre.exec(s.magnet))) {
          try { sources.push('tracker:' + decodeURIComponent(tm[1])); } catch (e) {}
        }
      }
      var fname = (s.behaviorHints && s.behaviorHints.filename) || '';
      window.Engine.start(hash, fidx, sources, fname);
    }
    var url = API.streamUrl(s);
    if (!url) { toast('This source has no playable link'); return; }
    info = info || {};
    var parsed = API.parseStream(s);
    var nav = episodeNeighbors(meta, info.videoId);
    var nextId = info.nextId || nav.nextId;
    var nxi = nextEpisodeInfo(meta, nextId);
    playUrl(url, info.title || parsed.title || s.name, {
      poster: meta && meta.poster, type: 'stream', subtitles: s.subtitles,
      quality: info.quality || parsed.quality, seeders: info.seeders,
      infoHash: hash, fileIdx: fidx,
      prevId: info.prevId || nav.prevId, nextId: nextId,
      nextTitle: info.nextTitle || nxi.title, nextThumb: info.nextThumb || nxi.thumb,
      preferAv: prefersAvPlay(s),
      id: info.progressId, videoId: info.videoId, resumePos: info.resumePos,
      mediaType: info.mediaType, mediaId: info.videoId || (meta && meta.id),
      subLang: U.get('subLang', 'en'),
      logo: (meta && (meta.logo || meta.background || meta.poster)) || ''
    });
  }
  function copy(text) { toast('Magnet copied (storage)'); try { localStorage.setItem('stremio_tv_last_magnet', text); } catch (e) {} }

  function fmtRate(b) {
    b = Number(b) || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB/s';
    if (b >= 1024) return Math.round(b / 1024) + ' KB/s';
    return Math.round(b) + ' B/s';
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }
  // First-load only: the logo fills from left to right as the torrent buffers.
  // Stats from the LAN bridge sit below it; no title, status text or bar.
  function torrentLoaderHtml(opts) {
    var logo = opts.logo ? '<div class="tl-logo-base" style="background-image:url(\'' + U.attr(opts.logo) + '\')"></div>' +
      '<div class="tl-logo-mask" id="tl-logo-mask"><div class="tl-logo-color" style="background-image:url(\'' + U.attr(opts.logo) + '\')"></div></div>' : '';
    var seeds = (opts.seeders === null || opts.seeders === undefined) ? '\u2014' : U.esc(opts.seeders);
    return '<div class="torrent-loader" id="torrent-loader">' +
      '<div class="tl-logo">' + logo + '</div>' +
      '<div class="tl-stats">' +
      '<div class="tl-stat"><span>Seeders</span><b class="purple" id="tl-seeders">' + seeds + '</b></div>' +
      '<div class="tl-stat"><span>Download speed</span><b id="tl-speed">0 KB/s</b></div>' +
      '<div class="tl-stat"><span>Downloaded</span><b id="tl-down">0 KB</b></div>' +
      '<div class="tl-stat"><span>Peers</span><b id="tl-peers">0</b></div>' +
      '</div>' +
      '<div class="tl-diag" id="tl-diag">engine: waiting</div>' +
      '</div>';
  }

  // Say WHY a stream failed, instead of the old catch-all "check the bridge".
  function playErrorText(err, st, triedAvPlay) {
    var code = err && err.code;
    if (st) {
      if (!st.ready && !(st.peers > 0)) return 'Cannot play: no peers found for this torrent - try another source';
      if (!st.ready) return 'Cannot play: torrent info not received from peers - try another source';
      if (st.httpLastCode === 503) return 'Cannot play: peers stopped sending data - try another source';
    }
    if (triedAvPlay) return 'Cannot play: the TV cannot decode this file (' + ((err && err.message) || 'AVPlay') + ')';
    if (code === 3 || code === 4) return 'Cannot play: the TV cannot decode this file format';
    if (code === 2) return 'Cannot play: connection to the on-TV engine was lost - try again';
    return 'Cannot play this source - try another one';
  }

  function playUrl(url, title, opts) {
    opts = opts || {};
    // The "Up next" card, its countdown and the auto-play all use the same
    // Settings value: N minutes before the end the card appears, counts down
    // over that window, then plays the next episode unless the player is exited.
    var nextCountdownSec = (Number(U.get('nextEpMin', 2)) || 2) * 60;
    var preSec = (Number(U.get('prefetchMin', 5)) || 5) * 60;
    var nextAutoCancelled = false, nextAutoFired = false;
    var lastNextKicker = '', lastNextWidth = '';
    function writeNextKicker(s, w) {
      if (s !== lastNextKicker) {
        var k = U.qs('#next-ep-kicker', layer);
        lastNextKicker = s;
        if (k) k.innerHTML = s;
      }
      if (w !== lastNextWidth) {
        var p = U.qs('#next-ep-progress', layer);
        lastNextWidth = w;
        if (p) p.style.width = w;
      }
    }
    function cancelNextAuto() {
      nextAutoCancelled = true;
      writeNextKicker('UP NEXT', '0%');
    }
    cancelNextAutoplay = cancelNextAuto;
    function resetNextCountdown() {
      writeNextKicker('UP NEXT IN ' + U.fmtTime(nextCountdownSec), '0%');
    }
    function updateNextCountdown(remain) {
      if (!opts.nextId || nextAutoCancelled || nextAutoFired) return;
      var left = Math.max(0, remain);
      writeNextKicker('UP NEXT IN ' + U.fmtTime(Math.ceil(left)),
        Math.max(0, Math.min(100, (nextCountdownSec - left) / nextCountdownSec * 100)) + '%');
      if (left <= 0.5) { nextAutoFired = true; playNextNow(); }
    }
    // Remember the menu control that launched playback so Back lands on it.
    playerReturnFocus = Focus.get();
    // Gray subtitle under the title: quality + seeders for torrent streams.
    var osdSub = '';
    if (opts.quality) osdSub += U.esc(opts.quality);
    if (opts.seeders !== null && opts.seeders !== undefined)
      osdSub += (osdSub ? '  •  ' : '') + '\uD83D\uDC64 ' + U.esc(opts.seeders) + ' seeders';
    // Live download speed from the LAN bridge, right next to the seeders.
    if (opts.infoHash) osdSub += (osdSub ? '  •  ' : '') + '\u2193 <span id="osd-speed">0 KB/s</span>';
    if (!osdSub) osdSub = U.esc(opts.type || '');
    var layer = U.qs('#player-layer');
    layer.className = 'layer'; clearLayer(layer);
    layer.innerHTML = '<div id="video-wrap" style="position:absolute;left:0;top:0;width:1920px;height:1080px;background:#000">' +
      '<video id="video" style="width:1920px;height:1080px;object-fit:contain"' + (opts.infoHash ? '' : (' src="' + U.attr(url) + '" autoplay')) + '></video></div>' +
      (opts.infoHash ? torrentLoaderHtml(opts) : '') +
      '<div class="loading" id="load"></div><div class="load-pct" id="load-pct"></div>' +
      '<div class="player-osd" id="osd">' +
      '<div class="osd-top"><div class="osd-title">' + U.esc(title || 'Playing') + '</div><div class="osd-sub">' + osdSub + '</div></div>' +
      '<div class="osd-bottom"><div class="seekbar" id="seek" data-focus="1"><div class="fill" id="fill"></div><div class="knob" id="knob"></div></div>' +
      '<div class="player-controls">' +
      '<span class="pbtn playpause" data-focus="1" data-icon="pause" id="pp"><i style="background-image:' + U.icon('pause') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="chevrons_back" id="prev-ep"><i style="background-image:' + U.icon('chevrons_back') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="chevrons_forward" id="next-ep-btn"><i style="background-image:' + U.icon('chevrons_forward') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="chevron_back" id="back10"><i style="background-image:' + U.icon('chevron_back') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="chevron_forward" id="fwd10"><i style="background-image:' + U.icon('chevron_forward') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="subtitles" id="subtitles"><i style="background-image:' + U.icon('subtitles') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="audio_tracks" id="audio"><i style="background-image:' + U.icon('audio_tracks') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="audio" id="mute"><i style="background-image:' + U.icon('audio') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="speed" id="speed"><i style="background-image:' + U.icon('speed') + '"></i></span>' +
      '<span class="time" id="time">0:00 / 0:00</span>' +
      '</div></div></div>' +
      '<div id="remote-focus" tabindex="-1" style="position:absolute;left:-100px;top:-100px;width:1px;height:1px;outline:none"></div>' +
      '<div class="subtitle" id="subtitle"></div>' +
      '<div class="player-menu" id="pmenu"></div>' +
      '<div class="next-episode" id="next-ep">' +
      '<div class="ne-card">' +
      '<div class="ne-thumb" id="next-ep-thumb"></div>' +
      '<div class="ne-info"><div class="ne-kicker" id="next-ep-kicker">UP NEXT</div>' +
      '<div class="ne-title" id="next-ep-title">' + U.esc(opts.nextTitle || 'Next episode') + '</div>' +
      '<div class="ne-progress" id="next-ep-progress"></div></div>' +
      '<div class="ne-action" id="next-ep-action" data-focus="1">▶ Next Episode</div>' +
      '</div></div>';
    Focus.setRoot(layer);
    var nextThumb = U.qs('#next-ep-thumb', layer);
    if (nextThumb && opts.nextThumb) nextThumb.style.backgroundImage = 'url("' + U.attr(opts.nextThumb) + '")';
    subCues = []; subOn = true; subUrl = ''; lastSubtitleHtml = ''; lastTimeText = '';
    subTracks = opts.subtitles || [];
    loadSavedSubOffset(opts.videoId || opts.mediaId || (title ? 'title:' + title : ''));
    applySubtitleSettings();
    // Episode skip buttons are only meaningful for series episodes.
    if (!opts.prevId) { var pbtn = U.qs('#prev-ep', layer); if (pbtn) pbtn.style.display = 'none'; }
    if (!opts.nextId) {
      var nbtn = U.qs('#next-ep-btn', layer); if (nbtn) nbtn.style.display = 'none';
      var nep = U.qs('#next-ep', layer); if (nep) nep.style.display = 'none';
    }
    // Subtitles come from the installed subtitle addons, in the language
    // selected in Settings. Stream-attached tracks remain as a fallback.
    if (opts.mediaId) {
      API.getSubtitles(opts.mediaType || 'movie', opts.mediaId, opts.subLang || 'en', function (tracks) {
        if (layer.className.indexOf('hidden') !== -1) return;   // player already closed
        subTracks = (tracks || []).concat(opts.subtitles || []);
        if (tracks && tracks.length) loadSubtitles(tracks[0].url);
        else if (subTracks.length && subTracks[0].url) loadSubtitles(subTracks[0].url);
      });
    } else if (subTracks.length && subTracks[0].url) loadSubtitles(subTracks[0].url);
    player = U.qs('#video', layer);
    // Record every listener attached below, so they can be moved onto the
    // AVPlay player if the browser <video> cannot decode this stream.
    var playerListeners = [], usingAvPlay = false, lastStats = null, htmlVideo = player, srcSetAt = 0;
    function clampRate(r) { r = Number(r) || 1; return r < 0.25 ? 0.25 : (r > 2 ? 2 : r); }
    var playbackRate = clampRate(U.get('playbackRate', 1));
    var currentVolume = 1, currentMuted = false;
    try { player.playbackRate = playbackRate; } catch (e) {}
    (function (v) {
      var add = v.addEventListener;
      v.addEventListener = function (type, fn, cap) {
        playerListeners.push([type, fn]);
        return add.call(v, type, fn, cap);
      };
    })(player);
    function canAvPlay() {
      var ok = !usingAvPlay && !!url && !!window.AvPlayer && AvPlayer.available();
      remoteLog('avcheck', { ok: ok, prefer: !!opts.preferAv,
        diag: window.AvPlayer && AvPlayer.diag ? AvPlayer.diag() : null, url: url });
      return ok;
    }
    // Move playback (and every listener) from the browser <video> to AVPlay.
    function switchToAvPlay() {
      if (!canAvPlay() || !player) return false;
      remoteLog('avswitch', { step: 'start', url: url });
      usingAvPlay = true;
      try { htmlVideo.pause(); htmlVideo.removeAttribute('src'); htmlVideo.load(); } catch (e) {}
      var av = new AvPlayer(U.qs('#video-wrap', layer));
      for (var li = 0; li < playerListeners.length; li++)
        av.addEventListener(playerListeners[li][0], playerListeners[li][1]);
      if (htmlVideo.parentNode) htmlVideo.parentNode.removeChild(htmlVideo);
      player = av;
      try { av.playbackRate = playbackRate; av.volume = currentVolume; av.muted = currentMuted; } catch (e) {}
      document.documentElement.className += ' avplay-active';
      document.body.className += ' avplay-active';
      av.src = url; av.load(); av.play();
      // Keep the HTML controller in charge of the remote after the plugin is
      // inserted; otherwise AVPlay can swallow arrow keys and look frozen.
      reclaimRemoteFocus(true);
      showOsd(true);
      remoteLog('avswitch', { step: 'loaded' });
      return true;
    }
    seekEl = U.qs('#seek', layer); fillEl = U.qs('#fill', layer);
    // Seeking is deferred: holding Left/Right only moves the seek cursor, and
    // the actual seek happens one second after the key is released. Repeated
    // keydowns used to fire a seek each time, which starved the torrent stream.
    var scrubbing = false, seekTarget = 0, scrubDir = 0, scrubHoldAt = 0, scrubTimer = null;
    var wasPlayingBeforeScrub = false, lastScrubKeyAt = 0, seekHideTimer = null;
    function paintSeek(t) {
      var d = player && player.duration, known = d && isFinite(d) && d > 0;
      var pct = known ? Math.max(0, Math.min(100, t / d * 100)) : 0;
      fillEl.style.width = pct + '%';
      U.qs('#knob', layer).style.left = pct + '%';
      U.qs('#time', layer).innerHTML = U.fmtTime(t) + ' / ' + (known ? U.fmtTime(d) : '--:--');
    }
    function commitSeek() {
      if (!scrubbing) return;
      scrubbing = false; scrubDir = 0;
      if (scrubTimer) { clearInterval(scrubTimer); scrubTimer = null; }
      seekEl.className = seekEl.className.replace(/\s*scrubbing/g, '');
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      // Seek commits immediately; no round overlay over a playing picture.
      seekPending = true; seekFrom = -1;
      hideLoadSpinner();
      try { player.currentTime = seekTarget; } catch (e) {}
      // Resume immediately at the released position: the old 1 s delay made
      // the picture look frozen after a long scrub.
      if (wasPlayingBeforeScrub) { try { player.play(); } catch (e) {} }
      remoteLog('seek', { target: seekTarget, duration: player.duration, at: player.currentTime });
      showOsd();
    }
    clearSeekTimer = function () {
      if (scrubTimer) { clearInterval(scrubTimer); scrubTimer = null; }
      if (seekHideTimer) { clearTimeout(seekHideTimer); seekHideTimer = null; }
      scrubbing = false; scrubDir = 0;
      seekEl.className = seekEl.className.replace(/\s*scrubbing/g, '');
    };
    var load = U.qs('#load', layer);
    var loader = U.qs('#torrent-loader', layer);
    // The small circular spinner belongs to the FIRST load only. Torrents use
    // the full-screen logo loader; after playback starts, nothing circular is
    // ever painted over the picture (seek, stall, next episode, etc.).
    function hideLoadSpinner() { load.className = 'loading'; }

    // One entry point for the hardware Play/Pause key and the on-screen button.
    // Never leave a half-finished scrub behind when toggling playback.
    function togglePlayback() {
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      if (scrubbing) commitSeek();
      var wasPaused = !!player.paused;
      if (wasPaused) { try { player.play(); } catch (e) {} setPpIcon('pause'); }
      else { try { player.pause(); } catch (e) {} setPpIcon('play'); }
      remoteLog('toggle', { from: wasPaused ? 'paused' : 'playing', av: !!usingAvPlay });
      showOsd();
    }
    // Left/Right with the controller hidden: real -10/+10 s jump, not just a
    // cursor move. Resume so the picture never looks frozen after the seek.
    function jumpBy(sec) {
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      if (scrubbing) commitSeek();
      var d = player.duration, t = (player.currentTime || 0) + sec;
      if (t < 0) t = 0;
      if (d && isFinite(d) && d > 0 && t > d) t = d;
      seekPending = true; seekFrom = -1;
      hideLoadSpinner();
      try { player.currentTime = t; } catch (e) {}
      if (player.paused) { try { player.play(); } catch (e) {} }
      setPpIcon('pause');
      remoteLog('jump', { sec: sec, target: t, paused: player.paused });
      showOsd();
    }
    // ---- YouTube-TV style extras -----------------------------------------
    function rateLabel(r) { return r === 1 ? 'Normal' : (Math.round(r * 100) / 100) + 'x'; }
    function setPlaybackRate(r) {
      playbackRate = clampRate(r);
      U.set('playbackRate', playbackRate);
      try { if (player) player.playbackRate = playbackRate; } catch (e) {}
      toast('Speed ' + rateLabel(playbackRate));
    }
    function openSpeedMenu() {
      var rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2], rows = [];
      for (var i = 0; i < rates.length; i++) {
        (function (r) {
          rows.push({ label: rateLabel(r), current: r === playbackRate,
            fn: function () { setPlaybackRate(r); openSpeedMenu(true); } });
        })(rates[i]);
      }
      playerMenu('Playback speed', rows);
    }
    function toggleMute() {
      if (!player) return;
      currentMuted = !currentMuted;
      try { player.muted = currentMuted; } catch (e) {}
      toast(currentMuted ? 'Muted' : 'Unmuted');
      showOsd();
    }
    function adjustVolume(d) {
      if (!player) return;
      if (currentMuted) { currentMuted = false; try { player.muted = false; } catch (e) {} }
      var v = typeof player.volume === 'number' ? player.volume : currentVolume;
      v = Math.max(0, Math.min(1, Math.round((v + d) * 100) / 100));
      currentVolume = v;
      try { player.volume = v; } catch (e) {}
      toast('Volume ' + Math.round(v * 100) + '%');
      showOsd();
    }
    function stepEpisode(dir) {
      var id = dir > 0 ? opts.nextId : opts.prevId;
      var b = U.qs(dir > 0 ? '#next-ep-btn' : '#prev-ep', layer);
      if (id && b && b.onclick && b.style.display !== 'none') b.onclick();
      else toast(dir > 0 ? 'No next episode' : 'No previous episode');
    }
    function toggleInfo() {
      var osd = U.qs('#osd', layer);
      if (!osd) return;
      if (osd.style.opacity === '0') showOsd();
      else hideOsd();
    }
    // OK/Enter with the controller hidden is handled in the capture phase so
    // it always toggles playback instead of clicking a hidden control.
    playerOk = function (k, ev) {
      if (k !== 13 || (ev && ev.repeat)) return false;
      var pm = U.qs('#pmenu', layer);
      if (pm && pm.className.indexOf('open') !== -1) return false;
      // While the Next Episode prompt is on screen, OK always plays it.
      var nbx = U.qs('#next-ep', layer);
      if (nbx && nbx.className.indexOf(' show') !== -1) {
        if (nbx.onclick) nbx.onclick(); else nbx.click();
        return true;
      }
      // Otherwise OK is Play/Pause when no specific control is being used:
      // either the controller is hidden or only the seek bar has focus.
      var osd = U.qs('#osd', layer);
      if (!osd || osd.style.opacity === '0' || Focus.get() === seekEl) {
        togglePlayback();
        return true;
      }
      return false;   // a focused control button handles its own OK
    };
    playerToggle = togglePlayback;
    playerJump = jumpBy;
    playerStop = function () { closeLayers(); };
    playerInfo = toggleInfo;
    playerMute = toggleMute;
    playerVolume = adjustVolume;
    playerStep = stepEpisode;
    if (loader) U.qs('#osd', layer).style.opacity = '0';   // no controls during first load
    var tlMask = loader ? U.qs('#tl-logo-mask', layer) : null;
    // Wait for a small head buffer before starting. The logo fills linearly
    // with these bytes, so every MB downloaded visibly advances it.
    var START_BYTES = 16 * 1048576;
    var tlPct = 0, firstPlay = true, videoStarted = !opts.infoHash;
    // Direct streams: small spinner only until the first frame. Torrents: the
    // logo loader is the only loading UI, so the spinner stays hidden.
    if (loader) hideLoadSpinner(); else load.className = 'loading show';

    function setLoaderPct(pct) {
      if (!loader) return;
      pct = Math.max(0, Math.min(100, pct));
      if (pct < tlPct) pct = tlPct;         // the logo only ever fills forward
      tlPct = pct;
      if (tlMask) tlMask.style.width = pct + '%';   // left → right fill
    }
    function bufferedPct() {
      try {
        if (player.buffered && player.buffered.length && player.duration && isFinite(player.duration))
          return player.buffered.end(player.buffered.length - 1) / player.duration * 100;
      } catch (e) {}
      return 0;
    }
    // TEMP: ship live engine diagnostics to the development PC so no one has
    // to read numbers off the TV screen.
    var remoteLogAt = 0, lastStatsLogAt = 0;
    function playLog(kind, extra, force) {
      try {
        var now = (Date.now ? Date.now() : (new Date()).getTime());
        if (!force && now - remoteLogAt < 900) return;
        remoteLogAt = now;
        var payload = { kind: kind, ts: now, hash: opts.infoHash || '' };
        for (var k in extra) if (extra.hasOwnProperty(k)) payload[k] = extra[k];
        var x = new XMLHttpRequest();
        x.open('POST', 'http://192.168.0.136:8877/log', true);
        x.setRequestHeader('Content-Type', 'application/json');
        // The dev PC may be offline. Never let failed log posts pile up: an
        // async XHR with no timeout can hang forever and starve the UI thread.
        x.timeout = 1200;
        var release = function () {
          x.onload = x.onerror = x.ontimeout = x.onabort = null;
          x = null;
        };
        x.onload = release; x.onerror = release; x.ontimeout = release; x.onabort = release;
        try { x.send(JSON.stringify(payload)); } catch (e) { release(); }
      } catch (e) {}
    }
    remoteLog = playLog;
    // Value-guarded DOM writes: the old TV's style/layout engine fell behind
    // when hidden diagnostic nodes were rewritten several times a second.
    function setHtml(el, s) { if (el && el.innerHTML !== s) el.innerHTML = s; }
    var statsInFlight = false;
    function pollStats() {
      if (statsInFlight || !loader || layer.className.indexOf('hidden') !== -1) return;
      statsInFlight = true;
      API.request(API.streamServer() + '/stats/' + opts.infoHash, function (d) {
        statsInFlight = false;
        if (!d || layer.className.indexOf('hidden') !== -1) return;
        lastStats = d;
        // Inside the round loader (seek / buffering): how much of the data
        // needed at the current spot has arrived.
        setHtml(U.qs('#load-pct', layer),
          Math.max(0, Math.min(100, Math.round(Number(d.bufPct) || 0))) + '%');
        var spd = fmtRate(d.downloadSpeed);
        setHtml(U.qs('#tl-speed', layer), spd);
        setHtml(U.qs('#osd-speed', layer), spd);   // top OSD, next to seeders
        setHtml(U.qs('#tl-down', layer), fmtBytes(d.downloaded));
        setHtml(U.qs('#tl-peers', layer), String(d.peers || 0));
        // Metadata just became ready: this is the first moment the engine's
        // HTTP server can actually serve byte ranges for this file. Setting
        // <video src> any earlier caused a storm of 404s that the player
        // gave up on long before data was available.
        var startTarget = (d.streamLen && isFinite(d.streamLen) && d.streamLen > 0) ?
          Math.min(START_BYTES, d.streamLen) : START_BYTES;
        // `downloaded` only jumps when a whole 16 MB piece verifies. blocksRx
        // counts 16 KB blocks as they arrive, so the logo moves every MB.
        var haveBytes = Math.max(d.downloaded || 0, Math.min((d.blocksRx || 0) * 16384, startTarget));
        if (!videoStarted && d.ready && haveBytes >= startTarget) {
          videoStarted = true;
          srcSetAt = Date.now();
          remoteLog('start', { bytes: haveBytes, target: startTarget, len: d.streamLen });
          if (!(opts.preferAv && switchToAvPlay())) {
            player.src = url;
            player.load();
            var playPromise = player.play();
            if (playPromise && playPromise.catch) playPromise.catch(function () {});
          }
        }
        // Safety net: <video> sometimes neither plays nor errors on a format it
        // can't decode (it just keeps reading). 30 s with data flowing and no
        // picture -> hand over to AVPlay.
        if (videoStarted && !usingAvPlay && firstPlay && srcSetAt && Date.now() - srcSetAt > 30000 &&
            (d.downloaded || 0) > 8 * 1048576) switchToAvPlay();
        // TEMP DIAGNOSTIC — shows where on-device discovery is failing.
        var dg = U.qs('#tl-diag', layer);
        var ei = (window.Engine && window.Engine.getInfo) ? window.Engine.getInfo() : {};
        setHtml(dg, 'st' + (d.stage || 0) + '/' + (d.attempts || 0) +
          ' ann' + (d.announceOk || 0) + '/' + (d.announceFail || 0) +
          ' c' + (d.connOk || 0) + '/' + (d.connFail || 0) + 'e' + (d.connErr || 0) +
          ' hs' + (d.hsOk || 0) + '/' + (d.hsFail || 0) + 'e' + (d.hsErr || 0) +
          ' rx' + (d.hsRx || 0) + '/z' + (d.hsZero || 0) +
          ' lan:' + (d.tcp80 == null ? '-' : d.tcp80) + '/' + (d.tcp80Err || 0) +
          ' pub:' + (d.tcpHi == null ? '-' : d.tcpHi) + '/' + (d.tcpHiErr || 0));
        // During startup log every stats tick. During steady playback only a
        // heartbeat every 5 s: fewer XHRs to the dev PC, no piled-up requests.
        var statsNow = Date.now();
        if (!playing || statsNow - lastStatsLogAt >= 5000) {
          lastStatsLogAt = statsNow;
          // Startup ticks are the "every Play" dump: never throttle them away.
          remoteLog('stats', { stats: d, engine: ei, diag: dg ? dg.innerHTML : '' }, !playing);
        }
        // Before playback, fill linearly toward the start-buffer target so
        // every megabyte visibly advances the logo. Once playing, fall back to
        // the real file ratio / browser buffer.
        if (!videoStarted) setLoaderPct(haveBytes >= startTarget ? 100 : haveBytes / startTarget * 100);
        else if (d.streamLen && d.downloaded) setLoaderPct(d.downloaded / d.streamLen * 100);
        else setLoaderPct(bufferedPct());
      }, function () {
        statsInFlight = false;
        var dg = U.qs('#tl-diag', layer);
        var ei = (window.Engine && window.Engine.getInfo) ? window.Engine.getInfo() : {};
        setHtml(dg, 'mod:' + (ei.embed ? 'y' : 'n') + ' mime:' + (ei.mime ? 'y' : 'n') +
          ' init:' + (ei.init || '-') + ' load:' + (ei.loaded ? 'y' : 'n') +
          ' io:' + (ei.stage || '-') + ' pong:' + (ei.pong ? 'y' : 'n') + ' msgs:' + (ei.msgs || 0) +
          ' started:' + (ei.engineStarted ? 'y' : 'n') +
          ' ev:' + (ei.events || []).join(',') +
          ' | NO LINK to 127.0.0.1:11470');
        remoteLog('nolink', { engine: ei, diag: dg ? dg.innerHTML : '' });
      }, 5000);
    }
    // Idle-freeze watchdog: after the OSD hides, some streams stop advancing
    // currentTime without raising an error. Nudge the same URL instead of
    // leaving a frozen picture until the user touches the remote.
    var lastProgressAt = Date.now(), lastProgressTime = 0;
    var stallKicks = 0, stallRecoveries = 0;
    function watchdog() {
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      if (!videoStarted || firstPlay || !playing || player.paused || scrubbing || seekPending) {
        lastProgressAt = Date.now(); lastProgressTime = player ? (player.currentTime || 0) : 0;
        return;
      }
      if (loader && loader.className.indexOf('hidden') === -1) return;
      var t = player.currentTime || 0;
      if (t > lastProgressTime + 0.2) {
        lastProgressTime = t; lastProgressAt = Date.now(); stallKicks = 0;
        return;
      }
      if (Date.now() - lastProgressAt < 8000) return;
      stallKicks++;
      remoteLog('stall-kick', { t: t, kick: stallKicks, recoveries: stallRecoveries, av: !!usingAvPlay });
      if (stallKicks >= 3 && stallRecoveries < 3) {
        // Repeated stalls: reload the same on-TV stream at the last position.
        stallRecoveries++; stallKicks = 0;
        opts.resumePos = t; resumeDone = false;
        try { player.src = url; player.load(); player.play(); } catch (e) {}
        setTimeout(function () { reclaimRemoteFocus(true); }, 0);
      } else if (stallKicks <= 2) {
        // First two stalls: a small backward seek re-kicks the decoder/pipeline.
        try { player.currentTime = Math.max(0, t - 2); player.play(); } catch (e) {}
      }
      lastProgressTime = Math.max(0, t - 2); lastProgressAt = Date.now();
    }
    if (!stallTimer) stallTimer = setInterval(watchdog, 2000);

    // Poll fast (4x/second) so the logo creeps forward as each chunk arrives.
    if (loader) { pollStats(); statsTimer = setInterval(pollStats, 250); }
    player.addEventListener('progress', function () {
      if (!statsTimer) setLoaderPct(bufferedPct());   // fallback when bridge is down
    });
    player.addEventListener('playing', function () {
      hideLoadSpinner();   // spinner is first-load only, never over the picture
      if (loader) {
        firstPlay = false;
        // Keep polling: the top-OSD download speed stays live during playback.
        setTimeout(function () {
          if (layer.className.indexOf('hidden') === -1) loader.className = 'torrent-loader hidden';
        }, 450);
      }
      playing = true;
      // The fast 250 ms poll is only needed while the logo loads. Once the
      // picture is up, 1 s is enough for the speed readout and avoids spawning
      // hundreds of engine HTTP threads per minute.
      if (!statsSlow && statsTimer) {
        clearInterval(statsTimer); statsTimer = setInterval(pollStats, 1000); statsSlow = true;
      }
      resetOsd();
    });
    player.addEventListener('waiting', function () {
      // Never bring the circular spinner back once the picture is up. The
      // first-load logo/direct spinner already covered the initial wait.
      hideLoadSpinner();
    });
    // Skipping forward jumps to a position the player has not fetched yet.
    // Show the spinner and keep it up until data at the new spot is ready.
    var seekPending = false, seekFrom = 0;
    function hideSeekLoad() {
      if (!seekPending) return;
      seekPending = false;
      hideLoadSpinner();
    }
    player.addEventListener('seeking', function () {
      if (firstPlay) return;
      seekPending = true; seekFrom = -1;
      hideLoadSpinner();
      // Keep the pending-seek guard until the new spot actually advances; no
      // visual spinner is painted over the movie while that happens.
      if (seekHideTimer) clearTimeout(seekHideTimer);
      seekHideTimer = setTimeout(function () { seekHideTimer = null; hideSeekLoad(); }, 45000);
    });
    player.addEventListener('seeked', function () {
      if (!seekPending) return;
      if (player.paused) hideSeekLoad();             // paused: nothing more to wait for
    });
    // Hide the seek loader only once the picture really moves on from the new spot.
    // (Players land on the nearest keyframe, so compare with the first position
    // reported after the jump, not with the requested target.)
    player.addEventListener('timeupdate', function () {
      if (!seekPending || !player) return;
      var t = player.currentTime || 0;
      if (seekFrom < 0 || t < seekFrom) seekFrom = t;   // lowest position since the jump
      else if (t - seekFrom >= 0.4) hideSeekLoad();
    });
    player.addEventListener('error', function () {
      // Ignore errors from a player that was closed or replaced (clearing
      // src on exit used to raise a bogus "cannot play" message).
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      if (this && this !== player) return;
      var err = player.error || {};
      remoteLog('playerror', { code: err.code || 0, message: err.message || '',
        usingAvPlay: usingAvPlay, preferAv: !!opts.preferAv,
        diag: window.AvPlayer && AvPlayer.diag ? AvPlayer.diag() : null,
        ready: lastStats && lastStats.ready, streamLen: lastStats && lastStats.streamLen });
      // The browser <video> could not decode this file: hand the same on-TV
      // URL to Samsung's native AVPlay pipeline (MKV, HEVC, AC3, ...).
      if (player === htmlVideo && switchToAvPlay()) return;
      load.className = 'loading';
      if (loader) { loader.className = 'torrent-loader hidden'; stopStatsPolling(); }
      toast(playErrorText(err, lastStats, usingAvPlay));
    });
    // A video that reaches the end is always watched, even when the final
    // timeupdate is skipped by the browser/AVPlay. If the Up-next countdown
    // somehow has not fired yet, play the next episode from here.
    player.addEventListener('ended', function () {
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      saveProgress();
      var watchedId = opts.videoId || opts.id;
      if (watchedId) API.markWatched(watchedId, true);
      remoteLog('ended', { id: opts.id, videoId: opts.videoId, nextId: opts.nextId });
      if (opts.nextId && !nextAutoFired && !nextAutoCancelled) updateNextCountdown(0);
    });
    player.addEventListener('timeupdate', function () {
      if (!player.duration) return;
      if (!scrubbing) {
        var pct = player.currentTime / player.duration * 100;
        fillEl.style.width = pct + '%';
        U.qs('#knob', layer).style.left = pct + '%';
        // One text node change per second, not per frame: repeated innerHTML
        // writes were enough to make the old TV's UI stop answering the remote.
        var txt = U.fmtTime(player.currentTime) + ' / ' + U.fmtTime(player.duration);
        if (txt !== lastTimeText) { lastTimeText = txt; U.qs('#time', layer).innerHTML = txt; }
      }
      updateSubtitle();
      // N minutes before the end: show the Up-next card (same setting that
      // drives the countdown), preload earlier if requested.
      var remain = player.duration - player.currentTime;
      var nb = U.qs('#next-ep', layer);
      if (nb) {
        if (opts.nextId && remain > 0 && remain <= preSec && nextEpisodeHooks)
          nextEpisodeHooks.preload();
        var na = U.qs('#next-ep-action', layer);
        var showNext = !!(opts.nextId && remain > 0 && remain <= nextCountdownSec);
        var cls = ' ' + nb.className + ' ';
        var wasFocused = Focus.get() === na || Focus.get() === nb;
        var wasShown = cls.indexOf(' show ') !== -1;
        if (!showNext && wasFocused) Focus.set(seekEl);
        if (showNext !== wasShown) nb.className = 'next-episode' + (showNext ? ' show' : '');
        if (!showNext && wasShown) resetNextCountdown();
        // Every appearance focuses the button, not the card, and hides the
        // video controls. All other Up/Down/OK behaviour stays the same.
        if (showNext && !wasShown) {
          resetNextCountdown();
          Focus.set(na);
          hideOsd();
          if (!nextShownLogged) {
            nextShownLogged = true;
            remoteLog('nextshow', { nextId: opts.nextId, remain: remain,
              countdownSec: nextCountdownSec });
          }
        }
        if (showNext) updateNextCountdown(remain);
        else if (opts.nextId && remain <= 0.5) updateNextCountdown(remain);
      }
      // Save every 10 s of movement. Never before the resume seek has happened
      // and never in the first 10 s: the old "every 5%" rule also fired at 0%,
      // overwriting the saved position as soon as playback started -- which
      // removed the title from Continue Watching.
      // If the resume seek can't happen (unknown duration), stop waiting after 30 s.
      if (!resumeDone && player.currentTime > 30) resumeDone = true;
      if (!scrubbing && resumeDone && Math.abs(player.currentTime - lastSavedPos) >= 10) saveProgress();
    });
    var resumeDone = !(opts.resumePos > 0), lastSavedPos = -100, libAdded = false, markedDone = false, nextShownLogged = false;
    function saveProgress() {
      if (!opts.id || !player) return;
      var d = player.duration, t = player.currentTime;
      if (!d || !isFinite(d) || !(t >= 10)) return;
      lastSavedPos = t;
      API.setProgress(opts.id, t / d * 100, d, t, opts.videoId);
      // Reached the end (credits may be skipped): mark this episode / movie
      // as watched automatically.
      if (!markedDone && API.finished({ pct: t / d * 100, dur: d, pos: t })) {
        markedDone = true;
        API.markWatched(opts.videoId || opts.id, true);
      }
      // Continue Watching lists library items: add what you watch as a "temp"
      // entry (like Stremio) so it appears there without cluttering My Library.
      if (!libAdded && !API.inLibrary(opts.id) && playerData) {
        API.addLibrary({ id: opts.id, type: opts.mediaType || playerData.type || 'movie',
          name: playerData.name || title || '', poster: playerData.poster || '',
          background: playerData.background || '', logo: playerData.logo || '',
          releaseInfo: playerData.releaseInfo || playerData.year || '',
          imdbRating: playerData.imdbRating || '', genres: playerData.genres || [],
          description: playerData.description || '', temp: true });
      }
      libAdded = true;
    }
    saveProgressNow = function () { if (resumeDone) saveProgress(); };
    // Resume exactly where the user left off (Continue Watching), once. The old
    // version re-seeked on every 'canplay' (i.e. after every buffering stall).
    function seekToResume() {
      if (resumeDone || !player) return;
      var d = player.duration;
      if (!d || !isFinite(d)) return;               // retried on the next event
      if (opts.resumePos < d - 2) {
        try { player.currentTime = opts.resumePos; } catch (e) { return; }
        lastSavedPos = opts.resumePos;
      }
      resumeDone = true;
    }
    player.addEventListener('loadedmetadata', seekToResume);
    player.addEventListener('durationchange', seekToResume);
    player.addEventListener('canplay', seekToResume);
    player.addEventListener('playing', seekToResume);
    // Last real position (or seek target), for recovering from a false "ended".
    var lastPos = 0, endRecoveries = 0, recoverAt = -1;
    player.addEventListener('timeupdate', function () {
      if (!player || scrubbing) return;
      var t = player.currentTime || 0;
      if (t > 0) lastPos = t;
      if (recoverAt >= 0 && t > recoverAt + 60) { endRecoveries = 0; recoverAt = -1; }   // playing fine again
    });
    player.addEventListener('seeking', function () { if (player && player.currentTime > 0) lastPos = player.currentTime; });
    player.addEventListener('ended', function () {
      var d = player && player.duration, t = Math.max(lastPos, (player && player.currentTime) || 0);
      // An "end" long before the real end is a dropped stream, typically right
      // after a seek while the torrent is still fetching that spot -- not the
      // end of the video. Show the loader and reload at that position.
      if (player && d && isFinite(d) && t < d - 30 && endRecoveries < 3) {
        endRecoveries++; recoverAt = t;
        hideLoadSpinner();
        remoteLog('premature-end', { t: t, d: d, attempt: endRecoveries });
        opts.resumePos = t; resumeDone = false;
        var wasPaused = player.paused;
        try { player.src = url; player.load(); if (!wasPaused) player.play(); } catch (e) {}
        setTimeout(function () { reclaimRemoteFocus(true); }, 0);
        return;
      }
      toast('Playback finished'); closeLayers();
    });

    U.qs('#pp', layer).onclick = togglePlayback;
    function setPpIcon(n) {
      var b = U.qs('#pp', layer);
      if (b) { b.setAttribute('data-icon', n); refreshTabIcons(); }
    }
    U.qs('#back10', layer).onclick = function () { player.currentTime = Math.max(0, player.currentTime - 10); };
    U.qs('#fwd10', layer).onclick = function () { player.currentTime = Math.min(player.duration || 0, player.currentTime + 10); };
    function reloadCaptionTracks(lang) {
      if (!opts.mediaId) return;
      API.getSubtitles(opts.mediaType || 'movie', opts.mediaId, lang, function (tracks) {
        if (layer.className.indexOf('hidden') !== -1) return;
        subTracks = (tracks || []).concat(opts.subtitles || []);
        if (tracks && tracks.length && tracks[0].url) loadSubtitles(tracks[0].url);
        else if (subTracks.length && subTracks[0].url) loadSubtitles(subTracks[0].url);
      });
    }
    function openCaptionLangMenu() {
      var langs = API.SUB_LANGS || [], cur = opts.subLang || U.get('subLang', 'en'), rows = [];
      for (var i = 0; i < langs.length; i++) {
        (function (L) {
          rows.push({ label: L.name + ' (' + L.code + ')', current: L.code === cur, fn: function () {
            U.set('subLang', L.code); opts.subLang = L.code;
            reloadCaptionTracks(L.code);
            toast('Caption language: ' + L.name);
            openSubtitleMenu(true, true);   // back to the parent menu
          } });
        })(langs[i]);
      }
      playerMenu('Caption language', rows);
    }
    function openSubtitleSyncMenu(replace) {
      var rows = [
        { label: 'Offset: \u22121 s',
          fn: function () { adjustSubOffset(-1); openSubtitleSyncMenu(true); } },
        { label: 'Offset: +1 s',
          fn: function () { adjustSubOffset(1); openSubtitleSyncMenu(true); } },
        { label: 'Start here', fn: function () { startSubtitleHere(); openSubtitleSyncMenu(true); } },
        { label: 'Reset subtitle sync', fn: function () {
            setSubOffset(0, true); toast('Subtitle sync reset'); openSubtitleSyncMenu(true);
          } }
      ];
      playerMenu('Subtitle sync', rows, replace);
    }
    function openCaptionSizeMenu() {
      var sizes = ['75%', '100%', '125%', '150%'], cur = U.get('subSize', '100%'), rows = [];
      for (var i = 0; i < sizes.length; i++) {
        (function (s) {
          rows.push({ label: s, current: s === cur, fn: function () {
            U.set('subSize', s); applySubtitleSettings();
            openCaptionsMenu(true, true);
          } });
        })(sizes[i]);
      }
      playerMenu('Caption size', rows);
    }
    function openCaptionColorMenu() {
      var cur = String(currentColor()).toLowerCase(), rows = [];
      for (var i = 0; i < SUB_COLORS.length; i++) {
        (function (c) {
          rows.push({ label: c.name, current: String(c.value).toLowerCase() === cur, color: c.value,
            fn: function () {
              U.set('subColor', c.value); applySubtitleSettings();
              toast('Caption text: ' + c.name);
              openCaptionsMenu(true, true);
            } });
        })(SUB_COLORS[i]);
      }
      playerMenu('Caption text', rows);
    }
    function openCaptionsMenu(replace, pop) {
      if (pop && playerMenuStack.length) playerMenuStack.pop();
      var rows = [
        { label: 'Caption size', sub: true, fn: openCaptionSizeMenu },
        { label: 'Caption text', sub: true, fn: openCaptionColorMenu }
      ];
      playerMenu('Captions', rows, replace);
    }
    function openSubtitleMenu(replace, pop) {
      if (pop && playerMenuStack.length) playerMenuStack.pop();
      var langName = API.subLangName(opts.subLang || U.get('subLang', 'en'));
      var rows = [
        { label: subOn ? 'Turn subtitles off' : 'Turn subtitles on',
          fn: function () { subOn = !subOn; updateSubtitle(); toast(subOn ? 'Subtitles on' : 'Subtitles off'); openSubtitleMenu(true); } },
        { label: 'Language: ' + langName, sub: true, fn: openCaptionLangMenu },
        { label: 'Sync', sub: true, fn: openSubtitleSyncMenu },
        { label: 'Captions', sub: true, fn: openCaptionsMenu }
      ];
      playerMenu('Subtitles', rows, replace);
    }
    U.qs('#subtitles', layer).onclick = function () { openSubtitleMenu(); };
    U.qs('#audio', layer).onclick = function () { playerMenu('Audio', [{ label: 'Default', fn: function () {} }]); };
    U.qs('#mute', layer).onclick = toggleMute;
    U.qs('#speed', layer).onclick = openSpeedMenu;
    function gotoEpisode(id, dir) {
      if (!id) return;
      remoteLog('episodenav', { dir: dir, id: id });
      stopPlayer();
      layer.className = 'layer hidden';
      openMeta(id, 'series', { fromContinue: true });
    }
    U.qs('#prev-ep', layer).onclick = function () { gotoEpisode(opts.prevId, 'prev'); };
    // Next episode, like Stremio's binge watching: its stream is picked in
    // advance (same torrent first, then the same bingeGroup, then the best
    // source). If it is in the same torrent (season pack), the engine starts
    // downloading it in the background "Pre-load next episode" minutes before
    // the end, so pressing Next Episode starts it at once.
    var nextStream = null, nextResolving = false, nextWaiters = [];
    function resolveNext(cb) {
      if (nextStream) { if (cb) cb(nextStream); return; }
      if (cb) nextWaiters.push(cb);
      if (nextResolving || !opts.nextId) return;
      nextResolving = true;
      API.getStreams('series', opts.nextId, function (list) {
        list = list || [];
        var cur = currentStream || {}, bg = cur.behaviorHints && cur.behaviorHints.bingeGroup, pick = null, i;
        for (i = 0; i < list.length && !pick; i++) if (opts.infoHash && API.infoHash(list[i]) === opts.infoHash) pick = list[i];
        for (i = 0; i < list.length && !pick && bg; i++) if (list[i].behaviorHints && list[i].behaviorHints.bingeGroup === bg) pick = list[i];
        for (i = 0; i < list.length && !pick; i++) if (API.streamUrl(list[i])) pick = list[i];
        nextStream = pick;
        var w = nextWaiters; nextWaiters = [];
        for (i = 0; i < w.length; i++) w[i](pick);
      });
    }
    var preloadAsked = false;
    function preloadNext() {
      if (preloadAsked || !opts.nextId) return;
      preloadAsked = true;
      resolveNext(function (s) {
        if (!s || !player || layer.className.indexOf('hidden') !== -1) return;
        var same = !!opts.infoHash && API.infoHash(s) === opts.infoHash;
        remoteLog('preload', { nextId: opts.nextId, sameTorrent: same, fileIdx: API.fileIdx(s) });
        if (same && window.Engine && Engine.prefetch) Engine.prefetch(API.fileIdx(s));
      });
    }
    nextEpisodeHooks = { preload: preloadNext };
    function playNextNow() {
      if (!opts.nextId) return;
      // Leaving this episode for the next one counts as watching it.
      nextAutoFired = true;
      var watchedId = opts.videoId || opts.id;
      if (watchedId) API.markWatched(watchedId, true);
      if (saveProgressNow) { try { saveProgressNow(); } catch (e) {} }
      // playStream() rebuilds the layer with its own first-load loader.
      hideLoadSpinner();
      resolveNext(function (s) {
        if (!s) { gotoEpisode(opts.nextId, 'next'); return; }    // no source: show the list
        var meta = playerData || {}, v = null, vs = meta.videos || [];
        for (var i = 0; i < vs.length; i++) if (vs[i].id === opts.nextId) v = vs[i];
        var title = (meta.name || '') + (v ? ' \u2014 S' + v.season + ' E' + v.episode + (v.title ? '  \u2022  ' + v.title : '') : '');
        remoteLog('episodenav', { dir: 'next-direct', id: opts.nextId, sameTorrent: API.infoHash(s) === opts.infoHash });
        var sameTorrent = !!opts.infoHash && API.infoHash(s) === opts.infoHash;
        stopPlayer(sameTorrent);
        playStream(s, meta, { title: title, videoId: opts.nextId, progressId: opts.id, mediaType: 'series' });
      });
    }
    U.qs('#next-ep-btn', layer).onclick = playNextNow;
    U.qs('#next-ep', layer).onclick = playNextNow;
    U.qs('#next-ep-action', layer).onclick = playNextNow;
    seekEl.onclick = function (ev) {
      Focus.set(seekEl);
      var d = player.duration;
      if (d && isFinite(d) && d > 0 && ev && typeof ev.offsetX === 'number') {
        var r = seekEl.getBoundingClientRect();
        var target = Math.max(0, Math.min(d, (ev.offsetX / (r.width || 1)) * d));
        try { player.currentTime = target; } catch (e) {}
        showOsd();
      }
    };
    seekEl.onfocusin = function () {};
    // Player key map:
    //   LEFT/RIGHT with controls hidden -> jump -10/+10 s and resume
    //   LEFT/RIGHT on a button -> walk the button row
    //   LEFT/RIGHT on the seek bar -> scrub; the longer you hold, the faster
    //   UP/DOWN -> cycle through all controls (incl. seek bar)
    //   OK      -> activate the focused control
    var btnOrder = ['pp', 'prev-ep', 'back10', 'fwd10', 'subtitles', 'audio', 'mute', 'speed', 'next-ep-btn'];
    var ctrlOrder = ['seek'].concat(btnOrder).concat(['next-ep-action']);
    function moveHorizontal(dir) {
      var f = Focus.get(), idx = -1, i;
      for (i = 0; i < btnOrder.length; i++) if (f && f.id === btnOrder[i]) idx = i;
      if (idx < 0) idx = dir > 0 ? -1 : 0;
      for (i = 0; i < btnOrder.length; i++) {
        idx = (idx + dir + btnOrder.length) % btnOrder.length;
        var el = U.qs('#' + btnOrder[idx], layer);
        if (el && el.offsetParent !== null) { Focus.set(el); return; }
      }
    }
    function scrubTick() {
      if (!scrubbing || !scrubDir) return;
      // If keyup is swallowed by the native plugin, do not spin forever.
      if (Date.now() - lastScrubKeyAt > 3000) { commitSeek(); return; }
      // 10 s per step at first, rising by 10 s every 250 ms while held.
      var held = Date.now() - scrubHoldAt;
      var step = 10 + Math.min(150, Math.floor(held / 250) * 10);
      seekTarget += scrubDir * step;
      var d = player && player.duration;
      if (seekTarget < 0) seekTarget = 0;
      if (d && isFinite(d) && d > 0 && seekTarget > d) seekTarget = d;
      paintSeek(seekTarget);
    }
    function startScrub(dir) {
      lastScrubKeyAt = Date.now();
      if (!scrubbing) {
        scrubbing = true;
        seekTarget = (player && player.currentTime) || 0;
        wasPlayingBeforeScrub = !!(player && !player.paused);
        scrubHoldAt = Date.now();
      }
      if (scrubDir !== dir) { scrubDir = dir; scrubHoldAt = Date.now(); }
      if (seekEl.className.indexOf(' scrubbing') === -1) seekEl.className += ' scrubbing';
      if (!scrubTimer) scrubTimer = setInterval(scrubTick, 110);
      scrubTick();
    }
    Focus.onKey(function (k, ev) {
      if (layer.className.indexOf('hidden') !== -1) return false;
      var pm = U.qs('#pmenu');
      if (pm && pm.className.indexOf('open') !== -1) {
        if (isBackKey(k)) { closePlayerMenu(); return true; }
        if (k === 38 || k === 40) { moveMenuFocus(k === 38 ? -1 : 1); return true; }
        var repeat = !!(ev && ev.repeat);
        if ((k === 37 || k === 39) && !repeat) {
          if (k === 39) {
            if (playerMenuStack.length) parentPlayerMenu(); else closePlayerMenu();
          } else {
            // Left opens a submenu; on a leaf it does nothing.
            var row = playerMenuRows ? playerMenuRows[playerMenuFocus] : null;
            if (row && row.sub) activateFocusedMenuRow();
          }
          return true;
        }
        if ((k === 13 || k === 32) && !repeat) { activateFocusedMenuRow(); return true; }
        return true;   // the drawer owns every key while it is visible
      }
      var osd = U.qs('#osd');
      var nbx = U.qs('#next-ep', layer);
      var na = U.qs('#next-ep-action', layer);
      var nextShowing = !!(nbx && nbx.className.indexOf(' show') !== -1);
      if (osd && osd.style.opacity === '0') {
        // OK is handled in the capture phase: Next Episode when it is showing,
        // otherwise Play/Pause when no control has focus.
        // Left/Right with no controller visible: jump immediately instead of
        // only moving the hidden scrub cursor. Ignore key repeat so holding the
        // key does not also start a full scrub on the next event.
        if (k === 37 || k === 39) {
          if (!ev || !ev.repeat) jumpBy(k === 39 ? 10 : -10);
          // The focused Next Episode button must not drag the controls up.
          if (Focus.get() !== na) showOsd();
          return true;
        }
        if (k === 40 && na && Focus.get() === na) {
          // Down from the prompt: reveal the controller, which pushes the
          // prompt upward, and give the seek bar focus.
          Focus.set(seekEl);
          showOsd(true);
          return true;
        }
        showOsd();                                    // controls appear with the seek bar focused
        if (k === 38 || k === 40) return true;        // first Up/Down only reveals them
      }

      if (k === 37 || k === 39) {
        var dir = k === 39 ? 1 : -1;
        var f = Focus.get();
        if (f && f.id === 'seek') startScrub(dir);
        else moveHorizontal(dir);
        showOsd();
        return true;
      }
      if (k === 38 || k === 40) {
        var cf = Focus.get();
        var onSeek = cf === seekEl;
        if (k === 40) {
          // Down always brings up the control row, Next Episode showing or not.
          showOsd();
          if (onSeek) Focus.set(U.qs('#pp', layer));
          return true;
        }
        // With the Next Episode prompt on screen, Up from the seek bar reaches
        // Play/Pause. In every other case Up dismisses the controller.
        if (nextShowing && onSeek) {
          Focus.set(U.qs('#pp', layer)); showOsd(); return true;
        }
        hideOsd();
        return true;
      }
      if (k === 13) showOsd();   // OK on a focused control: let the click happen
      return false;
    });
    // Release: play straight from the cursor position (no delayed commit).
    seekKeyupHandler = function (e) {
      if (layer.className.indexOf('hidden') !== -1) return;
      if (e.keyCode !== 37 && e.keyCode !== 39) return;
      if (!scrubbing) return;
      commitSeek();
    };
    document.addEventListener('keyup', seekKeyupHandler, false);

    // Android TV starts with Play/Pause selected; Left/Right still scrub.
    Focus.set(U.qs('#pp', layer));
    try { player.play(); } catch (e) {}
  }

  function isBackKey(k) { return k === 10009 || k === 461 || k === 8 || k === 27; }

  function playerMenuNote(title) {
    return title === 'Subtitle sync'
      ? 'Start here = the first subtitle words line up with the spoken words at this playback time.'
      : '';
  }
  function menuFocusEl() {
    var pm = U.qs('#pmenu');
    if (!pm) return null;
    var list = U.qsa('.pm-panel.current .pm-row[data-focus="1"]', pm);
    return list[playerMenuFocus] || list[0] || null;
  }
  function activateMenuRow(r, idx) {
    if (!r) return;
    playerMenuFocus = idx;
    var gen = playerMenuRenderId;
    if (typeof r.fn === 'function') r.fn();
    var pm = U.qs('#pmenu');
    // A leaf action that did not open/replace a menu keeps the drawer open.
    if (pm && pm.className.indexOf('open') !== -1 && playerMenuRenderId === gen)
      playerMenu(playerMenuTitle, playerMenuRows, true);
  }
  function buildMenuPanel(pm, title, rows, level, total, focusIdx, parentTitle, isCurrent) {
    var panel = U.el('div', 'pm-panel level-' + level + (isCurrent ? ' current' : ''));
    panel.style.right = (level * 406) + 'px';
    panel.style.top = (level * 58) + 'px';
    panel.style.bottom = (level * 58) + 'px';
    panel.style.zIndex = String(total - level);
    var head = '';
    if (level > 0) head += '<div class="pm-crumb">' + U.esc(parentTitle || '') + ' \u203a</div>';
    head += '<div class="pm-title">' + U.esc(title) + '</div>';
    panel.appendChild(U.el('div', 'pm-head', head));
    var list = U.el('div', 'pm-rows');
    for (var i = 0; i < rows.length; i++) {
      (function (r, idx) {
        var cls = 'pm-row';
        if (r.current) cls += ' current';
        if (isCurrent && idx === focusIdx) cls += ' focused';
        else if (!isCurrent && idx === focusIdx) cls += ' path';
        var e = U.el('div', cls,
          '<span class="pm-chev">' + (r.sub ? '\u2039' : '') + '</span>' +
          '<span class="pm-label">' + U.esc(r.label) + '</span>');
        if (isCurrent) {
          e.setAttribute('data-focus', '1');
          e.onclick = function () { activateMenuRow(r, idx); };
        }
        list.appendChild(e);
      })(rows[i], i);
    }
    panel.appendChild(list);
    if (isCurrent) {
      var note = playerMenuNote(title);
      if (note) panel.appendChild(U.el('div', 'pm-note', U.esc(note)));
    }
    pm.appendChild(panel);
  }
  // V3 continuous split drawer: the root is flush right and full height; every
  // submenu sits to its left, shorter, more transparent, and softly shadowed.
  function renderPlayerMenu() {
    var pm = U.qs('#pmenu');
    if (!pm) return;
    var n = playerMenuRows ? playerMenuRows.length : 0;
    if (!n) playerMenuFocus = 0;
    else if (playerMenuFocus < 0) playerMenuFocus = 0;
    else if (playerMenuFocus >= n) playerMenuFocus = n - 1;
    pm.innerHTML = '';
    var total = playerMenuStack.length + 1, i, parentTitle;
    for (i = 0; i < playerMenuStack.length; i++) {
      parentTitle = i > 0 ? playerMenuStack[i - 1].title : '';
      buildMenuPanel(pm, playerMenuStack[i].title, playerMenuStack[i].rows || [], i, total,
        playerMenuFocusStack[i] || 0, parentTitle, false);
    }
    parentTitle = playerMenuStack.length ? playerMenuStack[playerMenuStack.length - 1].title : '';
    buildMenuPanel(pm, playerMenuTitle, playerMenuRows || [], playerMenuStack.length, total,
      playerMenuFocus, parentTitle, true);
    pm.className = 'player-menu open';
    var f = menuFocusEl();
    if (f) {
      Focus.set(f);
      var list = f.parentNode;
      if (list && typeof list.scrollTop === 'number') {
        var top = f.offsetTop - list.offsetTop, bottom = top + f.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = Math.max(0, top - 8);
        else if (bottom > list.scrollTop + list.clientHeight)
          list.scrollTop = bottom - list.clientHeight + 8;
      }
    }
    playerMenuRenderId++;
  }
  function moveMenuFocus(delta) {
    var n = playerMenuRows ? playerMenuRows.length : 0;
    if (!n) return;
    playerMenuFocus = (playerMenuFocus + delta + n) % n;
    renderPlayerMenu();
  }
  function activateFocusedMenuRow() {
    activateMenuRow(playerMenuRows ? playerMenuRows[playerMenuFocus] : null, playerMenuFocus);
  }
  // `replace` redraws the current level without pushing a Back step; `pop`
  // returns from a leaf submenu to the row that opened it.
  function playerMenu(title, rows, replace, pop) {
    var pm = U.qs('#pmenu');
    var wasOpen = !!(pm && pm.className.indexOf('open') !== -1);
    if (!wasOpen) {
      playerMenuStack = []; playerMenuFocusStack = [];
      var f = Focus.get();
      if (f && f.parentNode !== pm && String(f.className || '').indexOf('pm-row') === -1)
        playerMenuReturnFocus = f;
      playerMenuFocus = 0;
    } else if (pop) {
      if (playerMenuStack.length) {
        var prev = playerMenuStack.pop();
        playerMenuFocus = playerMenuFocusStack.length ? playerMenuFocusStack.pop() : 0;
        playerMenuTitle = prev.title; playerMenuRows = prev.rows || [];
      } else {
        playerMenuFocus = 0;
      }
    } else if (!replace) {
      playerMenuStack.push({ title: playerMenuTitle, rows: playerMenuRows || [] });
      playerMenuFocusStack.push(playerMenuFocus);
      playerMenuFocus = 0;
    }
    playerMenuTitle = title; playerMenuRows = rows || [];
    renderPlayerMenu();
  }
  // Right on a submenu goes one level up; Right on the root closes everything.
  function parentPlayerMenu() {
    if (!playerMenuStack.length) return closePlayerMenu();
    var prev = playerMenuStack.pop();
    playerMenuFocus = playerMenuFocusStack.length ? playerMenuFocusStack.pop() : 0;
    playerMenuTitle = prev.title; playerMenuRows = prev.rows || [];
    renderPlayerMenu();
    return true;
  }
  // Back closes the whole drawer from any level, including every submenu.
  function closePlayerMenu() {
    var pm = U.qs('#pmenu');
    if (!pm || pm.className.indexOf('open') === -1) return false;
    pm.className = 'player-menu'; pm.innerHTML = '';
    playerMenuStack = []; playerMenuFocusStack = [];
    playerMenuTitle = ''; playerMenuRows = null; playerMenuFocus = 0; playerMenuRenderId++;
    var back = playerMenuReturnFocus;
    playerMenuReturnFocus = null;
    if (back && back.parentNode) Focus.set(back);
    else Focus.set(U.qs('#pp'));
    return true;
  }

  // The Next Episode prompt sits low over the picture. When the controller
  // opens it is pushed above the seek bar / button row instead of overlapping.
  function positionNextEp(controlsOpen) {
    var nb = U.qs('#next-ep');
    if (nb) nb.style.bottom = controlsOpen ? '250px' : '155px';
  }
  function hideOsd() {
    var osd = U.qs('#osd');
    if (osd) osd.style.opacity = '0';
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    positionNextEp(false);
  }
  function showOsd(force) {
    var osd = U.qs('#osd');
    var l = U.qs('#torrent-loader');
    if (l && l.className.indexOf('hidden') === -1) return;  // first-load logo owns the screen
    var nb = U.qs('#next-ep');
    var na = U.qs('#next-ep-action');
    // While the Next Episode button has focus, only the prompt is visible.
    // Down explicitly reveals the controller (it moves focus off the button).
    if (!force && nb && na && nb.className.indexOf(' show') !== -1 && Focus.get() === na) {
      if (osd) osd.style.opacity = '0';
      if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
      positionNextEp(false);
      return;
    }
    var wasHidden = osd && osd.style.opacity === '0';
    if (osd) osd.style.opacity = '1';
    positionNextEp(true);
    // Whenever the controls appear, the seek bar has focus (unless a player
    // menu is open).
    var pm = U.qs('#pmenu'), sk = U.qs('#seek');
    if (wasHidden && sk && !(pm && pm.className.indexOf('open') !== -1)) Focus.set(sk);
    resetOsd();
  }
  function resetOsd() {
    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = setTimeout(function () {
      var osd = U.qs('#osd'); if (osd) osd.style.opacity = '0';
    }, 3500);
  }
  function stopPlayer(keepEngine) {
    // Exiting the player cancels the Up-next auto-play; it only happens while
    // the user is still watching this episode.
    if (cancelNextAutoplay) { try { cancelNextAutoplay(); } catch (e) {} cancelNextAutoplay = null; }
    nextEpisodeHooks = null;
    // Store the final position before tearing down (Continue Watching).
    if (saveProgressNow) { try { saveProgressNow(); } catch (e) {} saveProgressNow = null; }
    if (clearSeekTimer) { clearSeekTimer(); clearSeekTimer = null; }
    if (seekKeyupHandler) { document.removeEventListener('keyup', seekKeyupHandler, false); seekKeyupHandler = null; }
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    Focus.onKey(null);
    playerToggle = null; playerJump = null; playerStop = null; playerInfo = null;
    playerMute = null; playerVolume = null; playerStep = null; playerOk = null;
    playerMenuReturnFocus = null; playerMenuStack = []; playerMenuFocusStack = [];
    playerMenuTitle = ''; playerMenuRows = null; playerMenuFocus = 0; playerMenuRenderId++;
    stopStatsPolling();
    stopStallWatch();
    remoteLog = function () {};
    // Going straight to the next episode keeps the engine (peers, metadata and
    // the pre-loaded pieces); playStream() then switches its file.
    if (window.Engine && !keepEngine) window.Engine.stop();
    var p = player;
    player = null;   // first, so late 'error' events from the old player are ignored
    if (p) {
      if (p.isAvPlay) { try { p.destroy(); } catch (e) {} }
      else { try { p.pause(); p.removeAttribute('src'); p.load(); } catch (e) {} }
    }
    document.documentElement.className = document.documentElement.className.replace(/\s*avplay-active/g, '');
    document.body.className = document.body.className.replace(/\s*avplay-active/g, '');
  }

  function init() {
    view = U.qs('#view');
    buildSidebar();
    updateProfile();
    U.qs('#side-profile').onclick = function () { account(); };
    Focus.onBack(function () { back(); });
    Focus.onChange(function () {
      refreshTabIcons();
      // Focusing the Next Episode button clears the video controls: the
      // prompt is the only thing on screen until Down reveals the controller.
      var pl = U.qs('#player-layer');
      if (pl && pl.className.indexOf('hidden') === -1) {
        var nb = U.qs('#next-ep'), na = U.qs('#next-ep-action');
        if (nb && na && Focus.get() === na && nb.className.indexOf(' show') !== -1) hideOsd();
      }
    });
    Focus.setRoot(U.qs('#app'));
    // Capture before Focus.js so all TV remote media keys are handled once.
    // Volume/FF/REW may repeat; one-shot keys ignore auto-repeat.
    document.addEventListener('keydown', function (e) {
      if (!player) return;
      var k = e.keyCode, handled = false;
      if (k === 415 || k === 19 || k === 179) {
        if (!e.repeat && playerToggle) { try { playerToggle(); } catch (err) { remoteLog('toggle-error', { message: String(err && err.message || err) }); } }
        handled = !!playerToggle;
      } else if (k === 412 && playerJump) { try { playerJump(-30); } catch (err) {} handled = true; }
      else if (k === 417 && playerJump) { try { playerJump(30); } catch (err) {} handled = true; }
      else if (k === 413 && playerStop) { if (!e.repeat) { try { playerStop(); } catch (err) {} } handled = true; }
      else if (k === 457 && playerInfo) { if (!e.repeat) { try { playerInfo(); } catch (err) {} } handled = true; }
      else if (k === 449 && playerMute) { if (!e.repeat) { try { playerMute(); } catch (err) {} } handled = true; }
      else if (k === 447 && playerVolume) { try { playerVolume(0.1); } catch (err) {} handled = true; }
      else if (k === 448 && playerVolume) { try { playerVolume(-0.1); } catch (err) {} handled = true; }
      else if ((k === 427 || k === 428) && playerStep) {
        if (!e.repeat) { try { playerStep(k === 427 ? 1 : -1); } catch (err) {} }
        handled = true;
      }
      // Back is handled in the capture phase so the player can always be
      // exited even if focus has landed on the AVPlay plugin or a hidden control.
      else if (isBackKey(k) && !e.repeat) {
        var pmenu = U.qs('#pmenu');
        if (pmenu && pmenu.className.indexOf('open') !== -1) closePlayerMenu();
        else closeLayers();
        handled = true;
      } else if (k === 13 && playerOk && playerOk(k, e)) {
        handled = true;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // Re-check every 2 s: if AVPlay or the NaCl embed takes native focus,
    // keydown never reaches the document and the TV looks completely frozen.
    if (!focusReclaimTimer) focusReclaimTimer = setInterval(function () {
      reclaimRemoteFocus(false);
    }, 2000);
    setTimeout(function () {
      U.qs('#splash').style.display = 'none';
      U.qs('#app').style.display = 'block';
      navigate('board');
      var au = API.auth();
      if (au && au.authKey) {
        API.syncLibrary(au.authKey, function () {}, function () {});
        API.userAddons(au.authKey, function (list) { if (list.length) API.saveAddons(list); }, function () {});
      }
    }, 700);
  }

  return { init: init, navigate: navigate, back: back, openMeta: openMeta, openStreams: openStreams,
    continueWatching: continueWatching,
    playUrl: playUrl, playStream: playStream, toast: toast, installAddon: installAddon,
    modal: modal, closeLayers: closeLayers, textInput: textInput,
    account: account, updateProfile: updateProfile, syncAddons: syncAddons, syncLibrary: syncLibrary,
    SUB_COLORS: SUB_COLORS, subtitleColorName: colorName,
    applySubtitleSettings: applySubtitleSettings,
    subSyncText: function () { return subSyncLabel(subOffset); },
    subSyncBy: adjustSubOffset,
    subSyncSet: function (v) { setSubOffset(v, true); toast('Subtitle sync: ' + subSyncLabel(subOffset)); } };
})();

document.addEventListener('DOMContentLoaded', function () { App.init(); });

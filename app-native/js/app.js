/* app.js — shell, routing, player, remote handling */
var App = (function () {
  var view = null, history = [], current = null, toastTimer = null, loadTimer = null;
  var homeLoadingHeld = false, homeLoadingTimer = null;   // first-open Home waits for last-watched episode
  var homeDataReady = false, homeDataWaiters = [];        // account library + addons are synced
  var playerGen = 0;                                      // guards late logo fetches from old playbacks
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
  // First launch holds the Home loading treatment until Views.board has resolved
  // the last-watched episode into the Continue Watching row. The cap is only a
  // safety net for a dead addon; a normal request finishes well inside it.
  function holdHomeLoading() {
    homeLoadingHeld = true;
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (homeLoadingTimer) clearTimeout(homeLoadingTimer);
    setLoading(true);
    homeLoadingTimer = setTimeout(releaseHomeLoading, 30000);
  }
  function releaseHomeLoading() {
    if (homeLoadingTimer) { clearTimeout(homeLoadingTimer); homeLoadingTimer = null; }
    if (!homeLoadingHeld) return;
    homeLoadingHeld = false;
    setLoading(false);
    refreshTabIcons();
  }
  // Views.board starts its first-load work only after the signed-in account
  // library and addons exist, while the Home skeleton is already on screen.
  function whenHomeDataReady(cb) {
    if (!cb) return;
    if (homeDataReady) { cb(); return; }
    homeDataWaiters.push(cb);
  }
  function markHomeDataReady() {
    if (homeDataReady) return;
    homeDataReady = true;
    var w = homeDataWaiters; homeDataWaiters = [];
    for (var i = 0; i < w.length; i++) w[i]();
  }
  function refreshTabIcons() {
    // Selected tab turns WHITE when focus is out in the content/buttons; it is
    // only indigo when the nav bar itself is being navigated.
    var inBar = focusInSidebar();
    var loading = isLoading();
    // Focus moved into the content (or the first shelf arrived): load styling
    // is no longer needed. Toggle only nav-idle — overwriting className would
    // wipe avplay-active during playback and put the page over the video.
    if (!inBar && loading && !homeLoadingHeld) { setLoading(false); loading = false; }
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
    loadTimer = setTimeout(function () {
      if (!homeLoadingHeld) setLoading(false);   // first-open Home stays in its loader
      refreshTabIcons();
    }, 1200);
    markTab(name);
    Focus.clear();
    Focus.setRoot(U.qs('#app'));
    if (Views.dispose) Views.dispose();
    if (name === 'board') {
      var firstOpen = current.params.firstOpen === true;
      current.params.firstOpen = false;   // Back into Home must not re-hold the loader
      Views.board(view, firstOpen);
    }
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
  // Back MUST exit the video player. A native plugin can swallow the keydown,
  // so both keydown and keyup route here and a short debounce fires it once.
  function handlePlayerBack(key) {
    var now = Date.now();
    if (now - lastBackHandled < 300) return true;
    lastBackHandled = now;
    var pmenu = U.qs('#pmenu'), pl = U.qs('#player-layer');
    remoteLog('back-key', { key: key || 0, player: !!player,
      playerOpen: !!(pl && pl.className.indexOf('hidden') === -1),
      menuOpen: !!(pmenu && pmenu.className.indexOf('open') !== -1) }, true);
    if (pmenu && pmenu.className.indexOf('open') !== -1) { closePlayerMenu(); return true; }
    // Pull focus off AVPlay/NaCl before closing, or the next remote key can be
    // eaten by the plugin after the HTML layer is gone.
    reclaimRemoteFocus(true);
    closeLayers();
    return true;
  }
  function openMeta(id, type, opts) {
    if (!id) return;
    var p = { id: id, type: type || 'movie' };
    if (opts && opts.fromContinue) p.fromContinue = true;
    navigate('meta', p);
  }
  // The series details page remembers the season tab it was showing in the
  // history entry, so Back from an episode's detail page returns to that tab.
  function rememberSeriesTab(seriesId, season, videoId) {
    if (!current || current.name !== 'meta' || !current.params) return;
    if (String(current.params.id) !== String(seriesId)) return;
    current.params.seriesTab = { season: Number(season) || 0, videoId: videoId || '' };
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
    // Reuse meta already loaded on the details page: series keeps the
    // episode list, movies keep their real API title logo.
    var cached = API.cachedMeta(type === 'series' ? 'series' : 'movie', item.id);
    if (cached && cached.meta) meta = cached.meta;
    var parsed = API.parseStream(s);
    // Series cards use the exact player title: Show — Sx Ey • Episode title.
    // Continue Watching used to pass only item.name, which lost the episode.
    var title = (Views.displayTitle && meta && meta.videos) ? Views.displayTitle(meta, vid) : item.name;
    playStream(s, meta, { title: title, quality: parsed.quality, seeders: parsed.seeders,
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
      // Hide FIRST. Engine.stop()/AVPlay destroy() can throw on Tizen 3.0;
      // doing that before hiding is what left Back trapped inside the player.
      pl.className = 'layer hidden';
      lastLayerClose = Date.now();
      try { stopPlayer(); }
      catch (e) { remoteLog('stop-error', { message: String((e && e.message) || e) }, true); }
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
    // Never paint cues over the first-load logo or over paused artwork. Cues
    // only become eligible once the picture is actually playing; the default
    // offset is zero, so video second 0 lines up with subtitle second 0.
    // Clearing lastSubtitleHtml here is what lets the exact same cue reappear
    // immediately when the video resumes from its current time.
    if (!subtitlePlaybackStarted || !subOn || !subCues.length || !player || player.paused) {
      if (el.innerHTML !== '') el.innerHTML = '';
      lastSubtitleHtml = '';
      return;
    }
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
  var seekKeyupHandler = null, clearSeekTimer = null, seekLoadTimer = null;
  var firstLoadArmTimer = null, firstLoadFadeTimer = null;
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
  var subtitlePlaybackStarted = false;   // cues stay hidden until the picture is really playing
  var saveProgressNow = null;   // set by playUrl; called on exit to store the final position
  var nextEpisodeHooks = null;  // set by playUrl: pre-load of the next episode
  var cancelNextAutoplay = null; // set by playUrl; stops the Up-next countdown on exit
  var qrTimer = null, statsTimer = null, stallTimer = null, statsSlow = false;
  var PAUSE_KEEP_MS = 15 * 60 * 1000;  // torrent engine stays alive this long while paused
  var PAUSE_SOFT_MS = 45 * 1000;       // silent AVPlay reconnect after shorter pauses
  var pauseStopHook = null;     // set by playUrl; cancels the 15-minute pause timer
  var clearPausedLogo = null;   // set by playUrl; removes pause scrim + title art
  var hidePauseArtWithControls = null;  // set by playUrl; hides pause art with the OSD
  var focusReclaimTimer = null;
  var playerClockTimer = null;  // repaints the local clock in the player OSD
  var lastBackHandled = 0;      // Back is handled on keydown and keyup; fire once
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
  // Local device time, HH:MM, shown in the top-right of the player controls
  // only when Settings > Playback > Show clock is On.
  function localClockText() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function paintPlayerClock() {
    var e = U.qs('#osd-clock');
    if (!e) return;
    var s = localClockText();
    if (e.textContent !== s) e.textContent = s;
  }
  function startPlayerClock() {
    stopPlayerClock();
    if (U.get('showClock', true) === false) return;
    paintPlayerClock();
    playerClockTimer = setInterval(paintPlayerClock, 15000);
  }
  function stopPlayerClock() {
    if (playerClockTimer) { clearInterval(playerClockTimer); playerClockTimer = null; }
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
      return { title: 'S' + se + ' E' + ep + ((n.title || n.name) ? '  •  ' + (n.title || n.name) : ''),
        thumb: n.thumbnail || n.poster || '' };
    }
    return { title: 'Next episode', thumb: '' };
  }
  // Cinemeta names the episode field "name"; other addons use "title".
  function metaVideo(meta, vid) {
    var vids = ((meta && meta.videos) || []);
    for (var i = 0; i < vids.length; i++) if (vids[i].id === vid) return vids[i];
    return null;
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
    var curVid = metaVideo(meta, info.videoId);
    var description = info.description || '';
    if (!description && curVid) description = curVid.overview || curVid.description || '';
    if (!description && meta) description = meta.description || meta.overview || '';
    playUrl(url, info.title || parsed.title || s.name, {
      poster: meta && meta.poster, type: 'stream', subtitles: s.subtitles,
      description: description,
      quality: info.quality || parsed.quality, seeders: info.seeders,
      infoHash: hash, fileIdx: fidx,
      // Kept so an AVPlay recovery can restart the local engine with the same
      // peers if the stream was stopped while the player was paused.
      sources: (hash && sources) ? sources : [],
      fileName: (hash && fname) || '',
      prevId: info.prevId || nav.prevId, nextId: nextId,
      nextTitle: info.nextTitle || nxi.title,
      preferAv: prefersAvPlay(s),
      id: info.progressId, videoId: info.videoId, resumePos: info.resumePos,
      mediaType: info.mediaType, mediaId: info.videoId || (meta && meta.id),
      subLang: U.get('subLang', 'en'),
      // First-load loader uses only the title logo supplied by the Stremio
      // API (Harry Potter, Mink, ...). Never fall back to the poster/backdrop.
      logo: (meta && meta.logo) || ''
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
  // Number of distinct audio versions advertised by a torrent stream. The
  // audio button is only useful when there are at least two; direct streams
  // have no selectable tracks at all.
  function audioVariantCount(s) {
    if (!s || !API.infoHash(s)) return 0;
    var hints = s.behaviorHints || {}, raw = '';
    if (hints.audioLanguages) {
      raw = Object.prototype.toString.call(hints.audioLanguages) === '[object Array]' ?
        hints.audioLanguages.join(',') : String(hints.audioLanguages);
    }
    if (!raw) raw = API.parseStream(s).langs || '';
    raw = String(raw || '');
    var seen = [], i;
    // Flag emoji (e.g. "🇬🇧 / 🇷🇺") are the usual Torrentio language format.
    var flags = raw.match(/\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF]/g) || [];
    for (i = 0; i < flags.length; i++) if (seen.indexOf(flags[i]) < 0) seen.push(flags[i]);
    if (seen.length > 1) return seen.length;
    // Otherwise count slash/comma separated names or codes.
    var parts = raw.split(/[\/,+&|;]+/);
    for (i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+|\s+$/g, '').replace(/[\uFE0F\u200D]/g, '');
      if (p && seen.indexOf(p) < 0) seen.push(p);
    }
    return seen.length;
  }
  // First-load only: the logo fills from left to right as the torrent buffers.
  // Stats from the LAN bridge sit below it; no title, status text or bar.
  function torrentLoaderHtml(opts) {
    var bg = opts.logo ? " style=\"background-image:url('" + U.attr(opts.logo) + "')\"" : '';
    var seeds = (opts.seeders === null || opts.seeders === undefined) ? '\u2014' : U.esc(opts.seeders);
    return '<div class="tl-curtain" id="tl-curtain"></div>' +
      '<div class="torrent-loader" id="torrent-loader">' +
      '<div class="tl-logo" id="tl-logo"' + (opts.logo ? '' : ' style="display:none"') + '>' +
      '<div class="tl-logo-base" id="tl-logo-base"' + bg + '></div>' +
      '<div class="tl-logo-mask" id="tl-logo-mask"><div class="tl-logo-color" id="tl-logo-color"' + bg + '></div></div>' +
      '</div>' +
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
    var myGen = ++playerGen;   // late logo lookups must not paint a newer player
    // Cancel any long-pause art left by the previous playback before this
    // layer is rebuilt and the closure pointer is replaced.
    if (clearPausedLogo) { try { clearPausedLogo(); } catch (e) {} clearPausedLogo = null; }
    hidePauseArtWithControls = null;
    subtitlePlaybackStarted = false;
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
    // Live download speed stays green, next to quality and seeders.
    if (opts.infoHash) osdSub += (osdSub ? '  •  ' : '') + '<b>\u2193</b> <b id="osd-speed">0 KB/s</b>';
    if (!osdSub) osdSub = U.esc(opts.type || '');
    var layer = U.qs('#player-layer');
    layer.className = 'layer'; clearLayer(layer);
    layer.innerHTML = '<div id="video-wrap" style="position:absolute;left:0;top:0;width:1920px;height:1080px;background:#000">' +
      '<video id="video" style="width:1920px;height:1080px;object-fit:contain"' + (opts.infoHash ? '' : (' src="' + U.attr(url) + '" autoplay')) + '></video></div>' +
      (opts.infoHash ? torrentLoaderHtml(opts) : '') +
      '<div class="pause-underlay" id="pause-underlay"></div>' +
      '<div class="paused-logo" id="paused-logo"' + (opts.logo ? " style=\"background-image:url('" + U.attr(opts.logo) + "')\"" : '') + '></div>' +
      '<div class="loading" id="load"></div><div class="load-pct" id="load-pct"></div>' +
      '<div class="player-osd" id="osd">' +
      '<div class="osd-clock" id="osd-clock"></div>' +
      '<div class="osd-top"><div class="osd-title">' + U.esc(title || 'Playing') + '</div><div class="osd-sub">' + osdSub + '</div>' +
      '<div class="osd-desc">' + U.esc(opts.description || '') + '</div></div>' +
      '<div class="osd-bottom"><div class="seekbar" id="seek" data-focus="1"><div class="buffered" id="buffered"></div><div class="fill" id="fill"></div><div class="knob" id="knob"></div></div>' +
      '<div class="player-controls">' +
      '<span class="pbtn playpause" data-focus="1" data-icon="pause" id="pp"><i style="background-image:' + U.icon('pause') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="chevrons_back" id="prev-ep"><i style="background-image:' + U.icon('chevrons_back') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="chevrons_forward" id="next-ep-btn"><i style="background-image:' + U.icon('chevrons_forward') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="subtitles" id="subtitles"><i style="background-image:' + U.icon('subtitles') + '"></i></span>' +
      '<span class="pbtn" data-focus="1" data-icon="audio_tracks" id="audio"><i style="background-image:' + U.icon('audio_tracks') + '"></i></span>' +
      '<span class="time" id="time">0:00 / 0:00</span>' +
      '</div></div></div>' +
      '<div id="remote-focus" tabindex="-1" style="position:absolute;left:-100px;top:-100px;width:1px;height:1px;outline:none"></div>' +
      '<div class="subtitle" id="subtitle"></div>' +
      '<div class="player-menu" id="pmenu"></div>' +
      '<div class="next-episode" id="next-ep">' +
      '<div class="ne-card">' +
      '<div class="ne-info"><div class="ne-kicker" id="next-ep-kicker">UP NEXT</div>' +
      '<div class="ne-title" id="next-ep-title">' + U.esc(opts.nextTitle || 'Next episode') + '</div>' +
      '<div class="ne-progress" id="next-ep-progress"></div></div>' +
      '<div class="ne-action" id="next-ep-action" data-focus="1">Next Episode</div>' +
      '</div></div>';
    startPlayerClock();
    Focus.setRoot(layer);
    // Pause-only treatment: a 20% black scrim, then the exact API title logo
    // from the loader at 100 px top/left. Both disappear on play/stop.
    var pausedLogo = U.qs('#paused-logo', layer);
    var pauseUnderlay = U.qs('#pause-underlay', layer);
    function hidePauseArt(instant) {
      // Controls disappear immediately; match them exactly when the pause art
      // goes away on resume instead of fading out on its own timer.
      if (pausedLogo) {
        if (instant) pausedLogo.style.transition = 'none';
        pausedLogo.className = 'paused-logo';
      }
      if (pauseUnderlay) pauseUnderlay.className = 'pause-underlay';
    }
    function showPauseArt() {
      if (!player || !player.paused || !videoStarted) { hidePauseArt(); return; }
      if (pausedLogo) pausedLogo.style.transition = '';
      if (pauseUnderlay) pauseUnderlay.className = 'pause-underlay show';
      if (pausedLogo) pausedLogo.className = 'paused-logo show';
    }
    clearPausedLogo = hidePauseArt;
    pauseStopHook = clearPauseStop;
    hidePauseArtWithControls = function () {
      if (!player || player.paused) return;   // keep the art while still paused
      hidePauseArt(true);
    };
    // Movie Continue Watching items can arrive from the account library without
    // a logo. Fetch the real API meta.logo only in that case — never a poster
    // or backdrop — and paint both the loader and the pause art when it lands.
    if (!opts.logo) {
      var logoType = opts.mediaType === 'series' ? 'series' : 'movie';
      var logoId = logoType === 'series' ? (opts.id || opts.videoId) : (opts.videoId || opts.id);
      if (logoId && API.getMeta) {
        API.getMeta(logoType, logoId, function (d) {
          var u = d && d.meta && d.meta.logo;
          if (!u || myGen !== playerGen || layer.className.indexOf('hidden') !== -1) return;
          opts.logo = u;
          var tl = U.qs('#tl-logo', layer);
          if (tl) tl.style.display = 'block';
          var base = U.qs('#tl-logo-base', layer);
          if (base) base.style.backgroundImage = "url('" + U.attr(u) + "')";
          var color = U.qs('#tl-logo-color', layer);
          if (color) color.style.backgroundImage = "url('" + U.attr(u) + "')";
          var pl = U.qs('#paused-logo', layer);
          if (pl) pl.style.backgroundImage = "url('" + U.attr(u) + "')";
        });
      }
    }
    subCues = []; subOn = true; subUrl = ''; lastSubtitleHtml = ''; lastTimeText = '';
    subTracks = opts.subtitles || [];
    loadSavedSubOffset(opts.videoId || opts.mediaId || (title ? 'title:' + title : ''));
    applySubtitleSettings();
    // Episode buttons stay in the control bar where the skip chevrons were.
    // For a movie they are dimmed and explain why when pressed.
    if (!opts.prevId) {
      var pbtn = U.qs('#prev-ep', layer); if (pbtn) pbtn.setAttribute('data-disabled', '1');
    }
    if (!opts.nextId) {
      var nbtn = U.qs('#next-ep-btn', layer); if (nbtn) nbtn.setAttribute('data-disabled', '1');
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
    // Long pauses and AVPlay connection failures need a fresh local HTTP
    // connection at the same position. Track when the pause started and how
    // many automatic recoveries have already been attempted.
    var pausedAt = 0, avRecoveries = 0;
    var pauseStopTimer = null, pausedTooLong = false, resumeWarmup = null;
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
    var bufferedEl = U.qs('#buffered', layer);
    // Seeking is deferred: holding Left/Right only moves the seek cursor, and
    // the actual seek happens one second after the key is released. Repeated
    // keydowns used to fire a seek each time, which starved the torrent stream.
    var scrubbing = false, seekTarget = 0, scrubDir = 0, scrubHoldAt = 0, scrubTimer = null;
    var wasPlayingBeforeScrub = false, lastScrubKeyAt = 0, seekHideTimer = null, scrubStart = 0;
    // Light-purple segment: bytes that are already on the TV, so seeking into
    // this range starts immediately. HTML video exposes it via buffered; the
    // AVPlay plugin does not, so the NaCl engine reports loadedPct in /stats.
    function paintBuffered() {
      var d = player && player.duration, known = d && isFinite(d) && d > 0, pct = 0;
      if (known && player.buffered && player.buffered.length) {
        try { pct = player.buffered.end(player.buffered.length - 1) / d * 100; } catch (e) {}
      }
      if (!(pct > 0) && lastStats) {
        if (lastStats.loadedPct != null) pct = Number(lastStats.loadedPct);
        else if (lastStats.streamLen > 0 && lastStats.downloaded > 0)
          pct = lastStats.downloaded * 100 / lastStats.streamLen;
      }
      if (!isFinite(pct) || pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      bufferedEl.style.width = pct + '%';
    }
    function paintSeek(t) {
      var d = player && player.duration, known = d && isFinite(d) && d > 0;
      var pct = known ? Math.max(0, Math.min(100, t / d * 100)) : 0;
      fillEl.style.width = pct + '%';
      U.qs('#knob', layer).style.left = pct + '%';
      U.qs('#time', layer).innerHTML = U.fmtTime(t) + ' / ' + (known ? U.fmtTime(d) : '--:--');
      paintBuffered();
    }
    function commitSeek() {
      if (!scrubbing) return;
      scrubbing = false; scrubDir = 0;
      if (scrubTimer) { clearInterval(scrubTimer); scrubTimer = null; }
      seekEl.className = seekEl.className.replace(/\s*scrubbing/g, '');
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      // Seek commits immediately; no round overlay over a playing picture.
      endWarmup();
      seekPending = true; seekFrom = -1;
      hideLoadSpinner();
      // Backward seeks stay on the current AVPlay/HTTP range. Reopening the URL
      // makes the local server answer with the whole file from byte 0, then the
      // native seek lands on data that is not there and AVPlay reports
      // "cannot decode the file". A straight seekTo keeps the live connection.
      var backward = seekTarget < scrubStart - 0.5;
      var reopened = false;
      if (!backward && usingAvPlay) reopened = reopenPlayer(seekTarget, wasPlayingBeforeScrub);
      if (!reopened) {
        try { player.currentTime = seekTarget; } catch (e) {}
        // Resume immediately at the released position: the old 1 s delay made
        // the picture look frozen after a long scrub.
        if (wasPlayingBeforeScrub && player.paused) { try { player.play(); } catch (e) {} }
      }
      remoteLog('seek', { target: seekTarget, duration: player.duration, at: player.currentTime,
        backward: backward, reopened: reopened });
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
    var curtain = U.qs('#tl-curtain', layer);
    // First-load exit: black backdrop → transparent and logo/stats → 0 opacity
    // together over exactly one second. Both elements carry the same CSS
    // transition, so the picture is revealed under one continuous fade.
    function fadeOutFirstLoad() {
      if (!loader || loader.className.indexOf('hidden') !== -1) return;
      firstLoadArmed = false;
      firstLoadFading = true;
      hideLoadSpinner();                                    // no circular loader over the fade
      loader.className = 'torrent-loader hidden';           // logo + text: 0.5 s
      if (curtain) curtain.className = 'tl-curtain hidden'; // black: 1 s
      firstLoadFadeTimer = setTimeout(function () {
        firstLoadFading = false; firstLoadFadeTimer = null;
      }, 1000);
    }
    // The small circular spinner belongs to the FIRST load only. Torrents use
    // the full-screen logo loader; after playback starts, nothing circular is
    // ever painted over the picture (seek, stall, next episode, etc.).
    function hideLoadSpinner() {
      load.className = 'loading';
      updateLoadPct(0);   // never leave a stale 100% for the next spinner
      if (seekLoadTimer) { clearTimeout(seekLoadTimer); seekLoadTimer = null; }
    }

    // The local server closes a paused AVPlay stream after its send timeout.
    // Reopen the same URL on a fresh connection and restore the exact frame;
    // this is what a manual replay used to do, without changing the UI.
    function reopenPlayer(pos, resume) {
      if (!player || !url) return false;
      if (player.isAvPlay && player.reopen) { player.reopen(pos, resume); return true; }
      try { player.src = url; player.load(); } catch (e) { return false; }
      var apply = function () {
        if (!player || layer.className.indexOf('hidden') !== -1) return;
        try { player.currentTime = pos; } catch (e) {}
        if (resume) { try { player.play(); } catch (e) {} }
      };
      player.addEventListener('loadedmetadata', apply);
      setTimeout(apply, 400);
      return true;
    }
    // The engine can stop while AVPlay is paused. Re-send the same torrent with
    // its peer sources so the local HTTP server comes back before we reopen.
    function rearmEngine() {
      if (!opts.infoHash || !window.Engine || !Engine.start) return false;
      try {
        Engine.start(opts.infoHash, opts.fileIdx, opts.sources || [], opts.fileName || '');
        return true;
      } catch (e) { return false; }
    }
    function engineIsStarted() {
      try { return !!(window.Engine && Engine.getInfo && Engine.getInfo().engineStarted); }
      catch (e) { return false; }
    }
    // Android-style pause: keep the torrent/HTTP server alive for 15 minutes.
    // Only after that do we stop the engine; pressing Play then needs a fresh
    // head buffer and shows a spinner that only ever climbs to 100%.
    function armPauseStop() {
      if (!opts.infoHash) return;
      if (pauseStopTimer) { clearTimeout(pauseStopTimer); pauseStopTimer = null; }
      pauseStopTimer = setTimeout(function () {
        pauseStopTimer = null;
        if (!player || !player.paused || layer.className.indexOf('hidden') !== -1) return;
        pausedTooLong = true;
        lastStats = null;
        try { if (window.Engine && Engine.stop) Engine.stop(); } catch (e) {}
        remoteLog('pause-stop', { afterMs: pausedAt ? Date.now() - pausedAt : 0 }, true);
      }, PAUSE_KEEP_MS);
    }
    function clearPauseStop() {
      if (pauseStopTimer) { clearTimeout(pauseStopTimer); pauseStopTimer = null; }
    }
    function beginResumeWarmup(pos) {
      var wasStarted = engineIsStarted();
      // Android-style restart: the fresh engine starts its counter at zero.
      // From here on updateResumeWarmup() only ever increases the number.
      resumeWarmup = { pos: pos, pct: 0, started: false };
      remoteLog('resume-pct', { pct: 0, engineWasOn: wasStarted }, true);
      beginWarmup(180000);          // spinner up while the fresh head buffer arrives
      showBufferLoad(true);
      updateLoadPct(resumeWarmup.pct);
      rearmEngine();
      remoteLog('resume-warm', { pos: pos, pauseMs: pausedAt ? Date.now() - pausedAt : 0,
        engineWasOn: wasStarted }, true);
    }
    // Called from the stats poll while the post-15-minute spinner is up. Every
    // value is clamped to the previous one, so the number never falls back.
    function updateResumeWarmup(d) {
      if (!resumeWarmup || !d) return;
      var target = (d.streamLen && isFinite(d.streamLen) && d.streamLen > 0) ?
        Math.min(START_BYTES, d.streamLen) : START_BYTES;
      var bytes = Math.max(d.downloaded || 0, Math.min((d.blocksRx || 0) * 16384, target));
      var pct = bytes / target * 100;
      if (!isFinite(pct) || pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      if (pct < resumeWarmup.pct) pct = resumeWarmup.pct;
      resumeWarmup.pct = pct;
      updateLoadPct(pct);
      if (pct < 100 || resumeWarmup.started) return;
      resumeWarmup.started = true;
      var at = resumeWarmup.pos;
      resumeWarmup = null;
      remoteLog('resume-ready', { pos: at, bytes: bytes, target: target }, true);
      endWarmup();
      hideLoadSpinner();
      if (usingAvPlay) reopenPlayer(at, true);
      else {
        try {
          player.src = url; player.load();
          player.currentTime = at; player.play();
        } catch (e) {}
      }
      setPpIcon('pause');
      showOsd();
    }

    // One entry point for the hardware Play/Pause key and the on-screen button.
    // Never leave a half-finished scrub behind when toggling playback.
    function togglePlayback() {
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      if (scrubbing) commitSeek();
      var wasPaused = !!player.paused, pos = player.currentTime || 0;
      if (wasPaused) {
        clearPauseStop();   // the user came back before/within the 15-minute window
        var pausedMs = pausedAt ? Date.now() - pausedAt : 0;
        if (opts.infoHash && (pausedTooLong || pausedMs >= PAUSE_KEEP_MS)) {
          // Engine was stopped after 15 minutes: warm a fresh head buffer with
          // a monotonic 0→100% spinner, then resume automatically.
          beginResumeWarmup(pos);
        } else if (usingAvPlay && pausedMs >= PAUSE_SOFT_MS) {
          // Within the 15-minute window: engine and pieces are still alive.
          // Reopen the dead AVPlay range request silently so Play lands in film.
          reopenPlayer(pos, true);
        } else { try { player.play(); } catch (e) {} }
        setPpIcon('pause');   // pause art goes when the controls hide, together
      } else {
        try { player.pause(); } catch (e) {}
        armPauseStop();   // keep the torrent/HTTP server alive for 15 minutes
        setPpIcon('play'); showPauseArt();
      }
      remoteLog('toggle', { from: wasPaused ? 'paused' : 'playing', av: !!usingAvPlay,
        pausedMs: wasPaused ? (pausedAt ? Date.now() - pausedAt : 0) : 0,
        warm: !!(wasPaused && resumeWarmup) });
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
      endWarmup();
      seekPending = true; seekFrom = -1;
      hideLoadSpinner();
      // Rewinding only needs a native seekTo inside the range already open on
      // the local server. Reopening restarted the file at byte 0 and produced
      // AVPlay decode errors after the wait.
      var backward = sec < 0, reopened = false;
      if (!backward && usingAvPlay) reopened = reopenPlayer(t, true);
      if (!reopened) {
        try { player.currentTime = t; } catch (e) {}
        if (player.paused) { try { player.play(); } catch (e) {} }
      }
      setPpIcon('pause');
      remoteLog('jump', { sec: sec, target: t, paused: player.paused,
        backward: backward, reopened: reopened });
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
      var disabled = b && b.getAttribute('data-disabled') === '1';
      if (id && b && b.onclick && !disabled) b.onclick();
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
        // OK with hidden controls pauses/plays and parks focus on the button
        // that performed the action, so the next OK press is predictable.
        var pp = U.qs('#pp', layer);
        if (pp) Focus.set(pp);
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
    var firstLoadArmed = false, firstLoadFading = false, fadeFromTime = 0;
    // Direct streams: small spinner only until the first frame. Torrents: the
    // logo loader is the only loading UI, so the spinner stays hidden.
    if (loader) hideLoadSpinner();
    else { load.className = 'loading show'; updateLoadPct(0); }

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
    // Percentage shown inside the circular loader while the picture is waiting.
    // Torrent playback uses the engine's buffer-at-current-position value;
    // direct streams fall back to the browser's buffered range.
    function updateLoadPct(pct) {
      var el = U.qs('#load-pct', layer);
      if (!el) return;
      pct = Number(pct);
      if (!isFinite(pct)) pct = bufferedPct();
      pct = Math.max(0, Math.min(100, Math.round(pct)));
      if (resumeWarmup && pct < resumeWarmup.pct) pct = resumeWarmup.pct;
      setHtml(el, pct + '%');
    }
    function showBufferLoad(force) {
      if (!player || layer.className.indexOf('hidden') !== -1) return;
      if (firstLoadFading && !force) return;   // fade straight into the picture, no spinner
      if (!videoStarted || (player.paused && !force)) return;   // first-load art owns the screen
      if (loader && loader.className.indexOf('hidden') === -1) return;
      load.className = 'loading show';
      updateLoadPct(0);   // always start at 0 while spinning; real stats arrive next
    }
    // Resuming after a long pause needs a fresh local connection, and the
    // engine may need tens of seconds to assemble the pieces at that position.
    // Keep the circular loader up for that whole window and never let the
    // stall watchdog seek/close the connection while it is warming up: that
    // seek is what turns a slow refill into AVPlay CONNECTION_FAILED.
    var warmupUntil = 0;
    function beginWarmup(ms) {
      warmupUntil = Date.now() + (ms || 30000);
      showBufferLoad(true);
      updateLoadPct(0);   // the pre-pause 100% is stale; wait for fresh stats
    }
    function warmingUp() { return Date.now() < warmupUntil; }
    function endWarmup() { warmupUntil = 0; }
    // A seek can buffer without AVPlay raising 'waiting'. If the picture has
    // not moved on shortly after the seek, show the same circular loader.
    function armSeekBufferLoad() {
      if (seekLoadTimer) { clearTimeout(seekLoadTimer); seekLoadTimer = null; }
      if (!videoStarted) return;
      seekLoadTimer = setTimeout(function () {
        seekLoadTimer = null;
        if (!seekPending || !player || player.paused) return;
        showBufferLoad();
      }, 150);
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
        paintBuffered();   // light-purple ready range on the seek bar
        // Inside the round loader (seek / buffering): how much of the data
        // needed at the current spot has arrived. Never prefill the hidden
        // loader, or it opens on a stale 100% from the first-load buffer.
        if (load.className.indexOf('show') !== -1) {
          if (resumeWarmup) updateResumeWarmup(d);   // monotonic fresh-buffer fill
          else updateLoadPct(d.bufPct);
        }
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
      if (warmingUp()) {
        // A reopened stream can stall for a long time while the engine fetches
        // the new range. A backward seek here closes that HTTP connection and
        // AVPlay then fails with CONNECTION_FAILED. Just keep the loader up.
        showBufferLoad(true);
        lastProgressTime = t; lastProgressAt = Date.now();
        return;
      }
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
        if (!reopenPlayer(t, true)) {
          try { player.src = url; player.load(); player.play(); } catch (e) {}
        }
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
      if (load.className.indexOf('show') !== -1 && !resumeWarmup)
        updateLoadPct(lastStats && lastStats.bufPct != null ? lastStats.bufPct : bufferedPct());
      if (!statsTimer) setLoaderPct(bufferedPct());   // fallback when bridge is down
    });
    player.addEventListener('playing', function () {
      subtitlePlaybackStarted = true;
      clearPauseStop();
      pausedTooLong = false;
      pausedAt = 0; avRecoveries = 0;
      // AVPlay emits 'playing' as soon as play() is requested, which can be
      // long before the reopened range has any data. Never clear seekPending
      // here: the loader must stay up until the clock actually moves (handled
      // in timeupdate), otherwise a backward seek shows a bare black screen.
      setPpIcon('pause');   // the native player may have corrected the state
      updateSubtitle();
      hidePauseArt();       // pause art is never shown over a playing picture
      if (!seekPending && !warmingUp()) hideLoadSpinner();   // wait for real frames
      if (loader) {
        firstPlay = false;
        // AVPlay raises 'playing' as soon as play() is requested, often before
        // the first real frame. Arm the fade and commit it when the clock
        // actually advances; the timer is the fallback without a timeupdate.
        firstLoadArmed = true; fadeFromTime = 0;
        if (firstLoadArmTimer) { clearTimeout(firstLoadArmTimer); firstLoadArmTimer = null; }
        firstLoadArmTimer = setTimeout(function () {
          firstLoadArmTimer = null;
          if (firstLoadArmed) fadeOutFirstLoad();
        }, 400);
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
      // The picture ran dry after playback started: bring back the circular
      // loader with the buffer percentage inside it.
      showBufferLoad();
    });
    player.addEventListener('pause', function () {
      pausedAt = Date.now();
      resumeWarmup = null;
      pausedTooLong = false;
      armPauseStop();
      endWarmup();
      seekPending = false;
      setPpIcon('play');
      hideLoadSpinner();   // pause art, not a buffering spinner
      showPauseArt();
      updateSubtitle();   // pause art replaces the subtitle line immediately
      showOsd();   // controls stay on screen for as long as the video is paused
    });
    // Skipping forward jumps to a position the player has not fetched yet.
    // Show the spinner and keep it up until data at the new spot is ready.
    var seekPending = false, seekFrom = 0, lastBufferLoadAt = 0;
    function hideSeekLoad() {
      if (!seekPending) return;
      seekPending = false;
      endWarmup();
      hideLoadSpinner();
    }
    player.addEventListener('seeking', function () {
      if (firstPlay) return;
      seekPending = true; seekFrom = -1;
      // A long-pause reopen performs its own seek internally. Its spinner is
      // already up and must stay up until this new range really advances.
      if (!warmingUp()) {
        hideLoadSpinner();
        // Keep the pending-seek guard until the new spot actually advances. If
        // the seek turns into a real buffer stall, 'waiting' brings the circular
        // loader back with its percentage.
        armSeekBufferLoad();
      }
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
      if (firstLoadArmed && player && !player.paused && playing) {
        var nowT = player.currentTime || 0;
        if (!fadeFromTime) fadeFromTime = nowT;
        else if (nowT - fadeFromTime >= 0.1) fadeOutFirstLoad();
      }
      if (load.className.indexOf('show') !== -1) {
        if (resumeWarmup) updateResumeWarmup(lastStats);
        else updateLoadPct(lastStats && lastStats.bufPct != null ? lastStats.bufPct : bufferedPct());
        // The picture is actually advancing again: drop the buffering spinner
        // even if AVPlay never raised 'playing' after the stall. Never do this
        // mid post-pause warmup: the 100% value owns that spinner.
        if (!resumeWarmup && !seekPending && player && !player.paused &&
            player.currentTime - lastBufferLoadAt >= 1) {
          endWarmup();          // at least a second of real frames: refill done
          hideLoadSpinner();
        }
      }
      lastBufferLoadAt = player ? (player.currentTime || 0) : 0;
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
        ready: lastStats && lastStats.ready, streamLen: lastStats && lastStats.streamLen }, true);
      // The browser <video> could not decode this file: hand the same on-TV
      // URL to Samsung's native AVPlay pipeline (MKV, HEVC, AC3, ...).
      if (player === htmlVideo && switchToAvPlay()) return;
      // AVPlay code 4 after a long pause or a seek is a dead local HTTP
      // connection, not a decode failure. Recover at the same frame instead
      // of making the user replay the stream. Never do this during the first
      // load, where code 4 can be a real unsupported-format error.
      if (usingAvPlay && videoStarted && !firstPlay &&
          ((err.code || 0) === 4 || /CONNECTION_FAILED/i.test(err.message || '')) && avRecoveries < 2) {
        avRecoveries++;
        var at = player.currentTime || 0, resume = !player.paused;
        // Never leave a black frame after the error: the loader stays up while
        // a fresh connection is made and the range is assembled again.
        beginWarmup(30000);
        var engineOn = true;
        try { if (window.Engine && Engine.getInfo) engineOn = !!Engine.getInfo().engineStarted; } catch (e) {}
        // If the engine stopped while paused, restart it and give its HTTP
        // server time to bind before asking AVPlay to open the stream again.
        if (!engineOn) rearmEngine();
        remoteLog('av-recover', { attempt: avRecoveries, at: at, resume: resume,
          rearm: !engineOn, bufPct: lastStats && lastStats.bufPct }, true);
        setTimeout(function () {
          if (!player || layer.className.indexOf('hidden') !== -1) return;
          showBufferLoad(true);
          if (reopenPlayer(at, resume)) reclaimRemoteFocus(true);
        }, engineOn ? 800 : 1200);
        return;
      }
      load.className = 'loading';
      updateLoadPct(0);
      if (loader) { fadeOutFirstLoad(); stopStatsPolling(); }
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
        paintBuffered();
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
        if (!reopenPlayer(t, !wasPaused)) {
          try { player.src = url; player.load(); if (!wasPaused) player.play(); } catch (e) {}
        }
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
    var audioBtn = U.qs('#audio', layer);
    var showAudioBtn = audioVariantCount(currentStream) > 1;
    if (audioBtn && showAudioBtn) {
      audioBtn.onclick = function () { playerMenu('Audio', [{ label: 'Default', fn: function () {} }]); };
    } else if (audioBtn && audioBtn.parentNode) {
      audioBtn.parentNode.removeChild(audioBtn);
    }
    function gotoEpisode(id, dir) {
      if (!id) { toast(dir === 'prev' ? 'No previous episode' : 'No next episode'); return; }
      remoteLog('episodenav', { dir: dir, id: id });
      stopPlayer();
      layer.className = 'layer hidden';
      openMeta(id, 'series', { fromContinue: true });
    }
    // Both episode buttons use the same direct binge path as the end-of-episode
    // prompt: pick the stream in advance, never send the user to the torrent
    // list. Same torrent first, then the bingeGroup, then the best source.
    var epStreams = {
      next: { stream: null, resolving: false, waiters: [] },
      prev: { stream: null, resolving: false, waiters: [] }
    };
    function resolveEpisode(dir, cb) {
      var st = epStreams[dir], id = dir === 'next' ? opts.nextId : opts.prevId;
      if (!id) { if (cb) cb(null); return; }
      if (st.stream) { if (cb) cb(st.stream); return; }
      if (cb) st.waiters.push(cb);
      if (st.resolving) return;
      st.resolving = true;
      API.getStreams('series', id, function (list) {
        list = list || [];
        var cur = currentStream || {}, bg = cur.behaviorHints && cur.behaviorHints.bingeGroup, pick = null, i;
        for (i = 0; i < list.length && !pick; i++) if (opts.infoHash && API.infoHash(list[i]) === opts.infoHash) pick = list[i];
        for (i = 0; i < list.length && !pick && bg; i++) if (list[i].behaviorHints && list[i].behaviorHints.bingeGroup === bg) pick = list[i];
        for (i = 0; i < list.length && !pick; i++) if (API.streamUrl(list[i])) pick = list[i];
        st.stream = pick;
        var w = st.waiters; st.waiters = [];
        for (i = 0; i < w.length; i++) w[i](pick);
      });
    }
    var preloadAsked = false;
    function preloadNext() {
      if (preloadAsked || !opts.nextId) return;
      preloadAsked = true;
      resolveEpisode('next', function (s) {
        if (!s || !player || layer.className.indexOf('hidden') !== -1) return;
        var same = !!opts.infoHash && API.infoHash(s) === opts.infoHash;
        remoteLog('preload', { nextId: opts.nextId, sameTorrent: same, fileIdx: API.fileIdx(s) });
        if (same && window.Engine && Engine.prefetch) Engine.prefetch(API.fileIdx(s));
      });
    }
    nextEpisodeHooks = { preload: preloadNext };
    function playAdjacentNow(dir, id, missing) {
      if (!id) { toast(missing); return; }
      nextAutoFired = true;
      var watchedId = opts.videoId || opts.id;
      if (watchedId) API.markWatched(watchedId, true);
      if (saveProgressNow) { try { saveProgressNow(); } catch (e) {} }
      hideLoadSpinner();
      resolveEpisode(dir, function (s) {
        if (!s) { gotoEpisode(id, dir); return; }    // no source: only then show the list
        var meta = playerData || {}, v = null, vs = meta.videos || [];
        for (var i = 0; i < vs.length; i++) if (vs[i].id === id) v = vs[i];
        // Same title format as the stream list and Continue Watching.
        var title = Views.displayTitle ? Views.displayTitle(meta, id) :
          ((meta.name || '') + (v ? ' \u2014 S' + v.season + ' E' + v.episode : ''));
        var sameTorrent = !!opts.infoHash && API.infoHash(s) === opts.infoHash;
        remoteLog('episodenav', { dir: dir + '-direct', id: id, sameTorrent: sameTorrent });
        stopPlayer(sameTorrent);
        playStream(s, meta, { title: title, videoId: id, progressId: opts.id, mediaType: 'series' });
      });
    }
    function playNextNow() { playAdjacentNow('next', opts.nextId, 'No next episode'); }
    function playPrevNow() { playAdjacentNow('prev', opts.prevId, 'No previous episode'); }
    U.qs('#prev-ep', layer).onclick = playPrevNow;
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
    //   UP      -> from a button: seek bar; from seek bar: Next Episode or close
    //   DOWN    -> control row (Play/Pause from the seek bar)
    //   OK      -> activate the focused control
    var btnOrder = ['pp', 'prev-ep', 'next-ep-btn', 'subtitles'];
    if (showAudioBtn) btnOrder.push('audio');
    var ctrlOrder = ['seek'].concat(btnOrder).concat(['next-ep-action']);
    // Up from a control button parks on the seek bar; Down returns to the
    // button the user came from instead of always jumping to Play/Pause.
    var lastControlFocus = null;
    function isControlButton(el) {
      if (!el || !el.id) return false;
      if (el.id === 'next-ep-action') return true;
      for (var i = 0; i < btnOrder.length; i++) if (btnOrder[i] === el.id) return true;
      return false;
    }
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
        scrubStart = seekTarget;
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
        // Up from the seek bar returns to the Next Episode button even after
        // the controller has auto-hidden; it must not merely reveal the bar.
        if (k === 38 && nextShowing && Focus.get() === seekEl && na) {
          Focus.set(na);
          hideOsd();
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
          if (onSeek) {
            // Return to the button that was focused before going Up.
            var back = (lastControlFocus && layer.contains(lastControlFocus) &&
              lastControlFocus.offsetParent !== null) ? lastControlFocus : U.qs('#pp', layer);
            if (back) Focus.set(back);
          }
          return true;
        }
        // Up from any control button lands on the seek bar, like Android TV.
        if (!onSeek) {
          if (isControlButton(cf)) lastControlFocus = cf;
          Focus.set(seekEl);
          showOsd();
          return true;
        }
        // Up from the seek bar goes to the Next Episode action when it is on
        // screen; otherwise it closes the controller.
        if (nextShowing && na) {
          Focus.set(na); hideOsd(); return true;
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
    // Every drawer is opaque and fills the full screen height; only the
    // horizontal step changes as submenus stack to the left.
    panel.style.right = (level * 406) + 'px';
    panel.style.top = '0px';
    panel.style.bottom = '0px';
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
    if (nb) nb.style.bottom = controlsOpen ? '250px' : '60px';
  }
  function hideOsd() {
    var osd = U.qs('#osd');
    if (osd) osd.style.opacity = '0';
    // Pause art leaves with the controller, not earlier on Play. The hook
    // ignores calls while still paused, so paused artwork stays until resume.
    if (hidePauseArtWithControls) { try { hidePauseArtWithControls(); } catch (e) {} }
    // A focused control must not keep the controller alive. Drop focus when
    // the timer expires (or Up hides it) so OK goes back to Play/Pause.
    if (osd && osd.contains && Focus.get() && osd.contains(Focus.get())) Focus.clear();
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
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    // Paused video keeps its controls; only a playing picture auto-hides them.
    if (player && player.paused) return;
    osdTimer = setTimeout(function () {
      // Use hideOsd() so the Up-next card drops back to its resting corner
      // whenever the controller disappears, not only on an explicit key.
      hideOsd();
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
    if (seekLoadTimer) { clearTimeout(seekLoadTimer); seekLoadTimer = null; }
    if (firstLoadArmTimer) { clearTimeout(firstLoadArmTimer); firstLoadArmTimer = null; }
    if (firstLoadFadeTimer) { clearTimeout(firstLoadFadeTimer); firstLoadFadeTimer = null; }
    if (seekKeyupHandler) { document.removeEventListener('keyup', seekKeyupHandler, false); seekKeyupHandler = null; }
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    if (pauseStopHook) { try { pauseStopHook(); } catch (e) {} pauseStopHook = null; }
    stopPlayerClock();
    if (clearPausedLogo) { try { clearPausedLogo(); } catch (e) {} clearPausedLogo = null; }
    hidePauseArtWithControls = null;
    subtitlePlaybackStarted = false;
    Focus.onKey(null);
    playerToggle = null; playerJump = null; playerStop = null; playerInfo = null;
    playerMute = null; playerVolume = null; playerStep = null; playerOk = null;
    playerMenuReturnFocus = null; playerMenuStack = []; playerMenuFocusStack = [];
    playerMenuTitle = ''; playerMenuRows = null; playerMenuFocus = 0; playerMenuRenderId++;
    stopStatsPolling();
    stopStallWatch();
    // Going straight to the next episode keeps the engine (peers, metadata and
    // the pre-loaded pieces); playStream() then switches its file.
    if (window.Engine && !keepEngine) {
      try { window.Engine.stop(); }
      catch (e) { remoteLog('engine-stop-error', { message: String((e && e.message) || e) }, true); }
    }
    var p = player;
    player = null;   // first, so late 'error' events from the old player are ignored
    if (p) {
      if (p.isAvPlay) { try { p.destroy(); } catch (e) {} }
      else { try { p.pause(); p.removeAttribute('src'); p.load(); } catch (e) {} }
    }
    document.documentElement.className = document.documentElement.className.replace(/\s*avplay-active/g, '');
    document.body.className = document.body.className.replace(/\s*avplay-active/g, '');
    remoteLog = function () {};
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
        // AVPlay can hold native focus just for the media keys. Pull it back
        // before acting so Play/Pause is never swallowed by the plugin.
        reclaimRemoteFocus(true);
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
      else if (isBackKey(k)) {
        handlePlayerBack(k);
        handled = true;
      } else if (k === 13 && playerOk && playerOk(k, e)) {
        handled = true;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // Some Tizen firmware sends Back only on keyup while AVPlay owns focus.
    // The debounce handlePlayerBack() uses makes this a safe fallback.
    document.addEventListener('keyup', function (e) {
      if (isBackKey(e.keyCode)) {
        handlePlayerBack(e.keyCode);
        e.preventDefault(); e.stopPropagation();
      }
    }, true);
    // Re-check every 2 s: if AVPlay or the NaCl embed takes native focus,
    // keydown never reaches the document and the TV looks completely frozen.
    if (!focusReclaimTimer) focusReclaimTimer = setInterval(function () {
      reclaimRemoteFocus(false);
    }, 2000);
    setTimeout(function () {
      U.qs('#splash').style.display = 'none';
      U.qs('#app').style.display = 'block';
      // Show the Home screen immediately; its skeleton stays up until the
      // account data and the first shelves are all ready.
      var au = API.auth();
      if (au && au.authKey) {
        holdHomeLoading();
        var ready = 0;
        function oneReady() { if (++ready >= 2) markHomeDataReady(); }
        API.syncLibrary(au.authKey, oneReady, oneReady);
        API.userAddons(au.authKey, function (list) {
          if (list.length) API.saveAddons(list);
          oneReady();
        }, oneReady);
        setTimeout(markHomeDataReady, 9000);   // a dead account must not block the TV
      } else {
        markHomeDataReady();
      }
      navigate('board', { firstOpen: true });
    }, 700);
  }

  return { init: init, navigate: navigate, back: back, openMeta: openMeta, openStreams: openStreams,
    rememberSeriesTab: rememberSeriesTab, continueWatching: continueWatching,
    playUrl: playUrl, playStream: playStream, toast: toast, installAddon: installAddon,
    modal: modal, closeLayers: closeLayers, textInput: textInput,
    account: account, updateProfile: updateProfile, syncAddons: syncAddons, syncLibrary: syncLibrary,
    holdHomeLoading: holdHomeLoading, releaseHomeLoading: releaseHomeLoading,
    whenHomeDataReady: whenHomeDataReady,
    SUB_COLORS: SUB_COLORS, subtitleColorName: colorName,
    applySubtitleSettings: applySubtitleSettings,
    subSyncText: function () { return subSyncLabel(subOffset); },
    subSyncBy: adjustSubOffset,
    subSyncSet: function (v) { setSubOffset(v, true); toast('Subtitle sync: ' + subSyncLabel(subOffset)); } };
})();

document.addEventListener('DOMContentLoaded', function () { App.init(); });

/* views.js — screens, rebuilt from the Android TV APK layout spec */
var Views = (function () {

  function clear(box) { while (box.firstChild) box.removeChild(box.firstChild); }
  // The title currently shown in the info bar — used by "Mark as Watched".
  var infoItem = null;

  // Persistent info bar: selected movie's text in the top-left. Shared across all pages.
  // Catalog rows often carry only a name and poster. For the focused title,
  // fetch the full addon meta once (cached) and show the same details as the
  // title's page: year, runtime, seasons, rating, genres, plot, director, cast.
  var metaInfoCache = {}, metaInfoTimer = null, infoKey = '';
  function linkNames(m, category) {
    var out = [], l = m.links || [];
    for (var i = 0; i < l.length; i++) if (l[i] && l[i].category === category && l[i].name) out.push(l[i].name);
    return out;
  }
  function mergeMeta(item, m) {
    var o = {}, k;
    for (k in item) if (item.hasOwnProperty(k)) o[k] = item[k];
    function pick(f, v) {
      if (v === undefined || v === null || v === '') return;
      if (v.length === 0) return;
      o[f] = v;
    }
    pick('name', m.name);
    pick('description', m.description);
    pick('imdbRating', m.imdbRating);
    pick('releaseInfo', m.releaseInfo || m.year);
    pick('runtime', m.runtime);
    pick('genres', (m.genres && m.genres.length) ? m.genres : (m.genre || linkNames(m, 'Genres')));
    pick('cast', (m.cast && m.cast.length) ? m.cast : linkNames(m, 'Cast'));
    pick('director', (m.director && m.director.length) ? m.director : linkNames(m, 'Directors'));
    pick('country', m.country);
    pick('awards', m.awards);
    if (m.videos && m.videos.length) {
      var seen = {}, n = 0;
      for (var i = 0; i < m.videos.length; i++) {
        var sn = m.videos[i] && m.videos[i].season;
        if (sn > 0 && !seen[sn]) { seen[sn] = 1; n++; }
      }
      if (n) o.seasons = n;
    }
    o._full = true;
    return o;
  }
  function enrichInfoBar(item) {
    if (!item || !item.id || item._full) return;
    var type = item.type || 'movie', key = type + '|' + item.id;
    infoKey = key;
    if (metaInfoCache[key]) { setInfoBar(mergeMeta(item, metaInfoCache[key])); return; }
    if (metaInfoTimer) clearTimeout(metaInfoTimer);
    // Short delay so scrolling quickly along a row doesn't fire a request per card.
    metaInfoTimer = setTimeout(function () {
      API.getMeta(type, item.id, function (d) {
        var m = d && d.meta;
        if (!m) return;
        metaInfoCache[key] = m;
        if (infoKey === key) setInfoBar(mergeMeta(item, m));
      }, function () {});
    }, 250);
  }
  /* Extra movie info (OMDb / TMDB, optional): rating badges, tagline,
     budget / box office. Shared by the info bar, the details page and the
     setup preview. */
  function fmtMoney(v) {
    if (typeof v === 'string') v = parseInt(v.replace(/[^\d]/g, ''), 10);
    if (!v || v < 1) return '';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    return '$' + Math.round(v / 1e3) + 'K';
  }
  function ratingBadges(x, imdbRating) {
    var h = '', ir = (x && x.imdbRating) || imdbRating;
    if (ir) h += '<span class="rb rb-imdb"><b>IMDb</b>' + U.esc(ir) + '</span>';
    if (x && x.rt) h += '<span class="rb rb-rt"><b>ROTTEN</b>' + U.esc(x.rt) + '</span>';
    if (x && x.meta) h += '<span class="rb rb-mc"><b>META</b>' + U.esc(x.meta) + '</span>';
    if (x && x.tmdbScore) h += '<span class="rb rb-tmdb"><b>TMDB</b>' + U.esc(x.tmdbScore) + '</span>';
    return h;
  }
  function moneyBits(x, awards) {
    var out = [];
    if (x && x.budget) out.push('Budget <span>' + fmtMoney(x.budget) + '</span>');
    var bo = x && (x.revenue || x.boxOffice);
    if (bo && fmtMoney(bo)) out.push('Box office <span>' + fmtMoney(bo) + '</span>');
    var aw = (x && x.awards) || awards;
    if (aw) out.push(U.esc(String(aw).split(/\.\s/)[0].replace(/\.$/, '')));   // "Won 4 Oscars"
    return out;
  }
  function extraBlock(x, imdbRating) {
    if (!x) return '';
    var r = ratingBadges(x, imdbRating), m = moneyBits(x, '');
    return (x.tagline ? '<div class="ib-tagline">“' + U.esc(x.tagline) + '”</div>' : '') +
      (r ? '<div class="ib-ratings">' + r + '</div>' : '') +
      (m.length ? '<div class="ib-money">' + m.join('  •  ') + '</div>' : '');
  }
  var extraTimer = null;
  // Fill the reserved lines in place. Re-rendering the whole info bar here made
  // the IMDb badges appear only AFTER the description and pushed it down.
  function fillExtraSlots(item, x) {
    if (!item || item !== infoItem) return;
    var info = U.qs('#ib-info');
    if (!info) return;
    var tl = info.querySelector('.ib-tagline');
    if (tl) tl.innerHTML = x.tagline ? '\u201C' + U.esc(x.tagline) + '\u201D' : '';
    var rt = info.querySelector('.ib-ratings');
    if (rt) rt.innerHTML = ratingBadges(x, item.imdbRating);
    // Budget lives in the meta line so it is visible on every page, including
    // Discover's compact info bar where the lower "extra" line is suppressed.
    var budget = x.budget ? fmtMoney(x.budget) : '';
    var meta = info.querySelector('.ib-meta');
    if (meta && budget && meta.innerHTML.indexOf('Budget ') === -1) {
      meta.innerHTML += '  \u2022  Budget ' + budget;
    }
    var ex = info.querySelector('.ib-extra');
    if (ex) {
      var bits = moneyBits(x, item.awards);
      for (var b = bits.length - 1; b >= 0; b--) if (bits[b].indexOf('Budget ') === 0) bits.splice(b, 1);
      if (x.rated) bits.unshift(U.esc(x.rated));
      ex.innerHTML = bits.join('  \u2022  ');
    }
    info.className = 'ib-info' + (rt && rt.innerHTML ? ' has-ratings' : '');
  }
  function scheduleExtra(item) {
    var imdb = API.imdbOf(item.id || item.imdb_id);
    if (!imdb) return;
    if (extraTimer) clearTimeout(extraTimer);
    // Wait until focus settles so scrolling a row doesn't spend lookups.
    extraTimer = setTimeout(function () {
      API.extraInfo(imdb, item.type, function (x) {
        if (!x) return;
        var cur = infoItem;
        if (!cur || API.imdbOf(cur.id || cur.imdb_id) !== imdb) return;
        fillExtraSlots(cur, x);
      });
    }, 450);
  }
  function setInfoBar(item) {
    if (!item) return;
    infoItem = item;
    var info = U.qs('#ib-info');
    if (!info) return;
    var cached = API.extraCached(item.id || item.imdb_id);
    var x = cached || {};
    // If a lookup is going to happen, reserve its lines now. The IMDb badge is
    // already in the catalog data, so it is drawn with the description, never
    // after it.
    var pending = !cached && API.extraEnabled(item.id || item.imdb_id);
    var bits = [];
    if (item.releaseInfo) bits.push(item.releaseInfo);
    if (item.runtime) bits.push(item.runtime);
    if (item.seasons) bits.push(item.seasons + (item.seasons === 1 ? ' Season' : ' Seasons'));
    var genres = item.genres || [];
    if (typeof genres === 'string') genres = [genres];
    if (genres.length) bits.push(genres.slice(0, 3).join(', '));
    if (!bits.length) bits.push(item.type === 'series' ? 'Series' : (item.type === 'movie' ? 'Movie' : (item.type || '')));
    // Budget belongs in the always-visible meta line: Discover hides the lower
    // extra line, and a cached lookup never calls fillExtraSlots().
    if (x.budget && fmtMoney(x.budget)) bits.push('Budget ' + fmtMoney(x.budget));
    var tagline = x.tagline ? '\u201C' + U.esc(x.tagline) + '\u201D' : '';
    var ratings = ratingBadges(x, item.imdbRating);
    var extra = moneyBits(x, item.awards);
    for (var e = extra.length - 1; e >= 0; e--) if (extra[e].indexOf('Budget ') === 0) extra.splice(e, 1);
    if (x.rated) extra.unshift(U.esc(x.rated));
    if (!extra.length && item.country) extra.push(U.esc(item.country));
    var people = [];
    var dir = item.director || [];
    if (typeof dir === 'string') dir = [dir];
    if (dir.length) people.push('Director: ' + dir.slice(0, 2).join(', '));
    var cast = item.cast || [];
    if (typeof cast === 'string') cast = [cast];
    if (cast.length) people.push('Starring: ' + cast.slice(0, 4).join(', '));
    var tagHtml = (tagline || pending)
      ? '<div class="ib-tagline' + (pending ? ' ib-slot' : '') + '">' + tagline + '</div>' : '';
    var rateHtml = ratings ? '<div class="ib-ratings">' + ratings + '</div>'
      : (pending ? '<div class="ib-ratings ib-slot"></div>' : '');
    var extraHtml = (extra.length || pending)
      ? '<div class="ib-extra' + (pending ? ' ib-slot' : '') + '">' + extra.join('  \u2022  ') + '</div>' : '';
    info.className = 'ib-info' + (ratings ? ' has-ratings' : '');
    info.innerHTML =
      '<div class="ib-title' + (item.name && item.name.length > 24 ? ' small' : '') + '">' + U.esc(item.name || '') + '</div>' +
      '<div class="ib-meta">' + U.esc(bits.join('  \u2022  ')) + '</div>' +
      tagHtml + rateHtml +
      '<div class="ib-desc">' + U.esc(item.description || '') + '</div>' +
      extraHtml +
      (people.length ? '<div class="ib-cast">' + U.esc(people.join('  \u2022  ')) + '</div>' : '');
    if (!cached) scheduleExtra(item);
    if (!item._full) enrichInfoBar(item);
  }
  function clearInfoBar() {
    // Cancel in-flight detail lookups from the previous page. Without this a
    // late meta/enrich callback could re-render the info bar on Library, where
    // no title details should be shown at all.
    if (extraTimer) { clearTimeout(extraTimer); extraTimer = null; }
    if (metaInfoTimer) { clearTimeout(metaInfoTimer); metaInfoTimer = null; }
    infoKey = '';
    infoItem = null;
    var info = U.qs('#ib-info');
    if (info) info.innerHTML = '';
    var ibar = U.qs('#infobar');
    if (ibar) ibar.className = '';   // pages opt in to the compact (2-line) details
    setBackdrop('');   // pages set their own art when a title is focused / loaded
  }
  // Big full-screen movie art behind the content (Home tab only). Anchored
  // top-right by CSS and faded to the left/bottom.
  function setBackdrop(url) {
    var bd = U.qs('#backdrop');
    if (!bd) return;
    if (url) { bd.style.backgroundImage = 'url("' + U.attr(url) + '")'; bd.className = 'show'; }
    else { bd.style.backgroundImage = ''; bd.className = ''; }
  }
  function firstIn(container) {
    // If focus is on the nav bar (e.g. you just focused a tab), don't let a
    // late async catalog callback yank it into the page — Up must still walk
    // the nav bar. Entering the page is done explicitly with Right.
    var cur = Focus.get(), p = cur;
    while (p && p !== document.body) {
      if (p.id === 'sidebar') return;
      p = p.parentNode;
    }
    var list = Focus.candidates();
    for (var i = 0; i < list.length; i++) {
      if (container === list[i] || container.contains(list[i])) { Focus.set(list[i]); return; }
    }
  }

  // YouTube-TV-style loading state: full-page rows of placeholder cards in the
  // exact position the real cards will occupy, with a soft pulsing shimmer.
  function skeletonRows(container, count) {
    count = count || 7;
    var html = '', r, c;
    for (r = 0; r < count; r++) {
      html += '<div class="sk-row"><div class="sk sk-header"></div><div class="sk-track">';
      for (c = 0; c < 8; c++) {
        html += '<div class="sk-card"><div class="sk sk-poster"></div><div class="sk sk-name"></div></div>';
      }
      html += '</div></div>';
    }
    container.innerHTML = html;
    var blocks = container.querySelectorAll('.sk');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].style.animationDelay = ((i % 10) * 0.06) + 's';
    }
  }
  function skeletonHero(info) {
    if (info) info.innerHTML = '<div class="sk sk-hero-title"></div><div class="sk sk-hero-meta"></div>' +
      '<div class="sk sk-hero-desc"></div>';
  }

  function badgeItem(it, type) {
    var o = { id: it.id, type: type || it.type || 'movie', name: it.name, poster: it.poster,
      background: it.background || it.poster, logo: it.logo, runtime: it.runtime,
      releaseInfo: it.releaseInfo, imdbRating: it.imdbRating, genres: it.genres, cast: it.cast,
      description: it.description,
      // Series resume point (from the synced library).
      videoId: it.videoId || '', season: it.season, episode: it.episode };
    var w = API.watched()[it.id];
    if (w && !(o.type === 'series' && w === true)) o.watched = true;
    var p = API.progress(it.id);
    // Same rule as Continue Watching: started (20 s+) and not finished.
    if (p && p.pos >= 20 && !API.finished(p)) {
      o.progress = Math.max(1, p.pct);
      if (p.videoId && !it._resume) o.videoId = p.videoId;
    }
    // Continue Watching cards (in progress / next episode) keep their target.
    if (it._resume) { o._resume = true; o._at = it._at; if (it.videoId) o.videoId = it.videoId; }
    if (it.progress === 0) o.progress = 0;
    return o;
  }

  // The released episode after `vid` (season/episode order, specials skipped).
  function nextEpisode(m, vid) {
    var v = (m && m.videos) || [], list = [];
    for (var i = 0; i < v.length; i++) if (v[i] && Number(v[i].season) > 0) list.push(v[i]);
    list.sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode); });
    for (var j = 0; j < list.length; j++) {
      if (list[j].id !== vid) continue;
      var n = list[j + 1];
      if (!n) return null;
      if (n.released && Date.parse(n.released) > Date.now()) return null;   // not out yet
      return n;
    }
    return null;
  }

  // Vertical page indicator left of the shelves (Home / Discover): one dot per
  // category, the current one a taller white pill, centred on the posters.
  // Follows scrolling and rebuilds itself when rows are added or replaced.
  // Page indicator (Android TV style): one short line per shelf, stacked
  // vertically. The current shelf's line is long + purple and is pinned to the
  // vertical middle of the poster; the other lines slide past it. Exactly 2
  // opaque lines on each side, then 3 more fading out to transparent.
  // Pressing Up on the first shelf (or Down on the last) bounces the stack.
  var PAGER_GAP = 20, PAGER_SOLID = 2, PAGER_FADE = 3;
  function rowPager(page, scroll) {
    var pager = U.el('div', 'row-pager');
    var stack = U.el('div', 'rp-stack');
    pager.appendChild(stack);
    page.appendChild(pager);
    var lastN = -1, idx = 0, queued = false, list = [], bounceT = null;
    function rows() {
      var rws = scroll.querySelectorAll('.row'), out = [];
      for (var i = 0; i < rws.length; i++) if (rws[i].querySelector('.card')) out.push(rws[i]);
      return out;
    }
    function paint() {
      var ls = stack.children;
      for (var i = 0; i < ls.length; i++) {
        var d = Math.abs(i - idx), op;
        if (d <= PAGER_SOLID) op = 1;
        else if (d <= PAGER_SOLID + PAGER_FADE) op = (PAGER_SOLID + PAGER_FADE + 1 - d) / (PAGER_FADE + 1);
        else op = 0;
        ls[i].className = i === idx ? 'on' : '';
        ls[i].style.top = ((i - idx) * PAGER_GAP - 2) + 'px';
        ls[i].style.opacity = op;
      }
    }
    function update() {
      queued = false;
      if (!pager.parentNode) return;
      list = rows();
      var n = list.length, i;
      if (n < 2) { pager.style.display = 'none'; lastN = n; return; }
      pager.style.display = 'block';
      var sr = scroll.getBoundingClientRect(), best = 1e9, cur = 0;
      for (i = 0; i < n; i++) {
        var d = Math.abs(list[i].getBoundingClientRect().top - sr.top);
        if (d < best) { best = d; cur = i; }
      }
      if (n !== lastN) {
        var h = '';
        for (i = 0; i < n; i++) h += '<i></i>';
        stack.innerHTML = h; lastN = n;
      }
      idx = cur;
      paint();
      // Pin the stack's centre (the purple line) to the poster's middle.
      var pst = list[idx].querySelector('.poster'), pr = page.getBoundingClientRect();
      var cy = sr.top + 324;
      if (pst) { var r = pst.getBoundingClientRect(); cy = (r.top + r.bottom) / 2; }
      pager.style.top = Math.round(cy - pr.top) + 'px';
    }
    // Re-measure once more after the focus zoom / scroll animation settles.
    function later() { if (!queued) { queued = true; setTimeout(update, 0); setTimeout(update, 380); } }
    function bounce(dir) {
      stack.className = 'rp-stack';
      void stack.offsetWidth;                 // restart the animation
      stack.className = 'rp-stack ' + (dir < 0 ? 'rp-bounce-top' : 'rp-bounce-end');
      clearTimeout(bounceT);
      bounceT = setTimeout(function () { stack.className = 'rp-stack'; }, 420);
    }
    function onKey(e) {
      if (!pager.parentNode) { document.removeEventListener('keydown', onKey, true); return; }
      var k = e.keyCode;
      queued = false; later();                // focus zoom moves the poster a few px
      if (k !== 38 && k !== 40) return;
      var f = Focus.get();
      if (!f || !scroll.contains(f) || lastN < 2) return;
      list = rows();
      var r = f; while (r && r !== scroll && (' ' + r.className + ' ').indexOf(' row ') < 0) r = r.parentNode;
      var at = list.indexOf(r);
      if (k === 38 && at === 0) bounce(-1);
      else if (k === 40 && at === list.length - 1) bounce(1);
    }
    document.addEventListener('keydown', onKey, true);
    scroll.addEventListener('scroll', later);
    if (window.MutationObserver) new MutationObserver(later).observe(scroll, { childList: true, subtree: true });
    later(); setTimeout(update, 900);        // after the first card gets focus
    return update;
  }

  // Only the first few posters of a shelf are fetched up front. Android TV's
  // rows recycle views; on Tizen we get the same effect by leaving off-screen
  // posters as data-src and revealing more as the track scrolls or a card is
  // focused. The card footprint never changes, so the layout does not jump.
  function revealCardImage(card) {
    var im = card && card.querySelector ? card.querySelector('img[data-src]') : null;
    if (!im) return;
    im.src = im.getAttribute('data-src');
    im.removeAttribute('data-src');
  }
  function wireRowImages(track) {
    var imgs = track.querySelectorAll('img[data-src]'), shown = 0;
    function reveal(n) {
      for (var i = shown; i < imgs.length && i < n; i++) {
        var im = imgs[i];
        if (im.getAttribute('data-src')) {
          im.src = im.getAttribute('data-src');
          im.removeAttribute('data-src');
        }
      }
      if (n > shown) shown = n;
    }
    reveal(8);
    track.addEventListener('scroll', function () {
      var want = Math.min(imgs.length, Math.floor(track.scrollLeft / 335) + 10);
      if (want > shown) reveal(want);
    }, false);
  }
  // Keep the shimmer up until the first visible posters of a shelf have really
  // arrived. Without this the skeletons vanish and empty cards flash in their
  // place for a split second before the network images decode.
  function waitRowImages(row, done) {
    var imgs = row.querySelectorAll('.poster img'), tries = 0;
    function check() {
      if (!document.body.contains(row)) return;
      var ready = !imgs.length, i;
      for (i = 0; i < imgs.length && i < 8; i++) if (imgs[i].complete) { ready = true; break; }
      if (ready || ++tries >= 25) { done(); return; }   // 2 s ceiling
      setTimeout(check, 80);
    }
    setTimeout(check, 80);
  }
  function makeCard(item, type, onFocus) {
    var c = U.el('div', 'card');
    c.setAttribute('data-focus', '1');
    if (item.id) c.setAttribute('data-id', String(item.id));   // restore Discover focus
    c.innerHTML = U.posterHtml(item, true);
    if (item._resume) {
      // Continue Watching cards show a Play button and resume the last torrent.
      // Holding OK opens the torrent list for that movie/episode instead.
      c.className += ' cw-card';
      c.onlongok = function () {
        App.openMeta(item.videoId || item.id, item.type || type);
      };
      var po = c.querySelector('.poster');
      if (po) po.appendChild(U.el('span', 'cw-play'));
    }
    c.onclick = function () {
      // Continue Watching resumes the exact torrent played last time;
      // everywhere else (Library, catalogs) a show opens its page with season
      // tabs and the episode list.
      if (item._resume) App.continueWatching(item);
      else App.openMeta(item.id, item.type || type);
    };
    c.onfocusin = function () {
      revealCardImage(c);
      if (onFocus) onFocus(item);
    };
    return c;
  }

  function makeRow(title, items, type, onFocus) {
    var row = U.el('div', 'row');
    var h = U.el('div', 'row-header', U.esc(title));
    h.onclick = function () { App.toast(title); };
    row.appendChild(h);
    var track = U.el('div', 'row-track');
    for (var i = 0; i < items.length; i++) track.appendChild(makeCard(badgeItem(items[i], type), type, onFocus));
    wireRowImages(track);
    row.appendChild(track);
    return row;
  }

  /* ---------------- BOARD ---------------- */
  function board(box) {
    clear(box);
    // Same layout as Discover, without the filters: the selected title's
    // details (#infobar) stay fixed and only the shelves below them scroll.
    var page = U.el('div', 'page discover-page home-page');
    var scroll = U.el('div', 'rows-scroll home-scroll');
    scroll.setAttribute('data-fade-top', '0');
    var rows = U.el('div', 'rows');
    rows.id = 'rows';
    rows.style.marginTop = '0';
    skeletonRows(rows, 7);
    scroll.appendChild(rows);
    page.appendChild(scroll);
    box.appendChild(page);
    rowPager(page, scroll);
    Focus.setRoot(U.qs('#app'));

    var updateHero = function (item) {
      if (!item) return;
      setInfoBar(item);
      // Big backdrop is unique to Home; it follows the focused movie.
      setBackdrop(item.background || item.poster || item.logo);
    };

    // Continue Watching comes from local library/progress data, so it can be
    // drawn immediately while the first catalogs are still in flight.
    var saved = API.library(), progRows = [], upNext = [], cwRow = null;
    for (var i = 0; i < saved.length; i++) {
      var it = saved[i], p = API.progress(it.id);
      if (p && p.pos >= 20 && !API.finished(p)) {
        var o = badgeItem(it, it.type);
        o.progress = Math.max(1, p.pct); o._at = p.at || it.lastWatched || 0; o._resume = true;
        progRows.push(o);
      } else if (it.type === 'series' && ((p && p.videoId) || it.videoId)) {
        var localNewer = p && p.videoId && (p.at || 0) >= (it.lastWatched || 0);
        upNext.push({ item: it, lastVid: localNewer ? p.videoId : (it.videoId || p.videoId),
                      at: Math.max((p && p.at) || 0, it.lastWatched || 0) });
      }
    }
    function drawContinue() {
      // Most recently watched first, so movies and series interleave.
      progRows.sort(function (a, b) { return (b._at || 0) - (a._at || 0); });
      var focusIdx = -1, f = Focus.get();
      if (cwRow && f && cwRow.contains(f)) {
        var cs = cwRow.querySelectorAll('.card');
        for (var q = 0; q < cs.length; q++) if (cs[q] === f) focusIdx = q;
      }
      var fresh = progRows.length ? makeRow('Continue Watching', progRows, null, updateHero) : null;
      if (cwRow && cwRow.parentNode) {
        if (fresh) cwRow.parentNode.replaceChild(fresh, cwRow); else cwRow.parentNode.removeChild(cwRow);
      } else if (fresh) rows.insertBefore(fresh, rows.firstChild);
      cwRow = fresh;
      if (focusIdx >= 0 && fresh) {
        var nc = fresh.querySelectorAll('.card');
        if (nc.length) Focus.set(nc[Math.min(focusIdx, nc.length - 1)]);
      }
    }
    drawContinue();
    upNext.sort(function (a, b) { return b.at - a.at; });
    upNext = upNext.slice(0, 12);          // most recent shows only
    if (upNext.length) {
      var upLeft = upNext.length;
      function upDone() { if (--upLeft === 0) drawContinue(); }
      for (var u = 0; u < upNext.length; u++) {
        (function (un) {
          API.getMeta('series', un.item.id, function (d) {
            var nx = nextEpisode(d && d.meta, un.lastVid);
            if (nx) {
              var o2 = badgeItem(un.item, 'series');
              o2.videoId = nx.id; o2._resume = true; o2._at = un.at; o2.progress = 0;
              o2.name = (un.item.name || '') + '  \u2022  S' + nx.season + ' E' + nx.episode;
              progRows.push(o2);
            }
            upDone();
          }, upDone);
        })(upNext[u]);
      }
    }

    // Rows are drawn as each catalog answers, not after all of them. Android TV
    // does the same: 2 shelves at a time, queued when you approach the edge.
    var rendered = [], catRowEls = [], gaveFocus = false, morePending = false, libDone = false,
        libEl = null, skelDone = false;
    function dropSkeleton() {
      if (skelDone) return;
      skelDone = true;
      var sk = rows.querySelectorAll('.sk-row');
      for (var s = 0; s < sk.length; s++) rows.removeChild(sk[s]);
    }
    function appendRow(rd) {
      if (!rd || !document.body.contains(rows) || rendered.indexOf(rd) !== -1) return;
      rendered.push(rd);
      var el = makeRow(rd.title, rd.items, rd.type, updateHero);
      catRowEls.push(el);
      if (libEl && libEl.parentNode) rows.insertBefore(el, libEl); else rows.appendChild(el);
      waitRowImages(el, dropSkeleton);   // loader → images, never empty cards
      if (!gaveFocus) {
        gaveFocus = true;
        var first = progRows[0] || (rd.items && rd.items[0] ? badgeItem(rd.items[0], rd.type) : null);
        if (first) updateHero(first);
        firstIn(page);
      }
    }
    function addLibraryRow() {
      if (libDone) return;
      var libRow = [];
      for (var k = 0; k < saved.length && libRow.length < 20; k++) if (!saved[k].temp) libRow.push(saved[k]);
      if (libRow.length) {
        libDone = true;
        libEl = makeRow('My Library', libRow, null, updateHero);
        rows.appendChild(libEl);
      }
    }
    function loadMore() {
      if (morePending) return;
      morePending = true;
      API.moreCatalogRows(null, function () { morePending = false; });
    }
    function onMoreKey(e) {
      if (!document.body.contains(rows)) { document.removeEventListener('keydown', onMoreKey, false); return; }
      if (e.keyCode !== 40 || !catRowEls.length) return;   // Down only
      var f = Focus.get();
      if (!f || !rows.contains(f)) return;
      var r = f;
      while (r && r !== rows && (' ' + r.className + ' ').indexOf(' row ') < 0) r = r.parentNode;
      var at = catRowEls.indexOf(r);
      if (at >= 0 && at >= catRowEls.length - 2) loadMore();
    }
    document.addEventListener('keydown', onMoreKey, false);
    function startLoad() {
      if (!document.body.contains(rows)) return;
      API.catalogRows(null, function (data) {
        if (!document.body.contains(rows)) return;
        if (!data.length) {
          clear(rows);
          rows.innerHTML = '<div class="empty">No catalogs available. Check your addons in Settings.</div>';
          firstIn(page); return;
        }
        for (var j = 0; j < data.length; j++) appendRow(data[j]);
        addLibraryRow();
      }, appendRow);
    }
    // Always show the shelves of placeholders, even on a warm cache visit.
    // Android TV rebuilds its rows from state on every entry too.
    setTimeout(startLoad, 280);
  }

  /* ---------------- DISCOVER / LIBRARY ---------------- */
  var pickState = {};
  // Discover keeps its place across tab switches: only position/focus are
  // remembered, never the DOM shelves themselves (no page caching).
  var discSaved = { top: 0, id: '' }, discScrollEl = null, discRowsEl = null, discRestore = false;
  function picker(label, key, options, value, onChange) {
    var wrap = U.el('div', 'picker');
    wrap.innerHTML = '<span class="picker-label">' + U.esc(label) + '</span>' +
      '<span class="picker-value" data-focus="1">' + U.esc(value) + '</span>' +
      '<span class="picker-options"></span>';
    var val = U.qs('.picker-value', wrap);
    var opts = U.qs('.picker-options', wrap);
    var optEls = [];
    var currentValue = value;

    function markSelection() {
      for (var i = 0; i < optEls.length; i++) {
        var on = options[i] === currentValue;
        optEls[i].className = 'picker-opt' + (on ? ' selected' : '');
      }
    }
    function close() {
      opts.className = 'picker-options';
      for (var i = 0; i < optEls.length; i++) {
        optEls[i].className = optEls[i].className.replace(/\sfocused/g, '');
      }
    }
    function indexOfCurrent() {
      for (var i = 0; i < options.length; i++) if (options[i] === currentValue) return i;
      return 0;
    }

    for (var i = 0; i < options.length; i++) {
      (function (o) {
        var e = U.el('div', 'picker-opt', U.esc(o));
        e.setAttribute('data-focus', '1');
        e.onclick = function () {
          currentValue = o;
          val.innerHTML = U.esc(o);
          pickState[key] = o;
          close();
          markSelection();
          onChange(o);
          Focus.set(val);
        };
        opts.appendChild(e); optEls.push(e);
      })(options[i]);
    }
    markSelection();

    val.onclick = function () {
      if (opts.className.indexOf('open') !== -1) { close(); Focus.set(val); return; }
      // only one dropdown may be open, and only one option may be focused
      var others = U.qsa('.picker-options.open');
      for (var i = 0; i < others.length; i++) others[i].className = 'picker-options';
      var stale = U.qsa('.picker-options .focused');
      for (var j = 0; j < stale.length; j++) stale[j].className = stale[j].className.replace(/\sfocused/g, '');
      opts.className = 'picker-options open';
      markSelection();
      var idx = indexOfCurrent();
      setTimeout(function () { Focus.set(optEls[idx]); }, 30);
    };
    return wrap;
  }

  // Search / Library: no details area, but the focused title's art shows like on Home.
  function artFocus(item) {
    if (item) setBackdrop(item.background || item.poster || item.logo);
  }
  // Discover: focused title's details plus its art (with the same gradients as Home).
  function discoverFocus(item) {
    if (!item) return;
    setInfoBar(item);
    setBackdrop(item.background || item.poster || item.logo);
  }
  function discover(box, isLibrary) {
    // Leaving Discover: remember where the user was before this page wipes it.
    if (!isLibrary && discScrollEl && discRowsEl) {
      discSaved.top = discScrollEl.scrollTop || 0;
      var wasFocus = Focus.get();
      if (wasFocus && discRowsEl.contains(wasFocus) && wasFocus.getAttribute) {
        var wasId = wasFocus.getAttribute('data-id');
        if (wasId) discSaved.id = wasId;
      }
    }
    clear(box);
    clearInfoBar();    // filled once a card is focused on these pages
    if (!isLibrary) { var ibc = U.qs('#infobar'); if (ibc) ibc.className = 'ib-compact'; }
    var page = U.el('div', 'page discover-page');
    // Header (filters) stays pinned. The title/description live in the global
    // #infobar layer, so only the card shelves need to scroll vertically.
    var head = U.el('div', 'discover-head');
    var pickers = U.el('div', 'pickers');
    if (!isLibrary) head.appendChild(pickers);
    var scroll = U.el('div', 'rows-scroll');
    scroll.setAttribute('data-fade-top', '0');
    if (isLibrary) scroll.style.top = '60px';  // Library: shelves start 60 px from the top
    var rows = U.el('div', 'rows');
    rows.style.marginTop = '0';
    scroll.appendChild(rows);
    page.appendChild(head); page.appendChild(scroll);
    box.appendChild(page);
    if (!isLibrary) rowPager(page, scroll);
    Focus.setRoot(U.qs('#app'));
    if (!isLibrary) { discScrollEl = scroll; discRowsEl = rows; discRestore = true; }
    else { discScrollEl = null; discRowsEl = null; discRestore = false; }

    var types = ['All', 'movie', 'series'];
    var sorts = ['Popular', 'Top rated', 'Newest'];
    if (sorts.indexOf(pickState.dSort) < 0) pickState.dSort = 'Popular';
    var state = { type: pickState.dType || 'movie', sort: pickState.dSort, genre: pickState.dGenre || 'All' };
    var genres = ['All', 'Action', 'Adventure', 'Comedy', 'Drama', 'Horror', 'Sci-Fi', 'Thriller', 'Documentary'];

    function drawLibrary() {
      clear(rows);
      var list = API.library(), groups = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].temp) continue;      // watched-only entries live in Continue Watching
        var t = list[i].type || 'movie', g = null;
        for (var j = 0; j < groups.length; j++) if (groups[j].type === t) g = groups[j];
        if (!g) { g = { type: t, items: [] }; groups.push(g); }
        g.items.push(badgeItem(list[i], t));
      }
      var auth = API.auth();
      if (auth && auth.authKey) {
        groups.push({ type: 'sync', items: [{ id: '__sync__', name: 'Refresh from account', type: 'other' }] });
      }
      if (!groups.length) {
        rows.innerHTML = '<div class="empty">Your library is empty. Add titles from Discover, or sign in and refresh from your account.</div>';
        firstIn(page); return;
      }
      for (var k = 0; k < groups.length; k++) {
        if (groups[k].type === 'sync') {
          var sr = makeRow('Account', groups[k].items, 'other');
          var card = U.qs('.card', sr);
          if (card) card.onclick = function () { App.syncLibrary(); };
          rows.appendChild(sr);
        } else {
          // Library has no info bar — just browse the shelves.
          // Library: plain shelves, no background art.
          rows.appendChild(makeRow(groups[k].type === 'movie' ? 'Movies' : 'Series', groups[k].items, groups[k].type));
        }
      }
      firstIn(page);
    }

    var drawSeq = 0, discMorePending = false, discCatEls = [];
    function onMoreKey(e) {
      if (!document.body.contains(rows)) { document.removeEventListener('keydown', onMoreKey, false); return; }
      if (e.keyCode !== 40 || !discCatEls.length || discMorePending) return;  // Down only
      var f = Focus.get();
      if (!f || !rows.contains(f)) return;
      var r = f;
      while (r && r !== rows && (' ' + r.className + ' ').indexOf(' row ') < 0) r = r.parentNode;
      var at = discCatEls.indexOf(r);
      if (at < 0 || at < discCatEls.length - 2) return;
      discMorePending = true;
      API.moreDiscoverRows(state.type === 'All' ? null : state.type, state.genre, state.sort, function () {
        discMorePending = false;
      });
    }
    document.addEventListener('keydown', onMoreKey, false);
    function draw() {
      clear(rows);
      discCatEls = [];
      if (isLibrary) { drawLibrary(); return; }
      skeletonRows(rows, 7);
      var reqId = ++drawSeq;     // a slower earlier filter must not overwrite a newer one
      var drawn = [], gaveFocus = false, skelDone = false;
      function dropSkeleton() {
        if (skelDone) return;
        skelDone = true;
        var sk = rows.querySelectorAll('.sk-row');
        for (var s = 0; s < sk.length; s++) rows.removeChild(sk[s]);
      }
      function appendRow(rd) {
        if (reqId !== drawSeq || !rd || drawn.indexOf(rd) !== -1) return;
        drawn.push(rd);
        var el = makeRow(rd.title, rd.items, rd.type, discoverFocus);
        discCatEls.push(el);
        rows.appendChild(el);
        waitRowImages(el, dropSkeleton);   // loader → images, never empty cards
        // Like Home: show the first title's details + art with the first shelf,
        // not after every catalog has answered.
        if (!gaveFocus) {
          gaveFocus = true;
          if (rd.items && rd.items[0]) discoverFocus(badgeItem(rd.items[0], rd.type));
          firstIn(page);
        }
      }
      function startLoad() {
        if (reqId !== drawSeq || !document.body.contains(rows)) return;
        API.discoverRows(state.type === 'All' ? null : state.type, state.genre, state.sort, function (data) {
          if (reqId !== drawSeq || !document.body.contains(rows)) return;
          if (!data.length) {
            clear(rows);
            rows.innerHTML = '<div class="empty">No titles match these filters.</div>';
            firstIn(page);
            return;
          }
          for (var i = 0; i < data.length; i++) appendRow(data[i]);
          if (discRestore) {
            discRestore = false;
            var backId = discSaved.id, backTop = discSaved.top;
            setTimeout(function () {
              if (!document.body.contains(rows)) return;
              var target = backId ? U.qs('.card[data-id="' + U.attr(backId) + '"]', rows) : null;
              if (target) Focus.set(target);          // keep the exact title selected
              scroll.scrollTop = backTop;             // and the same shelf in view
            }, 0);
          }
        }, appendRow);
      }
      // Keep the skeleton on screen for a moment on every draw, including
      // filter changes and revisits with the API cache already warm.
      setTimeout(startLoad, 280);
    }
    if (!isLibrary) {
      pickers.appendChild(picker('Type', 'dType', types, state.type, function (v) { state.type = v; draw(); }));
      pickers.appendChild(picker('Genre', 'dGenre', genres, state.genre, function (v) { state.genre = v; draw(); }));
      pickers.appendChild(picker('Sort by', 'dSort', sorts, state.sort, function (v) { state.sort = v; draw(); }));
    }
    draw();
  }

  /* ---------------- SEARCH ---------------- */
  // The last search survives tab switches: query + results are kept in memory
  // and shown again when you come back to Search.
  var lastSearch = { q: '', movies: null, series: null, seq: 0 };
  function search(box) {
    clear(box);
    clearInfoBar();
    var page = U.el('div', 'page');
    page.innerHTML = '<div class="page-title">Search</div>' +
      '<div class="search-box" data-focus="1"><input id="search-input" class="search-input" placeholder="Search movies, series…" /></div>' +
      '<div class="keyboard" id="keyboard"></div>' +
      '<div class="hint">Type with the remote - results appear as you type</div>' +
      '<div class="rows-scroll search-scroll" id="search-results"></div>';
    box.appendChild(page);
    Focus.setRoot(U.qs('#app'));

    var input = U.qs('#search-input', page);
    var results = U.qs('#search-results', page);
    function render(q, movies, series) {
      clear(results);
      if (movies.length) results.appendChild(makeRow('Movies', movies, 'movie', artFocus));
      if (series.length) results.appendChild(makeRow('Series', series, 'series', artFocus));
      if (!movies.length && !series.length) results.innerHTML = '<div class="empty">No results for “' + U.esc(q) + '”</div>';
    }
    // Coming back to the tab: restore the previous query and its results.
    input.value = lastSearch.q;
    if (lastSearch.q && lastSearch.movies && lastSearch.series) render(lastSearch.q, lastSearch.movies, lastSearch.series);

    var doSearch = U.debounce(function () {
      var q = input.value.replace(/^\s+|\s+$/g, '');
      var seq = ++lastSearch.seq;
      lastSearch.q = input.value; lastSearch.movies = null; lastSearch.series = null;
      if (!q) { clear(results); return; }
      results.innerHTML = '<div class="empty">Searching…</div>';
      API.search('movie', q, function (movies) {
        API.search('series', q, function (series) {
          if (seq !== lastSearch.seq) return;       // a newer search is running
          lastSearch.movies = movies; lastSearch.series = series;
          render(q, movies, series);
          // Keep focus on the on-screen keyboard — typing must never jump to
          // the text field or the results as each letter arrives.
        });
      });
    }, 350);

    U.keyboard(U.qs('#keyboard', page), [
      { label: 'SPACE', fn: function () { input.value += ' '; doSearch(); } },
      { label: 'CLEAR', fn: function () {
          input.value = ''; clear(results);
          lastSearch.seq++; lastSearch.q = ''; lastSearch.movies = null; lastSearch.series = null;
        } }
    ], function (ch) {
      input.value += ch;   // the keyboard applies Shift already
      doSearch();
    }, function () {
      input.value = input.value.slice(0, -1);
      doSearch();
    });
  }

  /* ---------------- META DETAILS ---------------- */
  // Episode ids look like tt1234567:2:5
  function episodeOf(id) {
    var m = /^(tt\d+):(\d+):(\d+)$/.exec(String(id || ''));
    if (!m) return null;
    return { series: m[1], season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
  }
  function findVideo(d, season, episode) {
    var v = d.videos || [];
    for (var i = 0; i < v.length; i++) {
      if (Number(v[i].season) === season && Number(v[i].episode) === episode) return v[i];
    }
    return null;
  }
  function epCode(v) { return 'S' + (v.season || 0) + ' E' + (v.episode || 0); }

  // "Show — S2 E5 • Episode title" for episodes, or the movie name.
  function displayTitle(metaData, streamId) {
    var name = (metaData && metaData.name) || 'Playing';
    var m = /^(.+):(\d+):(\d+)$/.exec(String(streamId || ''));
    if (m && metaData && metaData.videos) {
      var season = parseInt(m[2], 10), episode = parseInt(m[3], 10);
      for (var i = 0; i < metaData.videos.length; i++) {
        var v = metaData.videos[i];
        if (Number(v.season) === season && Number(v.episode) === episode) {
          return name + ' — S' + season + ' E' + episode + (v.title ? '  •  ' + v.title : '');
        }
      }
      return name + ' — S' + season + ' E' + episode;
    }
    return name;
  }

  // Id of the episode after the one being played (in season/episode order).
  function nextEpisodeId(metaData, streamId) {
    var vids = ((metaData && metaData.videos) || []).slice(0);
    if (!vids.length) return '';
    vids.sort(function (a, b) {
      var sa = Number(a.season) || 0, sb = Number(b.season) || 0;
      if (sa !== sb) return sa - sb;
      return (Number(a.episode) || 0) - (Number(b.episode) || 0);
    });
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].id === streamId) return vids[i + 1] ? vids[i + 1].id : '';
    }
    return '';
  }

  // Id of the episode before the one being played.
  function prevEpisodeId(metaData, streamId) {
    var vids = ((metaData && metaData.videos) || []).slice(0);
    if (!vids.length) return '';
    vids.sort(function (a, b) {
      var sa = Number(a.season) || 0, sb = Number(b.season) || 0;
      if (sa !== sb) return sa - sb;
      return (Number(a.episode) || 0) - (Number(b.episode) || 0);
    });
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].id === streamId) return i > 0 ? vids[i - 1].id : '';
    }
    return '';
  }

  // Turn a formatted size ("1.4 GB", "620 MiB") into bytes for numeric sorting.
  function sizeBytes(str) {
    var m = /^([\d.]+)\s*([KMGT]?)i?B$/i.exec(String(str || '').replace(/\s+/g, ' ').trim());
    if (!m) return 0;
    var n = parseFloat(m[1]) || 0;
    var u = (m[2] || '').toUpperCase();
    var mult = u === 'T' ? 1099511627776 : u === 'G' ? 1073741824 :
               u === 'M' ? 1048576 : u === 'K' ? 1024 : 1;
    return n * mult;
  }

  function streamCard(s, metaData, play) {
    var p = API.parseStream(s);
    var kind = API.streamKind(s);
    var e = U.el('div', 'stream-card');
    e.setAttribute('data-focus', '1');
    var chips = '';
    if (p.seeders !== null) chips += '<span class="sc-chip sc-seed">\uD83D\uDC64 ' + p.seeders + '</span>';
    if (p.size) chips += '<span class="sc-chip">\uD83D\uDCBE ' + U.esc(p.size) + '</span>';
    if (p.provider) chips += '<span class="sc-chip">\u2699\uFE0F ' + U.esc(p.provider) + '</span>';
    if (p.langs) chips += '<span class="sc-chip sc-lang">' + U.esc(p.langs) + '</span>';
    var seen = API.streamWatched(s) ? '<span class="sc-chip sc-seen sc-seen-head">✓ Viewed</span>' : '';
    var badge = kind === 'torrent' ? 'P2P' : (kind === 'yt' ? 'YT' : 'HTTP');
    var label = p.quality || (kind === 'torrent' ? 'Torrent' : 'Direct');
    e.innerHTML =
      '<div class="sc-head"><span class="sc-quality">' + U.esc(label) + '</span>' + seen +
      '<span class="sc-badge' + (kind === 'torrent' ? ' sc-badge-p2p' : '') + '">' + badge + '</span></div>' +
      '<div class="sc-name">' + U.esc(p.title || s.description || s.name || '') + '</div>' +
      (chips ? '<div class="sc-meta">' + chips + '</div>' : '') +
      '<div class="sc-addon">' + U.esc(s.addon || '') + '</div>';
    e.onclick = function () {
      var info = play || {};
      App.playStream(s, metaData, {
        title: info.title, quality: p.quality, seeders: p.seeders,
        nextId: info.nextId, prevId: info.prevId,
        progressId: info.progressId, resumePos: info.resumePos, videoId: info.videoId,
        mediaType: info.mediaType
      });
    };
    return e;
  }

  // Streams grouped into tabs by the addon that provides the links.
  function renderStreams(body, streamType, streamId, metaData) {
    var title = displayTitle(metaData, streamId);
    var nextId = nextEpisodeId(metaData, streamId);
    var prevId = prevEpisodeId(metaData, streamId);
    // Progress is stored against the library item (series id for episodes).
    var progId = streamId;
    var em = /^(.+):(\d+):(\d+)$/.exec(String(streamId || ''));
    if (em) progId = em[1];
    var pr = API.progress(progId);
    var play = {
      title: title, nextId: nextId, prevId: prevId, progressId: progId, videoId: streamId, mediaType: streamType,
      // Resume only the same video (show progress is stored per show, with the
      // episode in videoId) and only if it isn't finished.
      resumePos: (pr && pr.pos > 0 && !API.finished(pr) && (!em || pr.videoId === streamId)) ? pr.pos : 0
    };
    // Sort mode is remembered across views; Best Ratio is the default.
    var sortKey = 'streamSort';
    var sortOptions = ['Best Ratio', 'Seeders', 'Size'];
    if (!pickState[sortKey]) pickState[sortKey] = 'Best Ratio';

    function sortStreams(items) {
      var arr = items.slice();
      var mode = pickState[sortKey];
      arr.sort(function (a, b) {
        var pa = API.parseStream(a), pb = API.parseStream(b);
        var sa = pa.seeders === null ? -1 : pa.seeders;
        var sb = pb.seeders === null ? -1 : pb.seeders;
        // Unknown sizes are pushed to the bottom instead of counting as "smallest".
        var za = sizeBytes(pa.size) || 9007199254740991;
        var zb = sizeBytes(pb.size) || 9007199254740991;
        if (mode === 'Seeders') return sb - sa || za - zb;
        if (mode === 'Size') return za - zb || sb - sa;
        // Best Ratio (default): most seeders first, then smallest file size.
        return sb - sa || za - zb;
      });
      return arr;
    }
    body.innerHTML = '<div class="empty">Fetching streams from your addons…</div>';
    API.getStreams(streamType, streamId, function (streams) {
      clear(body);
      if (!streams.length) {
        body.innerHTML = '<div class="empty">No streams found for this episode.</div>';
        return;
      }
      var groups = [], by = {};
      for (var i = 0; i < streams.length; i++) {
        var s = streams[i], name = s.addon || 'Addons';
        if (!by[name]) { by[name] = { name: name, items: [] }; groups.push(by[name]); }
        by[name].items.push(s);
      }
      function playableCount(g) {
        var n = 0;
        for (var k = 0; k < g.items.length; k++) if (API.streamKind(g.items[k]) !== 'torrent') n++;
        return n;
      }
      groups.sort(function (a, b) { return playableCount(b) - playableCount(a) || b.items.length - a.items.length; });

      var sortWrap = U.el('div', 'stream-sort');
      sortWrap.appendChild(picker('Sort', sortKey, sortOptions, pickState[sortKey], function () {
        paint(activeItems);   // re-sort whatever tab is currently shown
      }));
      var tabs = U.el('div', 'stream-tabs');
      var list = U.el('div', 'stream-list');
      body.appendChild(sortWrap); body.appendChild(tabs);
      body.appendChild(mdScroller(list));   // only the torrent list scrolls

      var activeItems = streams;
      function paint(items) {
        activeItems = items;
        clear(list);
        var sorted = sortStreams(items);
        for (var j = 0; j < sorted.length; j++) list.appendChild(streamCard(sorted[j], metaData, play));
      }
      function addTab(label, items, active) {
        var e = U.el('div', 'st-tab' + (active ? ' active' : ''), label);
        e.setAttribute('data-focus', '1');
        function activate() {
          var ts = tabs.querySelectorAll('.st-tab');
          for (var q = 0; q < ts.length; q++) {
            var f = (' ' + ts[q].className + ' ').indexOf(' focused ') !== -1 ? ' focused' : '';
            ts[q].className = 'st-tab' + (ts[q] === e ? ' active' : '') + f;
          }
          paint(items);
        }
        // Moving focus onto a tab switches to it immediately (no OK needed).
        e.onfocusin = activate;
        e.onclick = activate;
        tabs.appendChild(e);
      }
      addTab('All (' + streams.length + ')', streams, true);
      for (var g = 0; g < groups.length; g++) {
        addTab(groups[g].name + ' (' + groups[g].items.length + ')', groups[g].items, false);
      }
      paint(streams);
      firstIn(body);
    });
  }

  // Title page: the header (title, details, buttons, tabs) stays fixed and only
  // the episode grid / torrent list scrolls, in a container with the same faded
  // top edge as Discover. Its height fills the screen below where it starts.
  function mdScroller(inner) {
    var sc = U.el('div', 'md-scroll');
    sc.setAttribute('data-fade-top', '120');
    sc.appendChild(inner);
    function fit() {
      if (!sc.parentNode) return;
      var top = sc.getBoundingClientRect().top;
      sc.style.height = Math.max(240, 1080 - top) + 'px';
    }
    setTimeout(fit, 0); setTimeout(fit, 350);   // after layout / late text wrapping
    return sc;
  }

  // Season tabs + episode grid, as in the Android TV details screen.
  function renderEpisodes(body, d, seriesId) {
    // Per-episode watched state. The series-level "Mark Watched" badge applies
    // to every episode; playback progress is keyed by the series id but stores
    // the exact episode in videoId.
    // Only an explicit local mark (a timestamp) covers the whole show; the
    // value "true" came from an account sync and only meant "started".
    var wAll = API.watched()[seriesId];
    var watchedAll = typeof wAll === 'number' && wAll > 0;
    function epState(vid) {
      var w = API.watched();
      if (watchedAll || w[vid.id]) return { watched: true };
      var p = API.progress(seriesId);
      if (p && p.videoId === vid.id) {
        if (API.finished(p)) return { watched: true };
        if (p.pct > 1) return { pct: p.pct };
      }
      p = API.progress(vid.id);
      if (p) {
        if (API.finished(p)) return { watched: true };
        if (p.pct > 1) return { pct: p.pct };
      }
      return { pct: 0 };
    }

    var vids = (d.videos || []).slice(0);
    vids.sort(function (a, b) {
      var sa = Number(a.season) || 0, sb = Number(b.season) || 0;
      if (sa !== sb) return sa - sb;
      return (Number(a.episode) || 0) - (Number(b.episode) || 0);
    });
    var seasons = [], seen = {};
    for (var i = 0; i < vids.length; i++) {
      var sn = Number(vids[i].season) || 0;
      if (!seen[sn]) { seen[sn] = 1; seasons.push(sn); }
    }
    seasons.sort(function (a, b) {
      if (a === 0) return 1;                       // "Specials" last
      if (b === 0) return -1;
      return a - b;
    });
    var initial = seasons[0];

    var tabs = U.el('div', 'season-tabs');
    var grid = U.el('div', 'ep-grid');
    body.appendChild(tabs);
    body.appendChild(mdScroller(grid));   // only the episodes scroll

    function paint(season) {
      clear(grid);
      for (var v = 0; v < vids.length; v++) {
        if ((Number(vids[v].season) || 0) !== season) continue;
        (function (vid) {
          var card = U.el('div', 'ep-card');
          card.setAttribute('data-focus', '1');
          var thumb = vid.thumbnail ? 'background-image:url(\'' + U.attr(vid.thumbnail) + '\')' : '';
          var date = String(vid.released || '').slice(0, 10);
          var st = epState(vid);
          var marker = st.watched
            ? '<span class="ep-watched">\u2713</span>'
            : '<span class="ep-unwatched"></span>';
          if (st.pct && !st.watched) {
            marker += '<span class="ep-progress"><i style="width:' +
              Math.max(3, Math.min(100, Math.round(st.pct))) + '%"></i></span>';
          }
          card.innerHTML = '<div class="ep-thumb" style="' + thumb + '">' + marker +
            '<span class="ep-num">' + U.esc(epCode(vid)) + '</span></div>' +
            '<div class="ep-name">' + U.esc(vid.title || ('Episode ' + vid.episode)) + '</div>' +
            '<div class="ep-date">' + U.esc(date) + '</div>';
          card.onclick = function () { App.openMeta(vid.id, 'series', { fromContinue: true }); };
          grid.appendChild(card);
        })(vids[v]);
      }
    }
    for (var t = 0; t < seasons.length; t++) {
      (function (season) {
        var label = season === 0 ? 'Specials' : ('Season ' + season);
        var e = U.el('div', 'st-tab' + (season === initial ? ' active' : ''), label);
        e.setAttribute('data-focus', '1');
        function activate() {
          var ts = tabs.querySelectorAll('.st-tab');
          for (var q = 0; q < ts.length; q++) {
            var f = (' ' + ts[q].className + ' ').indexOf(' focused ') !== -1 ? ' focused' : '';
            ts[q].className = 'st-tab' + (ts[q] === e ? ' active' : '') + f;
          }
          paint(season);
        }
        // Like the nav bar: moving focus onto a tab selects it.
        e.onfocusin = activate;
        e.onclick = activate;
        tabs.appendChild(e);
      })(seasons[t]);
    }
    paint(initial);
    // Land on the first episode, not on the season strip.
    var firstEp = grid.querySelector('.ep-card');
    if (firstEp) Focus.set(firstEp);
  }

  function meta(box, id, type, opts) {
    clear(box);
    var page = U.el('div', 'page meta-page');
    // Art comes from the shared #backdrop (right half + gradients, as on Home).
    page.innerHTML = '<div class="md-content" id="md-content"><div class="empty">Loading…</div></div>';
    box.appendChild(page);
    Focus.setRoot(U.qs('#app'));

    var ep = episodeOf(id);
    var seriesId = ep ? ep.series : id;
    var kindType = ep ? 'series' : (type || 'movie');

    API.getMeta(kindType, seriesId, function (m) {
      var d = m.meta || {};
      clearInfoBar();   // meta has its own detail layout
      setBackdrop(d.background || d.poster || '');   // same art + gradients as Home

      var content = U.qs('#md-content', page);
      clear(content);
      var info = d.releaseInfo ? U.esc(d.releaseInfo) : '';
      var rating = d.imdbRating ? '★ ' + U.esc(d.imdbRating) : '';
      var sub = '';
      if (ep) {
        var v = findVideo(d, ep.season, ep.episode);
        sub = '<span class="md-ep">' + U.esc(epCode(ep)) + (v && v.title ? '  •  ' + U.esc(v.title) : '') + '</span>  •  ';
      }
      content.innerHTML =
        '<div class="md-title">' + U.esc(d.name || '') + '</div>' +
        '<div class="md-sub">' + sub + info + (rating ? '  •  ' + rating : '') + '  •  ' + U.esc(d.type || kindType) + '</div>' +
        '<div class="md-extra" id="md-extra"></div>' +
        '<div class="md-desc">' + U.esc(d.description || '') + '</div>' +
        '<div class="md-actions" id="md-actions"></div>' +
        '<div id="md-body" style="width:1690px"></div>';

      var body = U.qs('#md-body', content);
      var actions = U.qs('#md-actions', content);
      // OMDb / TMDB extras (ratings, tagline, budget) when set up in Settings.
      var mdx = U.qs('#md-extra', content);
      function fillExtra(x) {
        if (!x || !mdx.parentNode) return;
        mdx.innerHTML = extraBlock(x, d.imdbRating);
        var scs = U.qsa('.md-scroll');
        for (var q = 0; q < scs.length; q++) scs[q].style.height = Math.max(240, 1080 - scs[q].getBoundingClientRect().top) + 'px';
      }
      var xNow = API.extraCached(seriesId);
      if (xNow) fillExtra(xNow); else API.extraInfo(seriesId, kindType, fillExtra);
      var inLib = !!API.inLibrary(seriesId);

      function openStreamsHere() { renderStreams(body, 'series', id, d); }
      function resume() {
        var p = API.progress(seriesId);
        if (p && p.videoId) { App.openMeta(p.videoId, 'series', { fromContinue: true }); return; }
        var first = (d.videos || [])[0];
        if (first) { App.openMeta(first.id, 'series', { fromContinue: true }); return; }
        App.toast('No episodes available');
      }

      var buttons = [];
      if (!ep) {
        // Movies and shows: no Play or Trailer button — streams are shown below.
        buttons.push({ label: inLib ? '✓ In Library' : '+ Library', fn: function () {
          if (API.inLibrary(seriesId)) { API.removeLibrary(seriesId); App.toast('Removed from Library'); }
          else {
            API.addLibrary({ id: seriesId, type: kindType, name: d.name, poster: d.poster, background: d.background });
            App.toast('Added to Library');
          }
          meta(box, id, type, opts);
        } });
        // Movies only: a show-level marker would wrongly cover every episode.
        if (kindType !== 'series') watchedButton(id);
      } else {
        // Episode details: mark just this episode, not the whole series.
        watchedButton(id);
      }

      // One stateful button: "Mark as Watched" when unwatched, solid green
      // "Watched" once marked. Clicking it toggles the state either way.
      function watchedButton(watchId) {
        var marked = !!API.watched()[watchId];
        buttons.push({
          label: marked ? '\u2713 Watched' : '\u2713 Mark as Watched',
          cls: 'mark-watched' + (marked ? ' marked' : ''),
          fn: function () {
            API.markWatched(watchId, !marked);
            App.toast(marked ? 'Marked as unwatched' : 'Marked as watched');
            meta(box, id, type, opts);
          }
        });
      }
      for (var i = 0; i < buttons.length; i++) {
        (function (b) {
          var e = U.el('span', 'btn' + (b.cls ? ' ' + b.cls : ''), b.label);
          e.setAttribute('data-focus', '1'); e.onclick = b.fn; actions.appendChild(e);
        })(buttons[i]);
      }

      if (ep) { openStreamsHere(); return; }                  // one specific episode
      if (kindType === 'series' && d.videos && d.videos.length) { renderEpisodes(body, d, seriesId); return; }
      renderStreams(body, kindType, id, d);                   // movie
    }, function () {
      U.qs('#md-content', page).innerHTML = '<div class="empty">Could not load this item.</div>';
    });
  }

  /* ---------------- SETTINGS ---------------- */
  function settings(box) {
    clear(box);
    clearInfoBar();
    var page = U.el('div', 'page');
    page.innerHTML = '<div class="page-title">Settings</div><div class="settings-wrap" id="sw"></div>';
    box.appendChild(page);
    Focus.setRoot(U.qs('#app'));
    var wrap = U.qs('#sw', page);
    var sections = ['General', 'Playback', 'Subtitles', 'Movie info', 'Addons', 'About'];
    var active = U.get('settingsTab', 'General');
    var tabs = U.el('div', 'settings-tabs');
    for (var i = 0; i < sections.length; i++) {
      (function (s) {
        var e = U.el('div', 'st-tab' + (s === active ? ' active' : ''), s);
        e.setAttribute('data-focus', '1');
        function activate() {
          if (active === s) return;
          active = s; U.set('settingsTab', s);
          settings(box);
        }
        e.onfocusin = activate;   // focusing a tab switches instantly
        e.onclick = activate;
        tabs.appendChild(e);
      })(sections[i]);
    }
    wrap.appendChild(tabs);
    var list = U.el('div', 'settings-list');

    function row(label, value, help, fn) {
      var e = U.el('div', 's-row'); e.setAttribute('data-focus', '1');
      e.innerHTML = '<span class="s-label">' + U.esc(label) + '</span>' +
        (value ? '<span class="s-value">' + U.esc(value) + '</span>' : '') +
        (help ? '<span class="s-help">' + U.esc(help) + '</span>' : '');
      if (fn) e.onclick = fn;
      list.appendChild(e);
    }
    if (active === 'General') {
      row('Theme', 'Default', 'Android TV appearance');
      row('Stream cards', U.get('cardStyle', 'Default'), 'Default / Expanded / Marquee', function () {
        var opts = ['Default', 'Expanded', 'Marquee'], cur = opts.indexOf(U.get('cardStyle', 'Default'));
        U.set('cardStyle', opts[(cur + 1) % opts.length]); settings(box);
      });
      row('Clear local data', '', 'Library, watch history, progress', function () {
        API.saveAddons(API.DEFAULT_ADDONS); U.set('library', []); U.set('watched', {}); U.set('progress', {});
        App.toast('Local data cleared'); settings(box);
      });
    } else if (active === 'Playback') {
      row('Player', 'TV video + AVPlay', 'Browser video first; Samsung AVPlay for formats it cannot decode');
      row('Streaming server', 'On this TV', 'Built-in torrent engine (127.0.0.1:11470) - no PC needed');
      row('Open external player', 'Off', 'Use Sideload Launcher if needed');
      function minutesRow(label, key, def, hint) {
        var cur = Number(U.get(key, def)) || def;
        row(label, cur + ' min before the end', hint, function () {
          var rws = [];
          for (var m = 1; m <= 10; m++) {
            (function (mm) {
              rws.push({ label: mm + (mm === 1 ? ' minute' : ' minutes') + (mm === cur ? '  \u2713' : ''),
                fn: function () { U.set(key, mm); App.toast(label + ': ' + mm + ' min'); settings(box); } });
            })(m);
          }
          App.modal(label, rws);
        });
      }
      minutesRow('Next episode button', 'nextEpMin', 1, 'When the "Next Episode" button appears');
      minutesRow('Pre-load next episode', 'prefetchMin', 5, 'When the next episode starts downloading in the background');
    } else if (active === 'Subtitles') {
      var curLang = U.get('subLang', 'en');
      row('Subtitle language', API.subLangName(curLang), 'Tracks come from your subtitle addons', function () {
        var langRows = [], langs = API.SUB_LANGS;
        for (var li = 0; li < langs.length; li++) {
          (function (L) {
            langRows.push({ label: L.name + ' (' + L.code + ')' + (L.code === curLang ? '  ✓' : ''),
              fn: function () {
                U.set('subLang', L.code);
                App.toast('Subtitle language: ' + L.name);
                settings(box);
              } });
          })(langs[li]);
        }
        App.modal('Subtitle language', langRows);
      });
      var subAdds = API.subtitleAddons(), subNames = [];
      for (var si = 0; si < subAdds.length; si++) subNames.push(subAdds[si].name);
      row('Subtitle addons', subNames.length ? (subNames.length + ' installed') : 'None',
        subNames.join(', ') || 'Install an addon with subtitles support');
      row('Subtitle size', U.get('subSize', '100%'), '', function () {
        var o = ['75%', '100%', '125%', '150%'], i = o.indexOf(U.get('subSize', '100%'));
        U.set('subSize', o[(i + 1) % o.length]); App.applySubtitleSettings(); settings(box);
      });
      var curColor = U.get('subColor', '#FFFFFF');
      row('Subtitle color', App.subtitleColorName(), 'Tap to choose a color', function () {
        var colors = App.SUB_COLORS, colorRows = [];
        for (var ci = 0; ci < colors.length; ci++) {
          (function (c) {
            var picked = String(curColor).toLowerCase() === String(c.value).toLowerCase();
            colorRows.push({
              label: c.name + (picked ? '  ✓' : ''),
              color: c.value,
              fn: function () {
                U.set('subColor', c.value);
                App.applySubtitleSettings();
                App.toast('Subtitle color: ' + c.name);
                settings(box);
              }
            });
          })(colors[ci]);
        }
        App.modal('Subtitle color', colorRows);
      });
      row('Subtitle sync', App.subSyncText(), 'Positive delays the subtitles. Saved per video.', function () {
        var syncRows = [], steps = [-5, -3, -1, -0.5, 0.5, 1, 3, 5];
        for (var di = 0; di < steps.length; di++) {
          (function (d) {
            syncRows.push({ label: (d > 0 ? '+' : '') + d + ' s', fn: function () {
              App.subSyncBy(d); settings(box);
            } });
          })(steps[di]);
        }
        syncRows.push({ label: 'Reset to 0 s', fn: function () { App.subSyncSet(0); settings(box); } });
        App.modal('Subtitle sync \u2014 current ' + App.subSyncText(), syncRows);
      });
      var autoSync = U.get('subAutoSync', true) !== false;
      row('Auto-apply saved sync', autoSync ? 'On' : 'Off',
        'Reuse each video\'s saved offset next time you play it', function () {
          U.set('subAutoSync', !autoSync);
          App.toast('Auto-apply saved sync: ' + (!autoSync ? 'On' : 'Off'));
          settings(box);
        });
      row('Drift correction', App.driftStatusText(),
        'While playing: Subtitles \u2192 Set sync START here, then END near the finish', function () {
          App.toast('Set both points in the player\u2019s Subtitles menu');
        });
    } else if (active === 'Movie info') {
      var srcNames = { off: 'Off', omdb: 'OMDb', tmdb: 'TMDB', both: 'OMDb + TMDB' };
      var curSrc = U.get('infoSource', 'off');
      row('Extra movie info', srcNames[curSrc] || 'Off', 'Rotten Tomatoes, Metascore, age rating, budget, tagline \u2014 set up OMDb and/or TMDB',
        function () { infoSetup(box); });
      if (curSrc !== 'off' && curSrc !== 'tmdb')
        row('OMDb key', maskKey(U.get('omdbKey', '')), 'Rotten Tomatoes, Metascore, age rating, box office, awards', function () { infoSetup(box, 'omdb'); });
      if (curSrc !== 'off' && curSrc !== 'omdb')
        row('TMDB key', maskKey(U.get('tmdbKey', '')), 'Tagline, budget, revenue, TMDB user score', function () { infoSetup(box, 'tmdb'); });
      row('Clear movie info cache', '', 'Ratings are kept for a week; clear to fetch them again', function () {
        API.clearExtraCache(); App.toast('Movie info cache cleared');
      });
    } else if (active === 'Addons') {
      var adds = API.addons();
      for (var a = 0; a < adds.length; a++) {
        (function (addon) { row(addon.name, addon.id || '', addon.base, function () { App.toast(addon.base); }); })(adds[a]);
      }
      row('+ Install addon', '', 'Enter a manifest URL', function () { App.installAddon(function () { settings(box); }); });
      row('Reset addons', '', function () { API.saveAddons(API.DEFAULT_ADDONS); App.toast('Addons reset'); settings(box); });
    } else {
      row('Stremio for Tizen', '1.0.0', 'Frontend rebuilt from Stremio Android TV v1.10.4');
      row('Target TV', 'Samsung UE50MU6102', 'Tizen 3.0 / Chromium 47');
    }
    wrap.appendChild(list);
    // Keep focus on the tab the user just switched to instead of snapping back
    // to the first one — otherwise right-arrow navigation appears broken.
    var keep = null, tabEls = tabs.querySelectorAll('.st-tab');
    for (var ti = 0; ti < tabEls.length; ti++)
      if (tabEls[ti].innerText === active) { keep = tabEls[ti]; break; }
    if (keep && focusWasInSidebar() === false) Focus.set(keep);
    else firstIn(page);
  }
  function maskKey(k) {
    k = String(k || '').replace(/\s+/g, '');
    if (!k) return 'Not set';
    var n = Math.min(k.length - 4, 12), m = '';
    for (var i = 0; i < n; i++) m += '•';
    return k.slice(0, 4) + m;
  }

  /* ---- Settings > Movie info: setup stepper ----
     Source (OMDb / TMDB / both) -> key per service (QR to the sign-up page
     + the same on-screen keyboard as Search) -> live test & save. */
  function infoSetup(box, jump) {
    var st = { src: U.get('infoSource', 'off'), omdb: U.get('omdbKey', ''), tmdb: U.get('tmdbKey', '') };
    if (st.src === 'off') st.src = 'both';
    var LABEL = { source: 'Source', omdb: 'OMDb key', tmdb: 'TMDB key', test: 'Test & save' };
    function steps() {
      var l = ['source'];
      if (st.src !== 'tmdb') l.push('omdb');
      if (st.src !== 'omdb') l.push('tmdb');
      l.push('test');
      return l;
    }
    function clean(k) { return String(k || '').replace(/\s+/g, ''); }
    function shell(step) {
      clear(box);
      clearInfoBar();
      var list = steps(), cur = list.indexOf(step), h = '<div class="stp-head">';
      for (var i = 0; i < list.length; i++) {
        if (i) h += '<span class="stp-line' + (i <= cur ? ' done' : '') + '"></span>';
        h += '<span class="stp-step' + (i < cur ? ' done' : (i === cur ? ' cur' : '')) + '"><span class="stp-dot">' +
          (i < cur ? '✓' : (i + 1)) + '</span>' + LABEL[list[i]] + '</span>';
      }
      var page = U.el('div', 'page');
      page.innerHTML = '<div class="page-title">Settings › Movie info</div><div class="stp">' + h + '</div></div>';
      box.appendChild(page);
      Focus.setRoot(U.qs('#app'));
      return U.qs('.stp', page);
    }
    function button(host, label, fn, primary) {
      var b = U.el('div', 'btn' + (primary ? ' primary' : ''), U.esc(label));
      b.setAttribute('data-focus', '1');
      b.onclick = fn;
      host.appendChild(b);
      return b;
    }
    function go(step) { if (step === 'source') stepSource(); else if (step === 'test') stepTest(); else stepKey(step); }
    function next(step) { var l = steps(); go(l[l.indexOf(step) + 1]); }
    function prev(step) { var l = steps(), i = l.indexOf(step); if (i <= 0) exit(); else go(l[i - 1]); }
    function exit() { U.set('settingsTab', 'Movie info'); settings(box); }

    function stepSource() {
      var root = shell('source');
      root.insertAdjacentHTML('beforeend',
        '<div class="stp-title">Where should extra movie info come from?</div>' +
        '<div class="stp-sub">Cinemeta already gives title, year, runtime, IMDb score, genres, director and cast. ' +
        'Pick what to add on top. Both services are free — you only need a key.</div>');
      var defs = [
        { id: 'omdb', h: 'OMDb', who: 'omdbapi.com', li: ['Rotten Tomatoes %', 'Metascore', 'Age rating (PG-13, R…)', 'Box office, awards'], lim: 'Free key • 1,000 lookups / day' },
        { id: 'tmdb', h: 'TMDB', who: 'themoviedb.org', li: ['Budget & revenue', 'Tagline', 'TMDB user score', 'Release date'], lim: 'Free key • no daily limit' },
        { id: 'both', h: 'Both', who: 'OMDb + TMDB', li: ['Everything on the left', 'Still works if one service is down', 'Two keys, entered once'], lim: 'Info is cached, so lookups stay low', tag: 'RECOMMENDED' }
      ];
      var saved = U.get('infoSource', 'off'), row = U.el('div', 'src-row'), pick = null;
      for (var i = 0; i < defs.length; i++) {
        (function (dfn) {
          var c = U.el('div', 'src');
          c.setAttribute('data-focus', '1');
          var tag = saved === dfn.id ? 'CURRENT' : (dfn.tag || '');
          var lis = '';
          for (var j = 0; j < dfn.li.length; j++) lis += '<li>' + U.esc(dfn.li[j]) + '</li>';
          c.innerHTML = (tag ? '<span class="tag">' + tag + '</span>' : '') + '<h3>' + dfn.h + '</h3><div class="who">' + dfn.who + '</div>' +
            '<ul>' + lis + '</ul><div class="lim">' + dfn.lim + '</div>';
          c.onclick = function () { st.src = dfn.id; next('source'); };
          row.appendChild(c);
          if (dfn.id === st.src) pick = c;
        })(defs[i]);
      }
      root.appendChild(row);
      var acts = U.el('div', 'stp-actions');
      root.appendChild(acts);
      button(acts, 'Back', exit);
      if (saved !== 'off') button(acts, 'Turn off', function () { U.set('infoSource', 'off'); App.toast('Extra movie info turned off'); exit(); });
      else button(acts, 'Skip for now', exit);
      Focus.set(pick || row.firstChild);
    }

    function stepKey(step) {
      var isO = step === 'omdb', root = shell(step);
      var sub = isO
        ? 'Scan the code with your phone, choose the FREE plan and enter your e-mail. Open the activation link — the key (8 characters) arrives by e-mail.'
        : 'Scan the code, create a TMDB account and open Settings → API. Request a Developer key and type the “API Key” (32 characters).';
      var steps3 = isO ? ['Choose <b>FREE</b> (1,000 daily)', 'Enter your e-mail', 'Click the link in the e-mail']
                       : ['Sign up &amp; verify e-mail', 'API → Create → Developer', 'Copy “API Key”'];
      root.insertAdjacentHTML('beforeend',
        '<div class="stp-title">Get your free ' + (isO ? 'OMDb' : 'TMDB') + ' key</div>' +
        '<div class="stp-sub">' + sub + '</div>' +
        '<div class="qrcard"><img src="assets/qr/' + step + '.png"><div class="url">' +
        (isO ? 'omdbapi.com/apikey.aspx' : 'themoviedb.org/settings/api') + '</div><ol><li>' + steps3.join('</li><li>') + '</li></ol></div>' +
        '<div class="keybox"><div class="search-box"><input class="search-input" readonly placeholder="' +
        (isO ? '8-character OMDb key' : '32-character TMDB API key') + '" /></div>' +
        '<div class="keyboard"></div><div class="stp-actions"></div></div>');
      var input = U.qs('.search-input', root), acts = U.qs('.stp-actions', root);
      input.value = st[step] || '';
      function put(v) { input.value = v; st[step] = v; }
      // Exactly the Search keyboard (same keys, same SPACE / CLEAR row).
      U.keyboard(U.qs('.keyboard', root), [
        { label: 'SPACE', fn: function () { put(input.value + ' '); } },
        { label: 'CLEAR', fn: function () { put(''); } }
      ], function (ch) {
        put(input.value + ch);   // Shift is handled by the keyboard
      }, function () {
        put(input.value.slice(0, -1));
      });
      button(acts, 'Back', function () { prev(step); });
      if (st.src === 'both') {
        button(acts, isO ? 'Skip OMDb' : 'Skip TMDB', function () {
          st.src = isO ? 'tmdb' : 'omdb';
          go(isO ? 'tmdb' : 'test');
        });
      }
      button(acts, 'Next', function () {
        if (!clean(input.value)) { App.toast('Type the key first'); return; }
        next(step);
      }, true);
    }

    function stepTest() {
      var root = shell('test');
      root.insertAdjacentHTML('beforeend',
        '<div class="stp-title">Checking your keys…</div><div class="stp-sub"></div>' +
        '<div class="test-rows"></div><div class="preview" style="display:none"></div><div class="stp-actions"></div>');
      var title = U.qs('.stp-title', root), sub = U.qs('.stp-sub', root), rowsBox = U.qs('.test-rows', root);
      var prevBox = U.qs('.preview', root), acts = U.qs('.stp-actions', root);
      var jobs = [], pending = 0, allOk = true, sample = {};
      if (st.src !== 'tmdb') jobs.push({ id: 'omdb', name: 'OMDb', test: API.testOmdbKey });
      if (st.src !== 'omdb') jobs.push({ id: 'tmdb', name: 'TMDB', test: API.testTmdbKey });
      var back = button(acts, 'Back', function () { prev('test'); });
      Focus.set(back);
      function finished() {
        clear(acts);
        if (allOk) {
          U.set('infoSource', st.src);
          if (st.src !== 'tmdb') U.set('omdbKey', clean(st.omdb));
          if (st.src !== 'omdb') U.set('tmdbKey', clean(st.tmdb));
          API.clearExtraCache();
          title.innerHTML = '<span class="ok-ico">✓</span>All set';
          sub.innerHTML = (jobs.length > 1 ? 'Both keys work.' : 'The key works.') + ' Extra info now shows on Home, Discover and on every movie page.';
          prevBox.innerHTML = '<div class="pt">Preview — Inception</div>' + extraBlock(sample, sample.imdbRating || '8.8');
          prevBox.style.display = 'block';
          button(acts, 'Change keys', function () { go('source'); });
          Focus.set(button(acts, 'Done', exit, true));
        } else {
          title.innerHTML = 'A key did not work';
          sub.innerHTML = 'Check the key and try again. The TV also needs an internet connection.';
          button(acts, 'Back', function () { prev('test'); });
          Focus.set(button(acts, 'Try again', stepTest, true));
        }
      }
      for (var i = 0; i < jobs.length; i++) {
        (function (job) {
          var r = U.el('div', 'test-row', U.esc(job.name + ' key  ' + maskKey(st[job.id])) + '<span class="st">Checking…</span>');
          rowsBox.appendChild(r);
          pending++;
          job.test(st[job.id], function (ok, msg, info) {
            var stEl = U.qs('.st', r);
            stEl.className = 'st ' + (ok ? 'ok' : 'bad');
            stEl.innerHTML = (ok ? '✓ ' : '✗ ') + U.esc(msg);
            if (!ok) allOk = false;
            if (info) for (var k in info) if (info.hasOwnProperty(k) && info[k]) sample[k] = info[k];
            if (--pending === 0) finished();
          });
        })(jobs[i]);
      }
    }

    if (jump === 'omdb' || jump === 'tmdb') go(jump); else go('source');
  }

  function focusWasInSidebar() {
    var p = Focus.get();
    while (p && p !== document.body) { if (p.id === 'sidebar') return true; p = p.parentNode; }
    return false;
  }

  /* ---------------- ADDONS ---------------- */
  function addons(box) {
    clear(box);
    clearInfoBar();
    var page = U.el('div', 'page');
    page.innerHTML = '<div class="page-title">Addons</div><div class="rows" id="addon-rows" style="margin-top:0"></div>';
    box.appendChild(page);
    Focus.setRoot(U.qs('#app'));
    var host = U.qs('#addon-rows', page);
    var adds = API.addons();
    for (var i = 0; i < adds.length; i++) {
      (function (a) {
        var c = U.el('div', 'addon-card'); c.setAttribute('data-focus', '1');
        c.innerHTML = '<div class="addon-icon" style="background-image:url(\'' + U.attr(a.base + '/logo.png') + '\')"></div>' +
          '<div class="addon-name">' + U.esc(a.name) + '</div>';
        c.onclick = function () { App.toast(a.base); };
        host.appendChild(c);
      })(adds[i]);
    }
    var c = U.el('div', 'addon-card'); c.setAttribute('data-focus', '1');
    c.innerHTML = '<div class="addon-icon" style="background:#18181C url(\'assets/icons/add_to_library.svg\') no-repeat center/45%"></div><div class="addon-name">Install addon</div>';
    c.onclick = function () { App.installAddon(function () { addons(box); }); };
    host.appendChild(c);
    firstIn(page);
  }

  return { board: board, discover: discover, library: function (b) { discover(b, true); },
    search: search, meta: meta, settings: settings, addons: addons, clear: clear };
})();

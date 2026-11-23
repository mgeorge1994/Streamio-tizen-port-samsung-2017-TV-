/* api.js — Stremio addon/API client (XHR only, Chromium 47 safe) */
var API = (function () {
  var CINEMETA = 'https://v3-cinemeta.strem.io';
  // In-memory page data cache: revisiting Home/Discover/details reuses what
  // was already fetched instead of hitting every addon again (slow on TV).
  var catalogCache = {}, metaCache = {}, catalogQueues = {}, discoverQueues = {};
  // Home and Discover show 5 shelves immediately; the rest are fetched in
  // batches of 2 when the user moves into territory that is not loaded yet.
  var INITIAL_ROWS = 5, ROW_BATCH = 2;
  function clearCache() {
    catalogCache = {}; metaCache = {}; discoverRaw = {};
    catalogQueues = {}; discoverQueues = {};
  }
  // Shared batch loader: starts `count` jobs, emits each finished row through
  // q.onRow, then calls cb once. Extra "more" requests are queued, not dropped.
  function loadRows(q, count, cb) {
    if (q.busy) { if (cb) q.pending.push(cb); return; }
    q.busy = true;
    var jobs = [], i;
    while (jobs.length < count && q.next < q.jobs.length) jobs.push(q.jobs[q.next++]);
    if (!jobs.length) {
      q.busy = false;
      if (cb) cb(q.rows.slice());
      var old = q.pending.splice(0, q.pending.length);
      for (i = 0; i < old.length; i++) old[i](q.rows.slice());
      return;
    }
    var finished = 0;
    function finish() {
      q.busy = false;
      var rows = q.rows.slice();
      if (cb) cb(rows);
      var waiting = q.pending.splice(0, q.pending.length);
      for (var w = 0; w < waiting.length; w++) waiting[w](rows);
    }
    function one() { if (++finished === jobs.length) finish(); }
    for (i = 0; i < jobs.length; i++) {
      (function (job) {
        q.fetch(job, function () {
          var row = q.build(job);
          if (row) { q.rows.push(row); if (q.onRow) q.onRow(row); }
          one();
        });
      })(jobs[i]);
    }
  }

  // Exact stream (torrent) last played for each item. Continue Watching uses
  // this to resume with the same source instead of choosing a different one.
  function lastStreams() { return U.get('lastStreams', {}); }
  function rememberStream(keys, s) {
    if (!s) return;
    var all = lastStreams(), rec = { s: s, at: Date.now() };
    for (var i = 0; i < keys.length; i++) {
      var k = String(keys[i] || '');
      if (k) all[k] = rec;
    }
    U.set('lastStreams', all);
  }
  function lastStream(keys) {
    var all = lastStreams();
    for (var i = 0; i < keys.length; i++) {
      var k = String(keys[i] || '');
      if (k && all[k]) return all[k].s;
    }
    return null;
  }

  var DEFAULT_ADDONS = [
    { id: 'org.stremio.cinemeta', name: 'Cinemeta', base: CINEMETA,
      manifest: CINEMETA + '/manifest.json', types: ['movie', 'series'],
      catalogs: [{ type: 'movie', id: 'top', name: 'Popular Movies' },
                 { type: 'series', id: 'top', name: 'Popular Series' },
                 { type: 'movie', id: 'imdbRating', name: 'Featured Movies' },
                 { type: 'series', id: 'imdbRating', name: 'Featured Series' },
                 { type: 'movie', id: 'year/genre=2025', name: 'New Movies 2025' },
                 { type: 'series', id: 'year/genre=2025', name: 'New Series 2025' }] }
  ];

  // Bundled catalogue used only when a live request fails, so the UI is never empty.
  var FALLBACK = {
    movie: [
      ['tt0111161', 'The Shawshank Redemption'], ['tt0068646', 'The Godfather'],
      ['tt0071562', 'The Godfather Part II'], ['tt0468569', 'The Dark Knight'],
      ['tt0108052', "Schindler's List"], ['tt0167260', 'The Lord of the Rings: The Return of the King'],
      ['tt0110912', 'Pulp Fiction'], ['tt0137523', 'Fight Club'],
      ['tt0109830', 'Forrest Gump'], ['tt1375666', 'Inception'],
      ['tt0133093', 'The Matrix'], ['tt0816692', 'Interstellar']
    ],
    series: [
      ['tt0903747', 'Breaking Bad'], ['tt0944947', 'Game of Thrones'],
      ['tt0118798', 'The Sopranos'], ['tt0926084', 'The Wire'],
      ['tt4574334', 'Stranger Things'], ['tt2861424', 'Rick and Morty'],
      ['tt0108778', 'Friends'], ['tt7366338', 'Chernobyl'],
      ['tt0959621', 'The Walking Dead'], ['tt0054215', 'The Twilight Zone']
    ]
  };
  function fallbackItems(type) {
    var src = FALLBACK[type] || FALLBACK.movie, out = [];
    for (var i = 0; i < src.length; i++) {
      var id = src[i][0];
      out.push({ id: id, type: type, name: src[i][1],
        poster: 'https://images.metahub.space/poster/small/' + id + '/img',
        background: 'https://images.metahub.space/background/medium/' + id + '/img' });
    }
    return out;
  }

  function request(url, cb, err, timeout) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = timeout || 20000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status >= 200 && x.status < 300) {
        var data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { if (err) err('Invalid JSON'); return; }
        if (cb) cb(data);
      } else if (err) err('HTTP ' + x.status);
    };
    x.ontimeout = function () { if (err) err('Timeout'); };
    x.onerror = function () { if (err) err('Network error'); };
    try { x.send(); } catch (e) { if (err) err(String(e)); }
  }

  function post(url, payload, cb, err, timeout) {
    var x = new XMLHttpRequest();
    x.open('POST', url, true);
    // text/plain is a CORS "simple" request: no OPTIONS preflight on Chromium 47.
    // Stremio's API parses the JSON body regardless of this header.
    x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    x.timeout = timeout || 15000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status >= 200 && x.status < 300) {
        var data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { if (err) err('Invalid JSON'); return; }
        if (cb) cb(data);
      } else {
        var msg = 'HTTP ' + x.status;
        try { var d = JSON.parse(x.responseText); if (d && d.message) msg = d.message; } catch (e) {}
        if (err) err(msg);
      }
    };
    x.ontimeout = function () { if (err) err('Timeout'); };
    x.onerror = function () { if (err) err('Network error'); };
    try { x.send(JSON.stringify(payload)); } catch (e) { if (err) err(String(e)); }
  }

  var API_BASE = 'https://api.strem.io';
  var LINK_API = 'https://link.stremio.com/api';

  // Normalize the API envelope ({result} / {error}) into the result object.
  function apiFailed(d) { return !d || !!d.error || d.success === false; }
  function apiErrorText(d) {
    return (d && d.error && d.error.message) || (d && d.message) || 'Request failed';
  }
  function apiResult(d, cb, err) {
    if (apiFailed(d)) { if (err) err(apiErrorText(d)); return; }
    cb(d.result || d);
  }
  function login(email, password, cb, err) {
    post(API_BASE + '/api/login', { type: 'Login', email: email, password: password, facebook: false },
      function (d) { apiResult(d, cb, err); }, err);
  }
  function register(email, password, cb, err) {
    post(API_BASE + '/api/register', { type: 'Register', email: email, password: password,
      gdpr_consent: { tos: true, privacy: true, marketing: false } },
      function (d) { apiResult(d, cb, err); }, err);
  }
  function loginWithToken(token, cb, err) {
    post(API_BASE + '/api/loginWithToken', { type: 'LoginWithToken', token: token },
      function (d) { apiResult(d, cb, err); }, err);
  }
  // TV QR sign-in: create a link code, display its QR image, poll until the user links it.
  function createLinkCode(cb, err) {
    request(LINK_API + '/create?type=Create', function (d) {
      var r = (d && (d.result || d)) || {};
      if (!r.code) { if (err) err('No link code returned'); return; }
      cb(r);
    }, err);
  }
  function readLinkCode(code, cb, err) {
    request(LINK_API + '/read?type=Read&code=' + encodeURIComponent(code), function (d) {
      if (d && d.success === false) {
        if (err) err((d.error && d.error.message) || 'Not linked yet');
        return;
      }
      cb((d && (d.result || d)) || {});
    }, err);
  }
  function userAddons(authKey, cb, err) {
    post(API_BASE + '/api/addonCollectionGet',
      { type: 'AddonCollectionGet', authKey: authKey, update: true },
      function (d) {
        if (apiFailed(d)) { if (err) err(apiErrorText(d)); return; }
        var out = [], list = (d.result && d.result.addons) || [];
        for (var i = 0; i < list.length; i++) {
          var a = list[i], mf = a.manifest || {};
          // Stremio returns "transportUrl"; older clients also send manifestUrl/url.
          var url = a.transportUrl || a.manifestUrl || a.url || a.base || '';
          if (!url) continue;
          var base = url.replace(/\/manifest\.json.*$/, '').replace(/\/$/, '');
          out.push({ id: mf.id || a.id || ('addon' + i), name: mf.name || a.name || base,
            base: base, manifest: url.indexOf('/manifest.json') >= 0 ? url : (base + '/manifest.json'),
            types: mf.types || [], resources: mf.resources || [], catalogs: mf.catalogs || [] });
        }
        // Older collections omit the embedded manifest; fetch it so catalogs work.
        var pending = 0, done = false;
        function finish() { if (!done) { done = true; cb(out); } }
        for (var k = 0; k < out.length; k++) {
          if (out[k].catalogs && out[k].catalogs.length) continue;
          (function (addon) {
            pending++;
            request(addon.manifest, function (m) {
              addon.catalogs = m.catalogs || [];
              addon.types = m.types || addon.types;
              if (--pending === 0) finish();
            }, function () { if (--pending === 0) finish(); }, 12000);
          })(out[k]);
        }
        if (pending === 0) finish();
      }, err);
  }
  function auth() { return U.get('auth', null); }
  function setAuth(v) { U.set('auth', v); }
  function logout() { U.del('auth'); }

  function getText(url, cb, err, timeout) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = timeout || 15000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status >= 200 && x.status < 300) { if (cb) cb(x.responseText); }
      else if (err) err('HTTP ' + x.status);
    };
    x.ontimeout = function () { if (err) err('Timeout'); };
    x.onerror = function () { if (err) err('Network error'); };
    try { x.send(); } catch (e) { if (err) err(String(e)); }
  }

  function addons() {
    var a = U.get('addons', null);
    if (!a || !a.length) { a = DEFAULT_ADDONS; U.set('addons', a); }
    // Older builds stored only two Cinemeta catalogs; restore the full shelf set.
    for (var i = 0; i < a.length; i++) {
      if (a[i].id !== 'org.stremio.cinemeta' && a[i].base !== CINEMETA) continue;
      var cs = a[i].catalogs || [], have = {}, defs = DEFAULT_ADDONS[0].catalogs;
      for (var j = 0; j < cs.length; j++) have[cs[j].type + '|' + cs[j].id] = 1;
      for (var k = 0; k < defs.length; k++) {
        var key = defs[k].type + '|' + defs[k].id;
        if (!have[key]) { cs.push(defs[k]); have[key] = 1; }
      }
      a[i].catalogs = cs;
    }
    return a;
  }
  function saveAddons(a) { U.set('addons', a); clearCache(); }

  /* ---------------- subtitles from addons ---------------- */
  // The subtitle addons answer with ISO-639-3 codes ("eng", "ron"); the UI
  // stores the shorter 639-1 code ("en", "ro"). `alt` covers codes the addons
  // also send (e.g. "pob" for Brazilian Portuguese, "rum" for Romanian).
  var SUB_LANGS = [
    { code: 'en', name: 'English',        alt: ['eng'] },
    { code: 'ro', name: 'Romanian',       alt: ['ron', 'rum'] },
    { code: 'es', name: 'Spanish',        alt: ['spa'] },
    { code: 'fr', name: 'French',         alt: ['fre', 'fra'] },
    { code: 'de', name: 'German',         alt: ['deu', 'ger'] },
    { code: 'it', name: 'Italian',        alt: ['ita'] },
    { code: 'pt', name: 'Portuguese',     alt: ['por', 'pob'] },
    { code: 'ru', name: 'Russian',        alt: ['rus'] },
    { code: 'tr', name: 'Turkish',        alt: ['tur'] },
    { code: 'nl', name: 'Dutch',          alt: ['nld', 'dut'] },
    { code: 'pl', name: 'Polish',         alt: ['pol'] },
    { code: 'sv', name: 'Swedish',        alt: ['swe'] },
    { code: 'da', name: 'Danish',         alt: ['dan'] },
    { code: 'no', name: 'Norwegian',      alt: ['nor', 'nob', 'nno'] },
    { code: 'fi', name: 'Finnish',        alt: ['fin'] },
    { code: 'el', name: 'Greek',          alt: ['ell', 'gre'] },
    { code: 'cs', name: 'Czech',          alt: ['ces', 'cze'] },
    { code: 'hr', name: 'Croatian',       alt: ['hrv'] },
    { code: 'sl', name: 'Slovenian',      alt: ['slv'] },
    { code: 'he', name: 'Hebrew',         alt: ['heb'] },
    { code: 'ar', name: 'Arabic',         alt: ['ara'] },
    { code: 'zh', name: 'Chinese',        alt: ['zho', 'chi'] },
    { code: 'ja', name: 'Japanese',       alt: ['jpn'] },
    { code: 'ko', name: 'Korean',         alt: ['kor'] },
    { code: 'hi', name: 'Hindi',          alt: ['hin'] },
    { code: 'hu', name: 'Hungarian',      alt: ['hun'] },
    { code: 'uk', name: 'Ukrainian',      alt: ['ukr'] },
    { code: 'bg', name: 'Bulgarian',      alt: ['bul'] },
    { code: 'sr', name: 'Serbian',        alt: ['srp'] },
    { code: 'id', name: 'Indonesian',     alt: ['ind'] },
    { code: 'vi', name: 'Vietnamese',     alt: ['vie'] },
    { code: 'sq', name: 'Albanian',       alt: ['sqi', 'alb'] }
  ];

  function subLangName(code) {
    code = String(code || 'en').toLowerCase();
    for (var i = 0; i < SUB_LANGS.length; i++) if (SUB_LANGS[i].code === code) return SUB_LANGS[i].name;
    return code.toUpperCase();
  }
  function subLangCodes(code) {
    code = String(code || 'en').toLowerCase();
    for (var i = 0; i < SUB_LANGS.length; i++) {
      if (SUB_LANGS[i].code === code) return [code].concat(SUB_LANGS[i].alt);
    }
    return [code];
  }

  // Any installed addon advertising the "subtitles" resource is a source.
  function subtitleAddons() {
    var adds = addons(), out = [];
    for (var i = 0; i < adds.length; i++) {
      var a = adds[i], res = a.resources || [], has = false;
      for (var j = 0; j < res.length; j++) {
        if (res[j] === 'subtitles' || (res[j] && res[j].name === 'subtitles')) { has = true; break; }
      }
      if (has && a.base) out.push(a);
    }
    return out;
  }

  // GET /subtitles/{type}/{id}/{lang}.json on every subtitle addon, then keep
  // only tracks in the language chosen in Settings. The addons often return
  // every language regardless of the requested one, so filter here too.
  function getSubtitles(type, id, lang, cb) {
    type = type || 'movie'; lang = String(lang || 'en').toLowerCase();
    var adds = subtitleAddons(), codes = subLangCodes(lang);
    var out = [], seen = {}, left = adds.length, reported = {}, done = false;
    if (!left || !id) { cb([]); return; }
    // XHR can report a failure through both onreadystatechange and onerror;
    // count each addon only once or we would resolve before slow addons reply.
    function finish(i) {
      if (done || reported[i]) return;
      reported[i] = true;
      if (--left > 0) return;
      done = true;
      out.sort(function (a, b) { return b.score - a.score || a.label.localeCompare(b.label); });
      cb(out);
    }
    for (var i = 0; i < adds.length; i++) {
      (function (addon, idx) {
        // Stremio addon protocol: /subtitles/{type}/{id}.json (what the official
        // apps call). The old "/{id}/{lang}.json" form is not part of the
        // protocol; it is only tried when the standard request returns nothing.
        var path = addon.base + '/subtitles/' + encodeURIComponent(type) + '/' +
          encodeURIComponent(id).replace(/%3A/gi, ':');
        var triedLegacy = false;
        function fetchSubs(url) {
        request(url, function (d) {
          var list = (d && d.subtitles) || [];
          if (!list.length && !triedLegacy) {
            triedLegacy = true; fetchSubs(path + '/' + encodeURIComponent(lang) + '.json'); return;
          }
          for (var k = 0; k < list.length; k++) {
            var s = list[k];
            if (!s || !s.url) continue;
            if (codes.indexOf(String(s.lang || '').toLowerCase()) === -1) continue;
            if (seen[s.url]) continue;
            seen[s.url] = 1;
            // Prefer an exact IMDb match and a close release-group match.
            var score = (s.m === 'i' ? 8 : 0) + (s.g && Number(s.g) <= 2 ? 2 : 0) +
              (/\b(720p|1080p|2160p)\b/i.test(s.subtitleFileName || '') ? 1 : 0);
            out.push({ url: s.url, lang: lang, langName: subLangName(lang), addon: addon.name,
              label: s.subtitleFileName || s.movieReleaseName || ('Subtitle ' + s.id),
              name: s.movieReleaseName || '', releaseGroup: s.releaseGroup || '',
              id: s.id || '', season: s.season || 0, episode: s.episode || 0, score: score });
          }
          finish(idx);
        }, function () {
          if (!triedLegacy) { triedLegacy = true; fetchSubs(path + '/' + encodeURIComponent(lang) + '.json'); return; }
          finish(idx);
        }, 15000);
        }
        fetchSubs(path + '.json');
      })(adds[i], i);
    }
  }

  // Build a catalog path, filling in required extras. Returns null when a
  // required extra we cannot supply (search/language/ids) is needed.
  function catalogPath(cat) {
    var id = String(cat.id).replace(/ /g, '%20');
    var extra = cat.extra || [], q = [];
    for (var i = 0; i < extra.length; i++) {
      var ex = extra[i];
      if (!ex.isRequired) continue;
      if (ex.name === 'genre' && ex.options && ex.options.length) {
        q.push('genre=' + encodeURIComponent(ex.options[0]));
      } else if (ex.name === 'skip') {
        q.push('skip=0');
      } else {
        return null;
      }
    }
    return q.length ? id + '/' + q.join('&') : id;
  }

  // "Popular" exists for both movies and series: name the type in the title
  // ("Popular Movies" / "Popular Series") unless the addon already does.
  function rowTitle(cat) {
    var t = String(cat.name || cat.id || '');
    var word = cat.type === 'movie' ? 'Movies' : cat.type === 'series' ? 'Series' : '';
    if (!word || /movie|film|series|show|tv/i.test(t)) return t;
    return t + ' ' + word;
  }

  // Stored addon lists can contain the same shelf twice: e.g. a manifest
  // "New movies" catalog and the built-in "New Movies 2025" both resolve to
  // Cinemeta's current-year URL. Keep one row per effective URL and one per
  // visible title so Discover never shows duplicate categories.
  function uniqueCatalogJobs(jobs) {
    var seenUrl = {}, seenTitle = {}, out = [], i, j, u, t;
    for (i = 0; i < jobs.length; i++) {
      j = jobs[i];
      u = String(j.url || '').toLowerCase();
      t = String(j.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^\s+|\s+$/g, '');
      if (!u || seenUrl[u] || (t && seenTitle[t])) continue;
      seenUrl[u] = 1;
      if (t) seenTitle[t] = 1;
      out.push(j);
    }
    return out;
  }

  function catalogRows(type, cb, onRow) {
    var ck = type || 'all';
    if (catalogCache[ck]) {
      if (onRow) for (var z = 0; z < catalogCache[ck].length; z++) onRow(catalogCache[ck][z]);
      cb(catalogCache[ck]); return;
    }
    var q = catalogQueues[ck];
    if (!q) {
      var adds = addons(), jobs = [];
      for (var i = 0; i < adds.length; i++) {
        var cs = adds[i].catalogs || [];
        for (var j = 0; j < cs.length; j++) {
          if (type && cs[j].type !== type) continue;
          if (cs[j].type === 'search') continue;
          // Home used to show an empty "Popular Series" shelf on this setup.
          // Discover keeps its own series catalogs; only Home drops this one.
          if (cs[j].type === 'series' && String(cs[j].id).split('/')[0] === 'top') continue;
          var path = catalogPath(cs[j]);
          if (!path) continue;                     // needs an extra we cannot supply
          jobs.push({ addon: adds[i], cat: cs[j], path: path, order: jobs.length });
        }
      }
      if (!jobs.length) { catalogCache[ck] = []; cb([]); return; }
      var raw = {};
      q = catalogQueues[ck] = {
        jobs: jobs, next: 0, rows: [], busy: false, pending: [], onRow: null,
        fetch: function (job, done) {
          var fin = false;
          var guard = setTimeout(function () { if (!fin) { fin = true; raw[job.order] = fallbackItems(job.cat.type); done(); } }, 9000);
          request(job.addon.base + '/catalog/' + job.cat.type + '/' + job.path + '.json',
            function (d) {
              if (fin) return; fin = true; clearTimeout(guard);
              raw[job.order] = (d && d.metas && d.metas.length) ? d.metas : fallbackItems(job.cat.type);
              done();
            },
            function () {
              if (fin) return; fin = true; clearTimeout(guard);
              raw[job.order] = fallbackItems(job.cat.type);
              done();
            }, 8000);
        },
        build: function (job) {
          return { title: rowTitle(job.cat), items: raw[job.order] || fallbackItems(job.cat.type),
            type: job.cat.type, id: job.cat.id, order: job.order, _order: job.order };
        }
      };
    }
    q.onRow = onRow;
    loadRows(q, INITIAL_ROWS, function (rows) {
      if (q.next >= q.jobs.length) catalogCache[ck] = q.rows.slice();
      cb(rows);
    });
  }

  // Next batch of shelves for Home, requested when the user reaches the edge
  // of what has been loaded. Rows arrive through the onRow given to catalogRows.
  function moreCatalogRows(type, cb) {
    var ck = type || 'all', q = catalogQueues[ck];
    if (!q || q.next >= q.jobs.length) { if (cb) cb([]); return; }
    loadRows(q, ROW_BATCH, function (rows) {
      if (q.next >= q.jobs.length) catalogCache[ck] = q.rows.slice();
      if (cb) cb(rows);
    });
  }

  /* ---- Discover: Type + Genre + Sort filters ----
     Genre is sent to the addon as the `genre` extra when the catalog supports
     it (Cinemeta: /catalog/movie/top/genre=Action.json); otherwise the rows
     are filtered on the items' own genres. Sort picks which catalog leads
     (Popular = top, Top rated = imdbRating, Newest = year) and orders the
     titles inside every row. Raw responses are cached per URL, so changing
     only the sort re-orders instantly without new requests. */
  var discoverRaw = {};
  var SORT_CATALOG = { 'Popular': 'top', 'Top rated': 'imdbRating', 'Newest': 'year' };
  function ciIndex(list, v) {
    v = String(v).toLowerCase();
    for (var i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === v) return i;
    return -1;
  }
  function itemGenres(m) {
    var g = m.genres || m.genre || [];
    if (typeof g === 'string') g = g.split(/\s*,\s*/);
    return g;
  }
  function itemYear(m) {
    var r = String(m.releaseInfo || m.year || m.released || '').match(/\d{4}/);
    return r ? parseInt(r[0], 10) : 0;
  }
  function itemRating(m) { return parseFloat(m.imdbRating) || 0; }
  function discoverJob(cat, genre, base) {
    var id = String(cat.id).replace(/ /g, '%20');
    var extra = cat.extra || [], q = [], serverGenre = false;
    if (base === CINEMETA) {
      var cid = String(cat.id).split('/')[0], hasG = false;
      for (var e = 0; e < extra.length; e++) if (extra[e].name === 'genre') hasG = true;
      // The built-in Cinemeta entries carry no "extra" list; Cinemeta's
      // top/imdbRating catalogs do accept ?genre=, and the "year" catalog
      // takes the year as its genre — use the current year, not a stale one.
      if (cid === 'year' && !hasG) id = 'year/genre=' + new Date().getFullYear();
      else if ((cid === 'top' || cid === 'imdbRating') && !hasG) extra = extra.concat([{ name: 'genre' }]);
    }
    for (var i = 0; i < extra.length; i++) {
      var ex = extra[i], opts = ex.options || [];
      if (ex.name === 'genre') {
        var years = opts.length && /^\d{4}$/.test(String(opts[0]));
        if (years) {                     // Cinemeta "year" catalog: genre = year
          if (ex.isRequired) q.push('genre=' + encodeURIComponent(opts[0]));
          continue;
        }
        if (genre !== 'All') {
          var gi = opts.length ? ciIndex(opts, genre) : -2;
          if (gi === -1) return null;     // catalog has no such genre
          q.push('genre=' + encodeURIComponent(gi >= 0 ? opts[gi] : genre));
          serverGenre = true;
        } else if (ex.isRequired) {
          if (!opts.length) return null;
          q.push('genre=' + encodeURIComponent(opts[0]));
        }
      } else if (ex.isRequired) {
        if (ex.name === 'skip') q.push('skip=0'); else return null;
      }
    }
    return { path: q.length ? id + '/' + q.join('&') : id, serverGenre: serverGenre };
  }
  function discoverRows(type, genre, sort, cb, onRow) {
    genre = genre || 'All';
    if (!SORT_CATALOG[sort]) sort = 'Popular';
    var dk = (type || 'all') + '|' + genre + '|' + sort;
    var q = discoverQueues[dk];
    if (!q) {
      var adds = addons(), jobs = [];
      for (var i = 0; i < adds.length; i++) {
        var cs = adds[i].catalogs || [];
        for (var j = 0; j < cs.length; j++) {
          if (type && cs[j].type !== type) continue;
          if (cs[j].type === 'search') continue;
          var dj = discoverJob(cs[j], genre, adds[i].base);
          if (!dj) continue;
          // Title is computed here too, so dedupe can drop a second shelf that
          // would look identical to the user even if its URL differs slightly.
          var ttl = rowTitle(cs[j]);
          if (/^year\/genre=\d{4}$/.test(String(cs[j].id)) && dj.path.indexOf(String(cs[j].id)) < 0)
            ttl = ttl.replace(/\b(19|20)\d\d\b/, String(new Date().getFullYear()));
          // The sort's lead catalog must be first, so put it at the head of
          // the queue before any rows are drawn progressively.
          var lead = String(cs[j].id).split('/')[0] === SORT_CATALOG[sort] ? 0 : 1000;
          jobs.push({ cat: cs[j], url: adds[i].base + '/catalog/' + cs[j].type + '/' + dj.path + '.json',
            title: ttl, serverGenre: dj.serverGenre, order: lead + jobs.length });
        }
      }
      if (!jobs.length) { cb([]); return; }
      jobs.sort(function (a, b) { return a.order - b.order; });
      // Prefer the lead shelf when two catalogs collapse to the same row.
      jobs = uniqueCatalogJobs(jobs);
      if (!jobs.length) { cb([]); return; }
      function buildOne(job) {
        var raw = discoverRaw[job.url];
        if (!raw || !raw.length) {
          if (genre === 'All') raw = fallbackItems(job.cat.type); else return null;
        }
        var items = [], known = false;
        for (var n = 0; n < raw.length; n++) {
          var m = raw[n];
          if (genre !== 'All' && !job.serverGenre) {
            var gs = itemGenres(m);
            if (gs.length) known = true;
            if (ciIndex(gs, genre) < 0) continue;
          }
          items.push({ m: m, n: n });
        }
        if (genre !== 'All' && !job.serverGenre && !known) return null;
        if (sort === 'Top rated') items.sort(function (a, b) { return (itemRating(b.m) - itemRating(a.m)) || (a.n - b.n); });
        else if (sort === 'Newest') items.sort(function (a, b) { return (itemYear(b.m) - itemYear(a.m)) || (itemRating(b.m) - itemRating(a.m)) || (a.n - b.n); });
        var list = [];
        for (var x = 0; x < items.length; x++) list.push(items[x].m);
        if (!list.length) return null;
        var ttl = job.title || rowTitle(job.cat);
        return { title: ttl, items: list, type: job.cat.type, id: job.cat.id,
          order: job.order, _order: job.order };
      }
      q = discoverQueues[dk] = {
        jobs: jobs, next: 0, rows: [], busy: false, pending: [], onRow: null,
        fetch: function (job, done) {
          if (discoverRaw[job.url]) { done(); return; }
          var fin = false;
          var guard = setTimeout(function () { if (!fin) { fin = true; done(); } }, 9000);
          request(job.url, function (d) {
            if (fin) return; fin = true; clearTimeout(guard);
            if (d && d.metas && d.metas.length) discoverRaw[job.url] = d.metas;
            done();
          }, function () {
            if (fin) return; fin = true; clearTimeout(guard);
            done();
          }, 8000);
        },
        build: buildOne
      };
    }
    q.onRow = onRow;
    loadRows(q, INITIAL_ROWS, function (rows) { cb(rows); });
  }

  // Next 2 Discover shelves when the user reaches the loaded edge.
  function moreDiscoverRows(type, genre, sort, cb) {
    genre = genre || 'All';
    if (!SORT_CATALOG[sort]) sort = 'Popular';
    var dk = (type || 'all') + '|' + genre + '|' + sort, q = discoverQueues[dk];
    if (!q || q.next >= q.jobs.length) { if (cb) cb([]); return; }
    loadRows(q, ROW_BATCH, function (rows) { if (cb) cb(rows); });
  }

  /* ---- Extra movie info (optional, user keys) ----
     OMDb: Rotten Tomatoes, Metascore, age rating, box office, awards.
     TMDB: tagline, budget, revenue, user score, release date.
     Source + keys are set in Settings > Movie info. Results are cached in
     memory and on disk for a week, so browsing does not burn the OMDb quota. */
  var EXTRA_TTL = 7 * 864e5, EXTRA_MAX = 400, extraMem = {}, extraWait = {};
  function infoSource() { return U.get('infoSource', 'off'); }        // off | omdb | tmdb | both
  function cleanKey(k) { return String(k || '').replace(/\s+/g, ''); }
  function omdbKey() { return cleanKey(U.get('omdbKey', '')); }
  function tmdbKey() { return cleanKey(U.get('tmdbKey', '')); }
  function jsonGet(url, bearer, cb, timeout) {
    var x = new XMLHttpRequest(), done = false;
    function fin(st, d) { if (done) return; done = true; cb(st, d); }
    try { x.open('GET', url, true); } catch (e) { fin(0, null); return; }
    x.timeout = timeout || 10000;
    if (bearer) x.setRequestHeader('Authorization', 'Bearer ' + bearer);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var d = null;
      try { d = JSON.parse(x.responseText); } catch (e) {}
      fin(x.status, d);
    };
    x.ontimeout = function () { fin(0, null); };
    x.onerror = function () { fin(0, null); };
    try { x.send(); } catch (e) { fin(0, null); }
  }
  function na(v) { return v && v !== 'N/A' ? String(v) : ''; }
  function omdbFetch(imdb, key, cb) {
    jsonGet('https://www.omdbapi.com/?i=' + encodeURIComponent(imdb) + '&apikey=' + encodeURIComponent(key), null, function (st, d) {
      if (!d || d.Response !== 'True') { cb(null, (d && d.Error) || (st ? 'HTTP ' + st : 'No connection')); return; }
      var o = {}, rs = d.Ratings || [];
      for (var i = 0; i < rs.length; i++) {
        if (rs[i].Source === 'Rotten Tomatoes') o.rt = na(rs[i].Value);
        else if (rs[i].Source === 'Metacritic') o.meta = na(String(rs[i].Value).split('/')[0]);
      }
      if (!o.meta) o.meta = na(d.Metascore);
      var r = na(d.Rated);
      if (r && !/^(not rated|unrated)$/i.test(r)) o.rated = r;
      o.boxOffice = na(d.BoxOffice); o.awards = na(d.Awards); o.imdbRating = na(d.imdbRating);
      cb(o);
    });
  }
  function tmdbUrl(path, key) {
    var u = 'https://api.themoviedb.org/3' + path;
    if (key.length <= 40) u += (path.indexOf('?') < 0 ? '?' : '&') + 'api_key=' + encodeURIComponent(key);
    return u;
  }
  function tmdbBearer(key) { return key.length > 40 ? key : null; }   // v4 read token
  function tmdbFetch(imdb, type, key, cb) {
    jsonGet(tmdbUrl('/find/' + encodeURIComponent(imdb) + '?external_source=imdb_id', key), tmdbBearer(key), function (st, d) {
      if (!d || st !== 200) { cb(null, (d && d.status_message) || (st ? 'HTTP ' + st : 'No connection')); return; }
      var mv = d.movie_results || [], tv = d.tv_results || [], kind, hit;
      if (type === 'series' && tv.length) { kind = 'tv'; hit = tv[0]; }
      else if (mv.length) { kind = 'movie'; hit = mv[0]; }
      else if (tv.length) { kind = 'tv'; hit = tv[0]; }
      if (!hit) { cb({}); return; }
      jsonGet(tmdbUrl('/' + kind + '/' + hit.id, key), tmdbBearer(key), function (st2, m) {
        var src = (m && st2 === 200) ? m : hit, o = {};
        if (src.vote_count > 0 && src.vote_average) o.tmdbScore = Math.round(src.vote_average * 10) + '%';
        if (src.tagline) o.tagline = src.tagline;
        if (src.budget > 0) o.budget = src.budget;
        if (src.revenue > 0) o.revenue = src.revenue;
        o.released = src.release_date || src.first_air_date || '';
        cb(o);
      });
    });
  }
  function extraKey(imdb) {
    var src = infoSource();
    var o = (src === 'omdb' || src === 'both') && omdbKey(), t = (src === 'tmdb' || src === 'both') && tmdbKey();
    if (!o && !t) return null;
    return src + '|' + (o ? 'o' : '') + (t ? 't' : '') + '|' + imdb;
  }
  function imdbOf(id) { var m = /^(tt\d+)/.exec(String(id || '')); return m ? m[1] : ''; }
  // Synchronous lookup: the cached extra info, or null (not fetched / off).
  function extraCached(id) {
    var imdb = imdbOf(id), ck = imdb && extraKey(imdb);
    if (!ck) return null;
    if (extraMem[ck]) return extraMem[ck];
    var hit = U.get('extraInfo', {})[ck];
    if (hit && Date.now() - hit.at < EXTRA_TTL) { extraMem[ck] = hit.d; return hit.d; }
    return null;
  }
  function extraInfo(id, type, cb) {
    var imdb = imdbOf(id), ck = imdb && extraKey(imdb);
    if (!ck) { cb(null); return; }
    var c = extraCached(id);
    if (c) { cb(c); return; }
    if (extraWait[ck]) { extraWait[ck].push(cb); return; }
    extraWait[ck] = [cb];
    var src = infoSource(), out = {}, ok = false, pending = 0;
    function merge(o) { if (!o) return; ok = true; for (var k in o) if (o.hasOwnProperty(k) && o[k]) out[k] = o[k]; }
    function done() {
      if (--pending > 0) return;
      if (ok) {
        extraMem[ck] = out;
        var disk = U.get('extraInfo', {}), keys = [];
        disk[ck] = { at: Date.now(), d: out };
        for (var k in disk) if (disk.hasOwnProperty(k)) keys.push(k);
        if (keys.length > EXTRA_MAX) {
          keys.sort(function (a, b) { return disk[a].at - disk[b].at; });
          for (var i = 0; i < keys.length - EXTRA_MAX; i++) delete disk[keys[i]];
        }
        U.set('extraInfo', disk);
      }
      var w = extraWait[ck]; delete extraWait[ck];
      for (var j = 0; j < w.length; j++) w[j](ok ? out : null);
    }
    if ((src === 'omdb' || src === 'both') && omdbKey()) { pending++; omdbFetch(imdb, omdbKey(), function (o) { merge(o); done(); }); }
    if ((src === 'tmdb' || src === 'both') && tmdbKey()) { pending++; tmdbFetch(imdb, type, tmdbKey(), function (o) { merge(o); done(); }); }
  }
  function clearExtraCache() { extraMem = {}; U.set('extraInfo', {}); }
  // True when an OMDb/TMDB lookup will actually happen for this title. Views
  // uses it to reserve the extra lines up front so the description never moves.
  function extraEnabled(id) { return !!extraKey(imdbOf(id)); }
  // Key checks for the setup steps; cb(ok, message, sampleInfo).
  var TEST_ID = 'tt1375666';   // Inception
  function testOmdbKey(key, cb) {
    key = cleanKey(key);
    if (!key) { cb(false, 'No key entered'); return; }
    omdbFetch(TEST_ID, key, function (o, err) { cb(!!o, o ? 'Working' : (err || 'Invalid key'), o); });
  }
  function testTmdbKey(key, cb) {
    key = cleanKey(key);
    if (!key) { cb(false, 'No key entered'); return; }
    tmdbFetch(TEST_ID, 'movie', key, function (o, err) { cb(!!o, o ? 'Working' : (err || 'Invalid key'), o); });
  }

  function getMeta(type, id, cb, err) {
    var mk = type + '|' + id;
    if (metaCache[mk]) { cb(metaCache[mk]); return; }
    var path = '/meta/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + '.json';
    var finished = false;
    function ok(d) {
      if (finished) return;
      if (d && d.meta && (d.meta.name || d.meta.id)) { finished = true; metaCache[mk] = d; cb(d); return true; }
      return false;
    }
    function tryAddons() {
      if (finished) return;
      var adds = addons(), bases = [];
      for (var i = 0; i < adds.length; i++) {
        if (adds[i].base && adds[i].base !== CINEMETA) bases.push(adds[i].base);
      }
      if (!bases.length) { if (err) err('Not found'); return; }
      var tried = 0;
      function one() { if (++tried === bases.length && !finished) { finished = true; if (err) err('Not found'); } }
      for (var j = 0; j < bases.length; j++) {
        (function (base) {
          request(base + path, function (d) { if (!ok(d)) one(); }, one, 10000);
        })(bases[j]);
      }
    }
    // Cinemeta handles IMDb ids; other addons (TMDB etc.) use their own ids.
    request(CINEMETA + path, function (d) { if (!ok(d)) tryAddons(); }, tryAddons, 12000);
  }

  function search(type, query, cb) {
    var q = String(query || '').replace(/^\s+|\s+$/g, '');
    if (!q) { cb([]); return; }
    var lower = q.toLowerCase(), adds = addons(), urls = [], seen = {}, out = [];
    var enc = encodeURIComponent(q);

    // Cinemeta exposes "search" as an extra on its `top` catalog — the old
    // /catalog/{type}/search.json route no longer filters and returns junk.
    urls.push({ url: CINEMETA + '/catalog/' + type + '/top/search=' + enc + '.json', timeout: 12000 });

    // Any other addon advertising a search extra gets a chance too, but a dead
    // addon must never hold the results back.
    for (var i = 0; i < adds.length; i++) {
      var a = adds[i], cs = a.catalogs || [];
      for (var j = 0; j < cs.length; j++) {
        var cat = cs[j], extra = cat.extra || [], can = false;
        for (var e = 0; e < extra.length; e++) if (extra[e].name === 'search') can = true;
        if (!can || cat.type !== type || !a.base || a.base === CINEMETA) continue;
        urls.push({ url: a.base + '/catalog/' + type + '/' + encodeURIComponent(cat.id || 'top') +
          '/search=' + enc + '.json', timeout: 2500 });
      }
    }

    function collect(ms) {
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (!m || !m.id || seen[m.id]) continue;
        seen[m.id] = 1; m.type = m.type || type; out.push(m);
      }
    }
    function combine() {
      var res = [], used = {}, all = fallbackItems(type);
      for (var k = 0; k < all.length; k++) {
        if (all[k].name.toLowerCase().indexOf(lower) >= 0 && !seen[all[k].id]) {
          seen[all[k].id] = 1; res.push(all[k]); used[all[k].id] = 1;
        }
      }
      for (var j = 0; j < out.length; j++) {
        if (!used[out[j].id]) { used[out[j].id] = 1; res.push(out[j]); }
      }
      return res;
    }
    var pending = urls.length, done = false;
    function finish() { if (!done) { done = true; cb(combine()); } }
    var deadline = setTimeout(finish, 3500);
    for (var u = 0; u < urls.length; u++) {
      (function (job) {
        request(job.url, function (d) {
          collect((d && d.metas) || []);
          if (--pending === 0) { clearTimeout(deadline); finish(); }
        }, function () {
          if (--pending === 0) { clearTimeout(deadline); finish(); }
        }, job.timeout);
      })(urls[u]);
    }
  }

  function getStreams(type, id, cb) {
    var list = [], adds = addons(), pending = 0, finished = false;
    for (var i = 0; i < adds.length; i++) {
      if (!adds[i].base) continue;
      pending++;
      (function (addon) {
        request(addon.base + '/stream/' + encodeURIComponent(type) + '/' + encodeURIComponent(id).replace(/%3A/gi, ':') + '.json',
          function (d) {
            if (d && d.streams) for (var k = 0; k < d.streams.length; k++) {
              var s = d.streams[k];
              list.push({ addon: addon.name, name: s.name || addon.name, title: s.title || '',
                description: s.description || '',
                url: s.url, magnet: s.magnet, ytId: s.ytId, infoHash: s.infoHash, fileIdx: s.fileIdx,
                externalUrl: s.externalUrl, behaviorHints: s.behaviorHints || {},
                sources: s.sources || [],
                subtitles: s.subtitles || [] });
            }
            if (--pending === 0) { finished = true; cb(sortStreams(list)); }
          },
          function () { if (--pending === 0 && !finished) { finished = true; cb(sortStreams(list)); } }, 15000);
      })(adds[i]);
    }
    if (pending === 0) cb(sortStreams(list));
  }

  // Direct HTTP/debrid links play natively on the TV, so they always come first.
  function sortStreams(list) {
    var rank = { direct: 0, ext: 1, yt: 2, torrent: 3 };
    for (var i = 0; i < list.length; i++) list[i]._rank = rank[streamKind(list[i])];
    list.sort(function (a, b) {
      if (a._rank !== b._rank) return a._rank - b._rank;
      return 0;
    });
    return list;
  }
  function streamKind(s) {
    if (s.url) return 'direct';
    if (s.externalUrl) return 'ext';
    if (s.ytId) return 'yt';
    return 'torrent';
  }

  // Torrentio packs quality in `name` and seeders/size/provider/languages into
  // an emoji-tagged `title`, e.g.
  //   "👤 450 💾 18.45 GB ⚙️ Rutracker" / "🇬🇧 / 🇷🇺"
  function parseStream(s) {
    var raw = String(s.title || s.description || '');
    var lines = raw.split('\n');
    var nm = String(s.name || '').split('\n');
    var out = {
      title: (lines[0] || '').trim(),
      quality: nm.length > 1 ? nm.slice(1).join(' ').trim() : '',
      source: (nm[0] || '').trim(),
      seeders: null, size: '', provider: '', langs: ''
    };
    var m;
    m = /\uD83D\uDC64\s*(\d+)/.exec(raw);                    // 👤 seeders
    if (m) out.seeders = parseInt(m[1], 10);
    m = /\uD83D\uDCBE\s*([\d.]+\s*[KMGT]i?B)/i.exec(raw);    // 💾 size
    if (m) out.size = m[1].replace(/\s+/, ' ');
    m = /\u2699\uFE0F?\s*([^\n]+)/.exec(raw);                // ⚙ provider
    if (m) out.provider = m[1].trim();
    out.langs = '';
    var langParts = [];
    for (var li = 1; li < lines.length; li++) {
      var ln = String(lines[li] || '').trim();
      if (!ln) continue;
      // Skip the metadata line(s) — only genuine language/audio lines remain.
      if (/\uD83D\uDC64|\uD83D\uDCBE|\u2699/.test(ln)) continue;
      langParts.push(ln);
    }
    out.langs = langParts.join('  ').trim();
    return out;
  }

  // Resolve a stream to a playable URL. Torrents need a streaming server:
  // Stremio's own Android app runs one on 127.0.0.1:11470 and plays
  //   {server}/{infoHash}/{fileIdx}
  // Native edition: the on-device NaCl engine serves torrents locally, just
  // like Stremio Android TV's built-in server. Always local -- a LAN bridge
  // address saved by an older build is ignored, so no PC is ever needed.
  function streamServer() {
    return 'http://127.0.0.1:11470';
  }

  // Base32 info hashes (32 chars, some magnets) -> 40-char hex.
  function b32hex(s) {
    var alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = 0, val = 0, out = '';
    s = s.toUpperCase();
    for (var i = 0; i < s.length; i++) {
      var v = alpha.indexOf(s.charAt(i));
      if (v < 0) return '';
      val = ((val << 5) | v) & 0xffff; bits += 5;
      if (bits >= 8) {
        bits -= 8;
        var b = (val >> bits) & 255;
        out += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return out;
  }
  // The torrent's info hash as lowercase hex (from infoHash or the magnet).
  function infoHash(s) {
    var h = (s && s.infoHash) || '';
    if (!h && s && s.magnet) {
      var m = /btih:([a-zA-Z0-9]+)/i.exec(s.magnet);
      if (m) h = m[1];
    }
    if (/^[0-9a-fA-F]{40}$/.test(h)) return h.toLowerCase();
    if (/^[a-zA-Z2-7]{32}$/.test(h)) return b32hex(h);
    return String(h).toLowerCase();
  }
  // File index; -1 when the addon gave none: the engine then picks the file
  // like the Android server (behaviorHints.filename, else largest video).
  function fileIdx(s) {
    var n = parseInt(s ? s.fileIdx : NaN, 10);
    return (isNaN(n) || n < 0) ? -1 : n;
  }

  function streamUrl(s) {
    if (!s) return '';
    if (s.url) return s.url;
    if (s.externalUrl) return s.externalUrl;
    if (s.ytId) return 'https://www.youtube.com/watch?v=' + s.ytId;
    var hash = infoHash(s);
    if (!hash) return '';
    return streamServer() + '/' + hash + '/' + fileIdx(s);
  }
  function isPlayable(s) { return !!streamUrl(s); }

  function fetchManifest(url, cb) {
    request(url, function (m) {
      var base = url.replace(/\/manifest\.json.*$/, '').replace(/\/$/, '');
      cb(null, { id: m.id, name: m.name || m.id, base: base, manifest: url,
        types: m.types || [], resources: m.resources || [], catalogs: m.catalogs || [] });
    }, function (e) { cb(e); });
  }

  /* local library, optionally synced from the signed-in Stremio account */
  function library() { return U.get('library', []); }
  function syncLibrary(authKey, cb, err) {
    post(API_BASE + '/api/datastoreGet',
      { type: 'DatastoreGet', authKey: authKey, collection: 'libraryItem', ids: [], all: true },
      function (d) {
        if (apiFailed(d)) { if (err) err(apiErrorText(d)); return; }
        // datastoreGet returns a bare array in result; some servers wrap it in {changes}.
        var r = d.result;
        var changes = (r && r.changes) ? r.changes : (r && r.length !== undefined ? r : []);
        var out = [], seen = {}, local = library();
        var w = U.get('watched', {}), pg = U.get('progress', {});
        for (var i = 0; i < changes.length; i++) {
          var it = changes[i];
          if (!it || !it._id) continue;
          if (it.removed && !it.temp) continue;        // removed from library
          var st = it.state || {};
          out.push({ id: it._id, type: it.type, name: it.name, poster: it.poster,
            background: it.background || '', logo: it.logo || '',
            runtime: it.runtime || '', releaseInfo: it.releaseInfo || it.year || '',
            imdbRating: it.imdbRating || '', genres: it.genres || [],
            cast: it.cast || [], description: it.description || '',
            // Where the user left off, so Continue Watching resumes the right episode.
            videoId: st.video_id || '', season: st.season || 0, episode: st.episode || 0,
            lastWatched: st.lastWatched ? (Date.parse(st.lastWatched) || 0) : 0, temp: !!it.temp });
          seen[it._id] = 1;
          // For shows, timesWatched/flaggedWatched mean "some episode was watched",
          // not the whole show -- storing it marked every episode as watched.
          if (it.type === 'series') { if (w[it._id] === true) delete w[it._id]; }
          else if (st.timesWatched > 0 || st.flaggedWatched > 0) w[it._id] = true;
          // Continue Watching uses the current playback offset (timeOffset), not total timeWatched.
          // Stremio stores timeOffset/duration in milliseconds; the player
          // works in seconds (treating ms as s made resume never seek).
          var pos = (st.timeOffset || 0) / 1000, dur = (st.duration || 0) / 1000;
          if (dur > 0 && pos > 0 && pos < dur) {
            var at = st.lastWatched ? Date.parse(st.lastWatched) : 0;
            var mine = pg[it._id];
            // Never let an older account position overwrite newer local progress.
            if (!mine || !mine.at || (at && at > mine.at))
              pg[it._id] = { pct: Math.round(pos / dur * 100), dur: dur, pos: pos, at: at || Date.now(),
                videoId: st.video_id || '', season: st.season || 0, episode: st.episode || 0 };
          }
        }
        for (var j = 0; j < local.length; j++) if (!seen[local[j].id]) out.push(local[j]);
        U.set('library', out); U.set('watched', w); U.set('progress', pg);
        cb(out);
      }, err);
  }
  function inLibrary(id) {
    var l = library();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function addLibrary(item) {
    var l = library();
    if (!inLibrary(item.id)) { l.unshift(item); U.set('library', l); }
  }
  function removeLibrary(id) {
    var l = library(), out = [];
    for (var i = 0; i < l.length; i++) if (l[i].id !== id) out.push(l[i]);
    U.set('library', out);
  }
  function watched(id) { return U.get('watched', {}); }
  function markWatched(id, watchedFlag) {
    var w = watched(); w[id] = watchedFlag ? Date.now() : 0; U.set('watched', w);
  }
  // Per-stream "viewed" markers, keyed by infoHash (torrents) or url.
  function watchedStreams() { return U.get('watchedStreams', {}); }
  function streamWatched(s) {
    var w = watchedStreams();
    var key = (s && (s.infoHash || s.url || s.ytId)) || '';
    return key ? !!w[key] : false;
  }
  function markStreamWatched(s) {
    var key = (s && (s.infoHash || s.url || s.ytId)) || '';
    if (!key) return;
    var w = watchedStreams(); w[key] = Date.now(); U.set('watchedStreams', w);
  }
  function progress(id) {
    var all = U.get('progress', {}), p = all[id];
    if (!p) return null;
    // Entries synced by older builds hold milliseconds (a duration over ~28 h
    // in "seconds"); normalize them so resume works.
    if (p.dur > 100000) { p.dur = p.dur / 1000; p.pos = (p.pos || 0) / 1000; }
    return p;
  }
  // "Finished" even when the last minutes (credits) are skipped: 92 %+, or at
  // most 5 minutes left once past 80 %. Used by auto-mark-watched, Continue
  // Watching and the episode list.
  function finished(p) {
    if (!p) return false;
    var pct = Number(p.pct) || 0, left = (Number(p.dur) || 0) - (Number(p.pos) || 0);
    return pct >= 92 || (pct >= 80 && p.dur > 0 && left <= 300);
  }
  function setProgress(id, pct, dur, pos, videoId) {
    var o = U.get('progress', {});
    var prev = o[id] || {};
    o[id] = { pct: pct, dur: dur, pos: pos, at: Date.now(), videoId: videoId || prev.videoId || '' };
    U.set('progress', o);
  }

  return { extraInfo: extraInfo, extraCached: extraCached, extraEnabled: extraEnabled, clearExtraCache: clearExtraCache,
    testOmdbKey: testOmdbKey, testTmdbKey: testTmdbKey, imdbOf: imdbOf,
    request: request, addons: addons, saveAddons: saveAddons, clearCache: clearCache,
    lastStreams: lastStreams, rememberStream: rememberStream, lastStream: lastStream,
    catalogRows: catalogRows, moreCatalogRows: moreCatalogRows,
    discoverRows: discoverRows, moreDiscoverRows: moreDiscoverRows,
    getMeta: getMeta, cachedMeta: function (type, id) { return metaCache[type + '|' + id] || null; },
    search: search, getStreams: getStreams, fetchManifest: fetchManifest,
    streamUrl: streamUrl, streamServer: streamServer, streamKind: streamKind,
    infoHash: infoHash, fileIdx: fileIdx,
    isPlayable: isPlayable, parseStream: parseStream,
    library: library, syncLibrary: syncLibrary, inLibrary: inLibrary, addLibrary: addLibrary, removeLibrary: removeLibrary,
    watched: watched, markWatched: markWatched, watchedStreams: watchedStreams,
    streamWatched: streamWatched, markStreamWatched: markStreamWatched,
    progress: progress, setProgress: setProgress, finished: finished,
    post: post, login: login, register: register, loginWithToken: loginWithToken, userAddons: userAddons,
    createLinkCode: createLinkCode, readLinkCode: readLinkCode,
    getText: getText, auth: auth, setAuth: setAuth, logout: logout,
    SUB_LANGS: SUB_LANGS, subLangName: subLangName, subLangCodes: subLangCodes,
    subtitleAddons: subtitleAddons, getSubtitles: getSubtitles,
    DEFAULT_ADDONS: DEFAULT_ADDONS };
})();

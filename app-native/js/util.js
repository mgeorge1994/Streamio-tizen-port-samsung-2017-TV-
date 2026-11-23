/* util.js — ES5 helpers for Tizen 3.0 (Chromium 47) */
var U = (function () {
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function attr(s) { return esc(s); }
  function get(key, def) {
    try { var v = localStorage.getItem('stremio_tv_' + key); return v === null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function set(key, val) {
    try { localStorage.setItem('stremio_tv_' + key, JSON.stringify(val)); } catch (e) {}
  }
  function del(key) { try { localStorage.removeItem('stremio_tv_' + key); } catch (e) {} }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }
  function img(src, cls) {
    return '<img src="' + attr(src) + '" class="' + (cls || '') + '" onerror="this.style.display=\'none\'"/>';
  }
  // Single quotes so url() survives being embedded in double-quoted HTML
  // style attributes (player buttons) as well as direct DOM assignments.
  function icon(name) { return "url('assets/icons/" + name + ".svg')"; }
  function posterHtml(item, lazy) {
    var html = '<div class="poster">';
    var hasPoster = !!item.poster;
    // One visual only: a real poster, or a single centered default icon.
    // The title lives below the poster (.card-name); it is never overlaid on the image.
    if (hasPoster) {
      // Catalog shelves keep off-screen posters as data-src and load them in
      // small batches while scrolling, like Android TV's RecyclerView. Only
      // the first visible cards are fetched on page load.
      // opacity (not display:none) keeps the fetch running while the poster is
      // invisible, so the loader can stay up until the real image is decoded.
      var source = lazy ? ' data-src="' + attr(item.poster) + '" style="opacity:0"'
                        : ' src="' + attr(item.poster) + '"';
      html += '<img' + source + ' onload="' +
        'this.style.opacity=\'1\';' +
        'var p=this.parentNode,ph=p.querySelector(\'.ph\');' +
        'if(ph)ph.style.display=\'none\';' +
        '" onerror="' +
        'this.style.display=\'none\';' +
        '"/>';
    }
    // The default card icon is only for titles with no artwork at all. A title
    // with a poster never shows it — not even briefly while the image loads.
    var phStyle = hasPoster ? ' style="display:none"' : '';
    html += '<span class="ph"' + phStyle + '></span>';
    if (item.inCinema) html += '<span class="badge-cinema">IN CINEMA</span>';
    if (item.watched) html += '<span class="badge-watched"></span>';
    if (item.newVideos) html += '<span class="badge-new">' + esc(item.newVideos) + '</span>';
    if (item.progress) html += '<span class="progress"><i style="width:' + Math.max(2, Math.min(100, item.progress)) + '%"></i></span>';
    html += '</div><span class="card-name">' + esc(item.name || '') + '</span>';
    return html;
  }
  function encode(obj) {
    var s = [];
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) s.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    return s.join('&');
  }

  /* YouTube TV style on-screen keyboard: alphabetical letter grid with a &123 symbols page. */
  function keyboard(host, actions, onChar, onDelete) {
    var mode = 'letters', shift = false, shiftKey = null;
    var LETTERS = [
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'BKSP'],
      ['H', 'I', 'J', 'K', 'L', 'M', 'N', '&123'],
      ['O', 'P', 'Q', 'R', 'S', 'T', 'U'],
      ['V', 'W', 'X', 'Y', 'Z', 'SHIFT', '-']
    ];
    var SYMBOLS = [
      ['1', '2', '3', '4', '5', '6', '7', 'BKSP'],
      ['8', '9', '0', '-', '=', '+', '/', 'ABC'],
      ['.', ',', '?', '!', "'", ':', ';'],
      ['@', '#', '$', '%', '^', '&', '*']
    ];
    function render() {
      host.innerHTML = '';
      var rows = mode === 'sym' ? SYMBOLS : LETTERS, firstKey = null;
      function addKey(row, label, fn, wide) {
        var isBackspace = label === 'BKSP', isShift = label === 'SHIFT';
        var cls = 'kb-key' + (wide ? ' wide' : '') + (isBackspace ? ' kb-backspace' : '') +
          (isShift ? ' kb-shift' + (shift ? ' on' : '') : '');
        var k = el('div', cls, isBackspace ? '' : esc(label));
        if (isBackspace) k.style.backgroundImage = U.icon('backspace');
        if (isShift) shiftKey = k;
        k.setAttribute('data-focus', '1');
        k.onclick = fn;
        row.appendChild(k);
        if (!firstKey) firstKey = k;
      }
      for (var r = 0; r < rows.length; r++) {
        var row = el('div', 'kb-row');
        for (var c = 0; c < rows[r].length; c++) {
          (function (ch) {
            addKey(row, ch, function () {
              if (ch === 'BKSP') { if (onDelete) onDelete(); return; }
              if (ch === '&123' || ch === 'ABC') { mode = (mode === 'letters' ? 'sym' : 'letters'); render(); return; }
              if (ch === 'SHIFT') {
                shift = !shift;
                if (shiftKey) {
                  var cls = 'kb-key wide kb-shift' + (shift ? ' on' : '');
                  if ((' ' + shiftKey.className + ' ').indexOf(' focused ') !== -1) cls += ' focused';
                  shiftKey.className = cls;
                }
                return;
              }
              if (onChar) {
                var out = ch;
                if (/^[A-Z]$/.test(out) && !shift) out = out.toLowerCase();
                if (/^[a-z]$/.test(out) && shift) out = out.toUpperCase();
                onChar(out);
              }
            }, ch.length > 1 && ch !== 'BKSP');
          })(rows[r][c]);
        }
        host.appendChild(row);
      }
      var arow = el('div', 'kb-row');
      for (var i = 0; i < actions.length; i++) {
        (function (a) { addKey(arow, a.label, a.fn, true); })(actions[i]);
      }
      host.appendChild(arow);
      if (firstKey) Focus.set(firstKey);
    }
    render();
  }

  return { el: el, qs: qs, qsa: qsa, esc: esc, attr: attr, get: get, set: set, del: del,
    fmtTime: fmtTime, debounce: debounce, img: img, icon: icon, posterHtml: posterHtml, encode: encode,
    keyboard: keyboard };
})();

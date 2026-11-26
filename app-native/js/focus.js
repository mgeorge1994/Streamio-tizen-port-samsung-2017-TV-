/* focus.js — spatial navigation for Samsung Tizen remote (ES5, Chromium 47 safe) */
var Focus = (function () {
  var SELECTOR = '[data-focus],.tab,.card,.btn,.picker-value,.picker-opt,' +
    '.s-row,.st-tab,.md-tab,.kb-key,.pbtn,.pm-row,.m-row,.stream-card,.addon-card,.search-box';
  var current = null;
  var root = null;
  var lastSidebar = null;      // last nav-bar item that had focus
  var backHandler = null;
  var keyHandler = null;
  var changeHandler = null;
  var okTimer = null, okEl = null, okLongFired = false;   // long OK on Continue Watching

  function visible(el) {
    if (!el || (el.offsetParent === null && el.tagName !== 'BODY')) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function candidates() {
    var list = [];
    var scope = root || document;
    var all = scope.querySelectorAll(SELECTOR);
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (visible(e) && e.getAttribute('data-disabled') !== '1') list.push(e);
    }
    return list;
  }
  function inSidebar(el) {
    var p = el;
    while (p && p !== document.body) { if (p.id === 'sidebar') return true; p = p.parentNode; }
    return false;
  }
  function rememberSidebar(el) {
    if (!inSidebar(el)) return;
    lastSidebar = el;
    var id = el.getAttribute('data-tab');
    if (id && typeof U !== 'undefined' && U.set) U.set('lastNavTab', id);
  }
  function rememberedSidebar() {
    if (lastSidebar && visible(lastSidebar)) return lastSidebar;
    // First time into the nav bar since the app started: Home, not the item
    // nearest by position and not a tab remembered from an earlier session.
    var sidebar = document.getElementById('sidebar');
    var home = sidebar ? sidebar.querySelector('[data-tab="board"]') : null;
    if (home && visible(home)) return home;
    return null;
  }
  function set(el) {
    if (!el || !visible(el)) return;
    var prev = current;
    rememberSidebar(el);
    // Guarantee exactly one focused element anywhere in the document.
    var stale = document.querySelectorAll('.focused');
    for (var i = 0; i < stale.length; i++) {
      if (stale[i] !== el) stale[i].className = stale[i].className.replace(/\sfocused/g, '');
    }
    current = el;
    if ((' ' + el.className + ' ').indexOf(' focused ') === -1) el.className += ' focused';
    scrollIntoView(el, prev);
    if (typeof el.onfocusin === 'function') { try { el.onfocusin(); } catch (e) {} }
    if (changeHandler) { try { changeHandler(el); } catch (e) {} }
  }
  function get() { return current; }
  function clear() { if (current) current.className = current.className.replace(/\sfocused/g, ''); current = null; }

  function scrollIntoView(el, prev) {
    // Moving left/right inside the same shelf must not nudge the vertical
    // scroller: on Discover that made the whole row and its title jump.
    var oldRow = prev ? rowOf(prev) : null, newRow = rowOf(el);
    var sameRow = !!(oldRow && newRow && oldRow === newRow);
    var p = el.parentNode;
    while (p && p !== document.body) {
      var st = window.getComputedStyle(p);
      var oy = st.overflowY, ox = st.overflowX;
      var pr = p.getBoundingClientRect(), er = el.getBoundingClientRect();

      if (!sameRow && (oy === 'auto' || oy === 'scroll')) {
        var snapRow = null;
        if (hasClass(p, 'rows-scroll')) {
          var rr = rowOf(el);
          if (rr) {
            var q = rr.parentNode;
            while (q && q !== p) q = q.parentNode;
            if (q === p) snapRow = rr;
          }
        }
        if (snapRow) {
          // One category per screen: align the focused shelf with the top of
          // the scroll viewport, so up/down lands on a whole category.
          // Search has a 120 px fade mask; keep the shelf title below it.
          var shelfFade = hasClass(p, 'search-scroll') ? 120 :
            (parseInt((p.getAttribute && p.getAttribute('data-fade-top')) || '0', 10) || 0);
          p.scrollTop += (snapRow.getBoundingClientRect().top - pr.top) - shelfFade;
        } else {
          // Scroll containers with a faded top edge (data-fade-top) keep the
          // focused row -- including its title -- below the fade band.
          var fadeTop = parseInt((p.getAttribute && p.getAttribute('data-fade-top')) || '0', 10) || 0;
          var topEl = el;
          if (fadeTop) {
            for (var rw = el; rw && rw !== p; rw = rw.parentNode) if (hasClass(rw, 'row')) { topEl = rw; break; }
          }
          var tr = topEl.getBoundingClientRect();
          if (er.bottom > pr.bottom - 24) p.scrollTop += (er.bottom - pr.bottom + 48);
          else if (tr.top < pr.top + 24 + fadeTop) p.scrollTop -= (pr.top + 24 + fadeTop - tr.top);
        }
      }

      if (ox === 'auto' || ox === 'scroll') {
        // The focused poster scales up (~7%) and has a 5 px glow, so a small
        // gutter clips the ring at the left edge when scrolling back. Reserve
        // enough room for the whole ring on both sides.
        var gutter = Math.max(28, Math.round(er.width * 0.08) + 12);
        if (er.left < pr.left + gutter) {
          p.scrollLeft -= (pr.left + gutter - er.left);
        } else if (er.right > pr.right - gutter) {
          p.scrollLeft += (er.right - pr.right + gutter);
        }
        // First item in a shelf always lands flush, never a few pixels short.
        var first = p.querySelector ? p.querySelector('.card') : null;
        if (first && first === el) p.scrollLeft = 0;
      }
      p = p.parentNode;
    }
  }

  /* Region keeps vertical navigation inside the current pane.
     Otherwise the tall sidebar tabs sit "below" a settings row and steal focus. */
  function region(el) {
    var p = el;
    while (p && p !== document.body) {
      if (p.id === 'sidebar') return 'sidebar';
      if (p.id === 'view') return 'view';
      if (p.className && typeof p.className === 'string' &&
          (' ' + p.className + ' ').indexOf(' layer ') !== -1) return 'layer';
      p = p.parentNode;
    }
    return 'other';
  }

  function hasClass(el, c) { return el && typeof el.className === 'string' && (' ' + el.className + ' ').indexOf(' ' + c + ' ') !== -1; }

  /* ---- row-aware navigation for the card shelves on Home / Discover / Library ---- */
  function trackOf(el) {
    var p = el;
    while (p && p !== document.body) {
      if (hasClass(p, 'row-track')) return p;
      p = p.parentNode;
    }
    return null;
  }
  function rowOf(el) {
    var p = el;
    while (p && p !== document.body) {
      if (hasClass(p, 'row')) return p;
      p = p.parentNode;
    }
    return null;
  }
  function cardsIn(track) {
    var out = [], list = track.querySelectorAll('.card');
    for (var i = 0; i < list.length; i++) if (visible(list[i])) out.push(list[i]);
    return out;
  }
  // Nearest focusable item in the left navigation bar, matched by vertical position.
  function sidebarTarget(y) {
    var remembered = rememberedSidebar();
    if (remembered) return remembered;   // returning to the bar restores the last focused tab
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return null;
    var all = sidebar.querySelectorAll('[data-focus],.tab,.side-profile');
    var best = null, bd = 1e9;
    for (var i = 0; i < all.length; i++) {
      if (!visible(all[i])) continue;
      var r = all[i].getBoundingClientRect();
      var d = Math.abs((r.top + r.height / 2) - y);
      if (d < bd) { bd = d; best = all[i]; }
    }
    return best;
  }
  function cardMove(dir) {
    var track = trackOf(current);
    if (!track) return false;
    var cards = cardsIn(track), idx = -1;
    for (var i = 0; i < cards.length; i++) if (cards[i] === current) { idx = i; break; }
    if (idx < 0) return false;

    if (dir === 'left' || dir === 'right') {
      var next = cards[idx + (dir === 'right' ? 1 : -1)];
      if (next) { set(next); return true; }
      // At the first card, Left must reach the navigation bar.
      if (dir === 'left') {
        var r = current.getBoundingClientRect(), target = sidebarTarget(r.top + r.height / 2);
        if (target) { set(target); return true; }
      }
      return false; // let generic navigation handle the edge
    }

    // up/down: move to the nearest card (by x) in the adjacent shelf
    var allRows = (root || document).querySelectorAll('.row');
    var row = rowOf(current), rowIdx = -1;
    for (var r = 0; r < allRows.length; r++) if (allRows[r] === row) { rowIdx = r; break; }
    if (rowIdx < 0) return false;
    var step = (dir === 'down') ? 1 : -1;
    var cx = current.getBoundingClientRect().left;
    for (var n = rowIdx + step; n >= 0 && n < allRows.length; n += step) {
      var t = allRows[n].querySelector('.row-track');
      if (!t) continue;
      var cs = cardsIn(t);
      if (!cs.length) continue;
      var best = cs[0], bd = 1e9;
      for (var k = 0; k < cs.length; k++) {
        var d = Math.abs(cs[k].getBoundingClientRect().left - cx);
        if (d < bd) { bd = d; best = cs[k]; }
      }
      set(best);
      return true;
    }
    return false; // first/last shelf: let generic navigation handle it
  }

  // Search: Down from the field, hint or any keyboard row jumps straight to
  // the first result and lets set() scroll the Movies shelf into view.
  function searchDownToResults(dir) {
    if (dir !== 'down' || !current) return false;
    var results = document.getElementById('search-results');
    if (!results || !results.parentNode) return false;
    var p = current;
    while (p && p !== document.body) {
      if (p === results) return false;   // already in results: let cardMove work
      p = p.parentNode;
    }
    var pg = current;
    while (pg && pg !== document.body && !hasClass(pg, 'page')) pg = pg.parentNode;
    if (!pg || !pg.querySelector || !pg.querySelector('#search-input')) return false;
    var first = results.querySelector('.card');
    if (!first || !visible(first)) return false;
    results.scrollTop = 0;
    set(first);
    return true;
  }

  function move(dir) {
    if (!current || !visible(current)) { var l0 = candidates(); if (l0.length) set(l0[0]); return; }

    // While a dropdown is open it owns navigation, so arrows cycle its options only.
    var p = current;
    while (p && p !== document.body) {
      if (hasClass(p, 'picker-options') && hasClass(p, 'open')) {
        var inner = p.querySelectorAll('[data-focus]'), list = [];
        for (var z = 0; z < inner.length; z++) if (visible(inner[z])) list.push(inner[z]);
        if (list.length) {
          var ix = -1;
          for (var q = 0; q < list.length; q++) if (list[q] === current) { ix = q; break; }
          var step = (dir === 'down' || dir === 'right') ? 1 : -1;
          if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') set(list[(ix + step + list.length) % list.length]);
        }
        return;
      }
      p = p.parentNode;
    }

    // Stream list: treat as one sequence so Right always reaches the next stream,
    // even when the cards wrap onto the next visual line.
    if (hasClass(current, 'stream-card') && (dir === 'left' || dir === 'right')) {
      var all = (root || document).querySelectorAll('.stream-card'), seq = [];
      for (var s = 0; s < all.length; s++) if (visible(all[s])) seq.push(all[s]);
      var si = -1;
      for (var q2 = 0; q2 < seq.length; q2++) if (seq[q2] === current) { si = q2; break; }
      var sn = seq[si + (dir === 'right' ? 1 : -1)];
      if (dir === 'left') {
        // Step back only along the same visual line; from the first stream of
        // a line (or the very first stream) Left goes to the navigation bar,
        // like the card shelves. Up/Down move between lines.
        var c0 = current.getBoundingClientRect();
        if (sn) {
          var p0 = sn.getBoundingClientRect();
          if (Math.abs(p0.top - c0.top) < c0.height / 2 && p0.left < c0.left) { set(sn); return; }
        }
        var nav = sidebarTarget(c0.top + c0.height / 2);
        if (nav) set(nav);
        return;
      }
      if (sn) set(sn);
      return;
    }

    // Search owns Down until focus is already inside the results.
    if (searchDownToResults(dir)) return;

    // Search: Up from the topmost result row returns to the search box and
    // scrolls the results back to the top of the page.
    if (dir === 'up' && hasClass(current, 'card')) {
      var resultsBox = document.getElementById('search-results');
      var thisRow = rowOf(current);
      if (resultsBox && thisRow && thisRow.parentNode === resultsBox &&
          thisRow === resultsBox.querySelector('.row')) {
        resultsBox.scrollTop = 0;
        var pg = resultsBox.parentNode;
        while (pg && pg !== document.body) {
          if (hasClass(pg, 'page')) pg.scrollTop = 0;
          pg = pg.parentNode;
        }
        var sb = U.qs('.search-box');
        if (sb && visible(sb)) { set(sb); return; }
      }
    }

    // Card shelves: strict left/right within a row, nearest card on up/down.
    if (hasClass(current, 'card') && cardMove(dir)) return;

    // Generic spatial navigation for tabs, buttons, keyboard, settings, modals…
    var list = candidates();
    if (!list.length) return;
    var cr = current.getBoundingClientRect();
    var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    var curRegion = region(current);

    // Left from the far edge of the content returns to the nav bar at the
    // item that was last focused there, not whichever one happens to be nearest.
    if (dir === 'left' && curRegion === 'view') {
      var sameLeft = false, probe = list;
      for (var z2 = 0; z2 < probe.length; z2++) {
        if (region(probe[z2]) !== 'view') continue;
        var pr2 = probe[z2].getBoundingClientRect();
        if (pr2.left + pr2.width / 2 < cx - 4) { sameLeft = true; break; }
      }
      if (!sameLeft) {
        var nav = rememberedSidebar() || sidebarTarget(cy);
        if (nav) { set(nav); return; }
      }
    }

    var vertical = (dir === 'up' || dir === 'down');
    var best = null, bestScore = 1e12;

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e === current) continue;
      var cross = region(e) !== curRegion;
      if (vertical && cross) continue;            // never jump sidebar <-> content vertically
      var r = e.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var dx = x - cx, dy = y - cy, primary, secondary;
      if (dir === 'left' || dir === 'right') {
        primary = Math.abs(dx); secondary = Math.abs(dy);
        if (dir === 'left' && dx >= -4) continue;
        if (dir === 'right' && dx <= 4) continue;
      } else {
        primary = Math.abs(dy); secondary = Math.abs(dx);
        if (dir === 'up' && dy >= -4) continue;
        if (dir === 'down' && dy <= 4) continue;
      }
      var score = primary + secondary * 2.4 + (cross ? 3000 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) set(best);
  }

  function first() {
    var list = candidates();
    if (list.length) set(list[0]);
  }

  function onKey(fn) { keyHandler = fn; }
  function onBack(fn) { backHandler = fn; }
  function onChange(fn) { changeHandler = fn; }

  document.addEventListener('keydown', function (ev) {
    var k = ev.keyCode;
    if (keyHandler && keyHandler(k, ev) === true) { ev.preventDefault(); return; }
    if (k === 37) { move('left'); ev.preventDefault(); }
    else if (k === 38) { move('up'); ev.preventDefault(); }
    else if (k === 39) { move('right'); ev.preventDefault(); }
    else if (k === 40) { move('down'); ev.preventDefault(); }
    else if (k === 13 || k === 32) {
      var el = current;
      if (el && hasClass(el, 'cw-card') && typeof el.onlongok === 'function') {
        // Hold OK to open the torrent list; a quick tap still resumes playback.
        if (!okTimer) {
          okEl = el; okLongFired = false;
          okTimer = setTimeout(function () {
            okTimer = null; okLongFired = true;
            try { okEl.onlongok(); } catch (e) {}
          }, 600);
        }
      } else if (el) {
        el.click();
      }
      ev.preventDefault();
    } else if (k === 10009 || k === 461 || k === 8 || k === 27) {
      // Tizen remote Back is 10009; 461/8/27 cover older/web remotes.
      if (backHandler) { ev.preventDefault(); backHandler(); }
    }
  }, false);

  // Quick OK on a Continue Watching card resumes; the timer above only fires
  // when the key is actually held.
  document.addEventListener('keyup', function (ev) {
    var k = ev.keyCode;
    if ((k === 13 || k === 32) && okTimer) {
      clearTimeout(okTimer); okTimer = null;
      if (!okLongFired && okEl) { try { okEl.click(); } catch (e) {} }
      okEl = null;
    }
  }, false);

  return { set: set, get: get, clear: clear, first: first, move: move,
    setRoot: function (r) { root = r; }, getRoot: function () { return root; },
    onKey: onKey, onBack: onBack, onChange: onChange, candidates: candidates };
})();

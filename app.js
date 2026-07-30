/* Book of Mormon Study App
   All data (highlights, notes) is stored locally and, optionally, synced
   through a small Cloudflare Worker (see worker.js) that holds the real
   GitHub credentials server-side. The browser only ever holds a passcode
   for that Worker, never a GitHub token. */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------
  const LS_DATA_KEY = 'bom_study_data_v1';
  const LS_SETTINGS_KEY = 'bom_sync_settings_v2';
  const LS_POSITION_KEY = 'bom_last_position_v1';

  function emptyData() {
    return { version: 1, highlights: [], chapterNotes: {}, verseNotes: {}, verseTags: {}, updatedAt: 0 };
  }

  function loadLocalData() {
    try {
      const raw = localStorage.getItem(LS_DATA_KEY);
      if (!raw) return emptyData();
      const parsed = JSON.parse(raw);
      return Object.assign(emptyData(), parsed);
    } catch (e) {
      console.warn('Could not parse local study data, starting fresh.', e);
      return emptyData();
    }
  }

  function saveLocalData() {
    STATE.data.updatedAt = Date.now();
    localStorage.setItem(LS_DATA_KEY, JSON.stringify(STATE.data));
    scheduleSyncPush();
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS_KEY);
      return raw ? JSON.parse(raw) : { workerUrl: '', passcode: '' };
    } catch (e) {
      return { workerUrl: '', passcode: '' };
    }
  }

  function saveSettings(s) {
    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(s));
  }

  // ---------------------------------------------------------------------
  // Global state
  // ---------------------------------------------------------------------
  const STATE = {
    content: null,           // {books:[...], frontMatter:{...}}
    booksByKey: {},
    data: loadLocalData(),
    settings: loadSettings(),
    currentBook: null,
    currentChapter: 1,
    expandedBooks: new Set(),
    pendingSelection: null,  // {verseEl, bookKey, chapter, verse, start, end}
    syncPushTimer: null,
    selectedTag: null,
  };

  const el = (id) => document.getElementById(id);

  const GOSPEL_LIBRARY_SLUG = {
    '1nephi': '1-ne', '2nephi': '2-ne', jacob: 'jacob', enos: 'enos', jarom: 'jarom',
    omni: 'omni', wordsofmormon: 'w-of-m', mosiah: 'mosiah', alma: 'alma', helaman: 'hel',
    '3nephi': '3-ne', '4nephi': '4-ne', mormon: 'morm', ether: 'ether', moroni: 'moro',
  };

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async function init() {
    const res = await fetch('content.json');
    STATE.content = await res.json();
    STATE.content.books.forEach((b) => (STATE.booksByKey[b.key] = b));

    renderSidebar();
    wireGlobalUI();
    renderSettingsPane();
    renderTagsPane();

    if (STATE.settings.workerUrl && STATE.settings.passcode) {
      await syncPull(true);
    }

    const pos = loadPosition();
    navigateTo(pos.book || STATE.content.books[0].key, pos.chapter || 1, false);
  }

  function loadPosition() {
    try {
      return JSON.parse(localStorage.getItem(LS_POSITION_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function savePosition() {
    localStorage.setItem(LS_POSITION_KEY, JSON.stringify({ book: STATE.currentBook.key, chapter: STATE.currentChapter }));
  }

  // ---------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------
  function renderSidebar() {
    const list = el('bookList');
    list.innerHTML = '';
    STATE.content.books.forEach((book) => {
      const wrap = document.createElement('div');
      wrap.className = 'book-entry';

      const toggle = document.createElement('button');
      toggle.className = 'book-toggle';
      toggle.innerHTML = `<span>${book.name}</span><span class="arrow">▸</span>`;
      toggle.addEventListener('click', () => toggleBook(book.key));
      wrap.appendChild(toggle);

      const grid = document.createElement('div');
      grid.className = 'chapter-grid';
      grid.id = 'chgrid-' + book.key;
      book.chapters.forEach((c) => {
        const btn = document.createElement('button');
        btn.className = 'chapter-btn';
        btn.textContent = c.chapter;
        btn.addEventListener('click', () => navigateTo(book.key, c.chapter));
        grid.appendChild(btn);
      });
      wrap.appendChild(grid);
      list.appendChild(wrap);
    });
  }

  function toggleBook(key) {
    const grid = el('chgrid-' + key);
    const btn = grid.previousElementSibling;
    if (STATE.expandedBooks.has(key)) {
      STATE.expandedBooks.delete(key);
      grid.classList.remove('expanded');
      btn.classList.remove('expanded');
    } else {
      STATE.expandedBooks.add(key);
      grid.classList.add('expanded');
      btn.classList.add('expanded');
    }
  }

  function expandBookOnly(key) {
    STATE.expandedBooks.forEach((k) => {
      el('chgrid-' + k).classList.remove('expanded');
      el('chgrid-' + k).previousElementSibling.classList.remove('expanded');
    });
    STATE.expandedBooks.clear();
    STATE.expandedBooks.add(key);
    el('chgrid-' + key).classList.add('expanded');
    el('chgrid-' + key).previousElementSibling.classList.add('expanded');
  }

  function highlightActiveChapterBtn() {
    document.querySelectorAll('.chapter-btn').forEach((b) => b.classList.remove('active'));
    const grid = el('chgrid-' + STATE.currentBook.key);
    if (grid) {
      const btns = grid.querySelectorAll('.chapter-btn');
      btns.forEach((b) => {
        if (parseInt(b.textContent, 10) === STATE.currentChapter) b.classList.add('active');
      });
    }
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------
  function navigateTo(bookKey, chapterNum, scroll = true) {
    const book = STATE.booksByKey[bookKey];
    if (!book) return;
    const chapter = book.chapters.find((c) => c.chapter === chapterNum);
    if (!chapter) return;
    STATE.currentBook = book;
    STATE.currentChapter = chapterNum;
    expandBookOnly(bookKey);
    highlightActiveChapterBtn();
    renderChapter();
    renderNotesPane();
    renderContextPane();
    renderHighlightsPane();
    savePosition();
    closeMobilePanels();
    if (scroll) {
      try {
        el('main').scrollTo({ top: 0, behavior: 'auto' });
      } catch (e) {
        el('main').scrollTop = 0;
      }
    }
  }

  function currentChapterObj() {
    return STATE.currentBook.chapters.find((c) => c.chapter === STATE.currentChapter);
  }

  // ---------------------------------------------------------------------
  // Rendering the reading pane
  // ---------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function verseKey(bookKey, chapter, verse) {
    return `${bookKey}|${chapter}|${verse}`;
  }
  function chapterKey(bookKey, chapter) {
    return `${bookKey}|${chapter}`;
  }

  function highlightsFor(bookKey, chapter, verse) {
    return STATE.data.highlights.filter(
      (h) => h.book === bookKey && h.chapter === chapter && h.verse === verse
    );
  }

  function renderChapter() {
    const book = STATE.currentBook;
    const chapter = currentChapterObj();
    el('topRef').textContent = `${book.name} ${chapter.chapter}`;

    const area = el('readingArea');
    area.innerHTML = '';

    if (chapter.chapter === 1 && book.intro) {
      const introEl = document.createElement('div');
      introEl.className = 'book-intro';
      introEl.textContent = book.intro;
      area.appendChild(introEl);
    }

    if (chapter.heading) {
      const h = document.createElement('div');
      h.className = 'chapter-heading';
      h.textContent = chapter.heading;
      area.appendChild(h);
    }

    chapter.verses.forEach((v) => {
      const p = document.createElement('span');
      p.className = 'verse';
      p.dataset.verse = v.verse;
      p.style.display = 'block';
      p.style.marginBottom = '2px';

      const numSpan = document.createElement('span');
      numSpan.className = 'verse-num';
      numSpan.textContent = v.verse;
      numSpan.title = 'Click to add/edit a note for this verse';
      numSpan.addEventListener('click', () => openVerseNote(v.verse));
      p.appendChild(numSpan);

      const textSpan = document.createElement('span');
      textSpan.className = 'verse-text';
      textSpan.dataset.rawText = v.text;
      textSpan.innerHTML = renderVerseSegments(v.text, highlightsFor(book.key, chapter.chapter, v.verse));
      p.appendChild(textSpan);

      const noteKey = verseKey(book.key, chapter.chapter, v.verse);
      if (STATE.data.verseNotes[noteKey]) {
        const dot = document.createElement('span');
        dot.className = 'verse-note-dot';
        dot.title = 'This verse has a note';
        dot.addEventListener('click', () => openVerseNote(v.verse));
        p.appendChild(dot);
      }

      const tags = STATE.data.verseTags[noteKey] || [];
      tags.forEach((tag) => {
        const pill = document.createElement('span');
        pill.className = 'verse-tag-pill';
        pill.textContent = tag;
        pill.title = `Browse every verse tagged "${tag}"`;
        pill.addEventListener('click', () => browseTag(tag));
        p.appendChild(pill);
      });

      area.appendChild(p);
    });

    const linkWrap = document.createElement('div');
    linkWrap.id = 'churchLink';
    const q = encodeURIComponent(`${book.name} ${chapter.chapter}`);
    linkWrap.innerHTML = `Study helps on ChurchofJesusChrist.org for <b>${book.name} ${chapter.chapter}</b>:<br>
      <a href="https://www.churchofjesuschrist.org/search?lang=eng&query=${q}" target="_blank" rel="noopener">General search →</a> &nbsp;·&nbsp;
      <a href="https://www.churchofjesuschrist.org/study/general-conference?lang=eng&query=${q}" target="_blank" rel="noopener">General Conference talks →</a> &nbsp;·&nbsp;
      <a href="https://www.churchofjesuschrist.org/study/scriptures/bofm/${GOSPEL_LIBRARY_SLUG[book.key] || book.key}/${chapter.chapter}?lang=eng" target="_blank" rel="noopener">Read on Gospel Library →</a>`;
    area.appendChild(linkWrap);
  }

  function browseTag(tag) {
    STATE.selectedTag = tag;
    renderTagsPane();
    document.querySelector('.rp-tab[data-pane="tagsPane"]').click();
    openMobilePanel();
  }

  // Split verse text into non-overlapping segments based on all annotation
  // boundaries, then render each segment wrapped in nested spans so that
  // overlapping highlighter/underline/box annotations visually stack.
  function renderVerseSegments(text, annotations) {
    if (!annotations.length) return escapeHtml(text);
    const cuts = new Set([0, text.length]);
    annotations.forEach((a) => {
      cuts.add(Math.max(0, Math.min(a.start, text.length)));
      cuts.add(Math.max(0, Math.min(a.end, text.length)));
    });
    const points = Array.from(cuts).sort((a, b) => a - b);
    let html = '';
    for (let i = 0; i < points.length - 1; i++) {
      const segStart = points[i];
      const segEnd = points[i + 1];
      if (segStart === segEnd) continue;
      const covering = annotations.filter((a) => a.start <= segStart && a.end >= segEnd);
      let segHtml = escapeHtml(text.slice(segStart, segEnd));
      if (covering.length) {
        const ids = covering.map((a) => a.id).join(',');
        segHtml = wrapSegment(segHtml, covering, ids);
      }
      html += segHtml;
    }
    return html;
  }

  function wrapSegment(innerHtml, covering, ids) {
    const marks = covering.filter((a) => a.type === 'highlight');
    const underlines = covering.filter((a) => a.type === 'underline');
    const boxes = covering.filter((a) => a.type === 'box');

    let html = innerHtml;
    // marks: nested, multiply-blended backgrounds (stack like real highlighters)
    marks.forEach((m) => {
      html = `<span class="hl-mark" style="background:${m.color}">${html}</span>`;
    });
    // underlines: up to 3 stacked lines at increasing offsets
    underlines.forEach((u, idx) => {
      const cls = 'hl-underline-' + Math.min(idx, 2);
      html = `<span class="${cls}" style="text-decoration-color:${u.color}">${html}</span>`;
    });
    // boxes: stacked box-shadow rings
    if (boxes.length) {
      const shadows = boxes.map((b, idx) => `0 0 0 ${idx + 1}px ${b.color}`).join(', ');
      html = `<span class="hl-box" style="box-shadow:${shadows}">${html}</span>`;
    }
    return `<span class="hl-seg" data-ann-ids="${ids}">${html}</span>`;
  }

  // ---------------------------------------------------------------------
  // Text-selection -> highlight toolbar
  // ---------------------------------------------------------------------
  function getTextOffsetInVerse(verseTextEl, node, nodeOffset) {
    const walker = document.createTreeWalker(verseTextEl, NodeFilter.SHOW_TEXT, null);
    let total = 0;
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + nodeOffset;
      total += n.textContent.length;
    }
    return total;
  }

  function wireVerseSelection() {
    el('readingArea').addEventListener('mouseup', handleSelectionChange);
    el('readingArea').addEventListener('touchend', handleSelectionChange);
  }

  function handleSelectionChange(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    const verseTextEl = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer.closest('.verse-text')
      : range.commonAncestorContainer.parentElement.closest('.verse-text');
    if (!verseTextEl) {
      hideToolbar();
      return;
    }
    const verseEl = verseTextEl.closest('.verse');
    const start = getTextOffsetInVerse(verseTextEl, range.startContainer, range.startOffset);
    const end = getTextOffsetInVerse(verseTextEl, range.endContainer, range.endOffset);
    if (start === end) {
      hideToolbar();
      return;
    }
    // Selections made by touch are handled differently from mouse selections:
    // a floating toolbar positioned right over/near the selected text would
    // sit on top of (or right next to) iOS/Android's native text-selection
    // callout (Copy / Look Up / Share), fighting it for the same screen
    // space and taps. So for touch we show a small docked "Annotate" button
    // instead, and only reveal the full toolbar (as a bottom sheet, away
    // from the selection) once the person deliberately taps it.
    const viaTouch = !!(e && e.type === 'touchend');
    STATE.pendingSelection = {
      bookKey: STATE.currentBook.key,
      chapter: STATE.currentChapter,
      verse: parseInt(verseEl.dataset.verse, 10),
      start: Math.min(start, end),
      end: Math.max(start, end),
      viaTouch,
    };
    if (viaTouch) {
      showAnnotateFab();
    } else {
      showToolbar(range);
    }
  }

  // Find the (textNode, localOffset) pair at a given plain-text character
  // offset within a verse-text element. Inverse of getTextOffsetInVerse —
  // used to re-select the same span of text after a re-render, so the
  // toolbar can stay open across repeated "Apply" clicks for stacking.
  function findNodeAtOffset(container, targetOffset) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let total = 0;
    let n;
    let last = null;
    while ((n = walker.nextNode())) {
      const len = n.textContent.length;
      if (total + len >= targetOffset) {
        return { node: n, offset: targetOffset - total };
      }
      total += len;
      last = n;
    }
    if (last) return { node: last, offset: last.textContent.length };
    return null;
  }

  function restorePendingSelection() {
    const sel = STATE.pendingSelection;
    if (!sel) return null;
    const verseTextEl = document.querySelector(`.verse[data-verse="${sel.verse}"] .verse-text`);
    if (!verseTextEl) return null;
    const startPos = findNodeAtOffset(verseTextEl, sel.start);
    const endPos = findNodeAtOffset(verseTextEl, sel.end);
    if (!startPos || !endPos) return null;
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const winSel = window.getSelection();
    winSel.removeAllRanges();
    winSel.addRange(range);
    return range;
  }

  let activeType = 'highlight';
  let activeColor = '#ffd54f';

  // Desktop/mouse: float the toolbar right above the selection, as before.
  function showToolbar(range) {
    const bar = el('hlToolbar');
    bar.classList.remove('hl-sheet-mode', 'show-open');
    el('hlBackdrop').classList.remove('show');
    el('annotateFab').classList.remove('show');
    let rect;
    try {
      rect = range.getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    bar.classList.add('show');
    if (rect && (rect.top || rect.left)) {
      bar.style.top = Math.max(8, window.scrollY + rect.top - 46) + 'px';
      bar.style.left = Math.max(8, window.scrollX + rect.left) + 'px';
    }
    syncToolbarActiveState();
  }

  // Touch: show a small persistent docked button instead of auto-opening
  // anything over the selection, so nothing competes with the OS's native
  // text-selection callout for space or taps.
  function showAnnotateFab() {
    el('hlToolbar').classList.remove('show', 'show-open');
    el('hlBackdrop').classList.remove('show');
    el('annotateFab').classList.add('show');
  }

  // Touch: open the annotation controls as a bottom sheet, docked to the
  // bottom of the screen (never overlapping the selected text itself).
  function openSheet() {
    el('annotateFab').classList.remove('show');
    const bar = el('hlToolbar');
    bar.style.top = '';
    bar.style.left = '';
    bar.classList.add('hl-sheet-mode', 'show');
    el('hlBackdrop').classList.add('show');
    syncToolbarActiveState();
    requestAnimationFrame(() => bar.classList.add('show-open'));
  }

  function syncToolbarActiveState() {
    document.querySelectorAll('.hl-type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === activeType));
    document.querySelectorAll('.hl-swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === activeColor));
  }

  function hideToolbar() {
    const bar = el('hlToolbar');
    const wasSheet = bar.classList.contains('hl-sheet-mode');
    el('hlBackdrop').classList.remove('show');
    el('annotateFab').classList.remove('show');
    STATE.pendingSelection = null;
    window.getSelection().removeAllRanges();
    if (wasSheet) {
      // let the slide-down transition play before fully hiding
      bar.classList.remove('show-open');
      setTimeout(() => bar.classList.remove('show', 'hl-sheet-mode'), 220);
    } else {
      bar.classList.remove('show');
    }
  }

  function wireToolbar() {
    document.querySelectorAll('.hl-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeType = btn.dataset.type;
        syncToolbarActiveState();
      });
    });
    document.querySelectorAll('.hl-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        activeColor = sw.dataset.color;
        syncToolbarActiveState();
      });
    });
    el('hlApplyBtn').addEventListener('click', applyHighlight);
    el('hlRemoveBtn').addEventListener('click', removeHighlightsInSelection);
    el('hlDoneBtn').addEventListener('click', hideToolbar);
    el('annotateFab').addEventListener('click', openSheet);
    el('hlBackdrop').addEventListener('click', hideToolbar);
    const dismissOutside = (e) => {
      if (e.target.closest('#hlToolbar') || e.target.closest('.verse-text') || e.target.closest('#annotateFab')) return;
      hideToolbar();
    };
    document.addEventListener('mousedown', dismissOutside);
    document.addEventListener('touchstart', dismissOutside, { passive: true });
  }

  // After applying/removing a highlight we re-render the chapter (so the
  // new stacked annotation shows up), then keep the toolbar open on the
  // same selection so you can immediately add another layer (e.g. underline
  // in a different color) without re-selecting the text.
  function reopenToolbarOnSameSelection() {
    if (!STATE.pendingSelection) {
      hideToolbar();
      return;
    }
    if (STATE.pendingSelection.viaTouch) {
      // No need to restore a live browser Selection here — the sheet is
      // positioned independently of it, and the stored start/end offsets
      // are all applyHighlight()/removeHighlightsInSelection() need.
      // Re-creating a live Selection on touch devices can also re-trigger
      // the native selection callout, which is exactly what we're avoiding.
      openSheet();
    } else {
      const range = restorePendingSelection();
      if (range) {
        showToolbar(range);
      } else {
        hideToolbar();
      }
    }
  }

  function applyHighlight() {
    const sel = STATE.pendingSelection;
    if (!sel) return;
    STATE.data.highlights.push({
      id: 'h' + Date.now() + Math.random().toString(36).slice(2, 7),
      book: sel.bookKey,
      chapter: sel.chapter,
      verse: sel.verse,
      start: sel.start,
      end: sel.end,
      type: activeType,
      color: activeColor,
      createdAt: Date.now(),
    });
    saveLocalData();
    renderChapter();
    renderHighlightsPane();
    reopenToolbarOnSameSelection();
  }

  function removeHighlightsInSelection() {
    const sel = STATE.pendingSelection;
    if (!sel) return;
    STATE.data.highlights = STATE.data.highlights.filter((h) => {
      if (h.book !== sel.bookKey || h.chapter !== sel.chapter || h.verse !== sel.verse) return true;
      const overlaps = h.start < sel.end && h.end > sel.start;
      return !overlaps;
    });
    saveLocalData();
    renderChapter();
    renderHighlightsPane();
    reopenToolbarOnSameSelection();
  }

  // ---------------------------------------------------------------------
  // Notes pane
  // ---------------------------------------------------------------------
  let focusedVerseForNote = null;

  function openVerseNote(verseNum) {
    document.querySelector('.rp-tab[data-pane="notesPane"]').click();
    focusedVerseForNote = verseNum;
    renderNotesPane();
    openMobilePanel();
    setTimeout(() => {
      const ta = document.getElementById('vnote-' + verseNum);
      if (ta) ta.focus();
    }, 30);
  }

  function getAllTags() {
    const set = new Set();
    Object.values(STATE.data.verseTags).forEach((tags) => tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }

  function addTagToVerse(bookKey, chapter, verse, raw) {
    const tag = raw.trim().toLowerCase().replace(/[,\n]/g, '');
    if (!tag) return;
    const vKey = verseKey(bookKey, chapter, verse);
    const list = STATE.data.verseTags[vKey] || [];
    if (!list.includes(tag)) {
      list.push(tag);
      STATE.data.verseTags[vKey] = list;
      saveLocalData();
      renderChapter();
      renderNotesPane();
      renderTagsPane();
      refocusTagInput(verse);
    }
  }

  function refocusTagInput(verse) {
    setTimeout(() => {
      const target = document.querySelector(`.tag-picker-btn[data-verse="${verse}"]`)
        || document.querySelector(`.tag-new-input[data-verse="${verse}"]`);
      if (target) target.focus();
    }, 0);
  }

  function removeTagFromVerse(bookKey, chapter, verse, tag) {
    const vKey = verseKey(bookKey, chapter, verse);
    const list = (STATE.data.verseTags[vKey] || []).filter((t) => t !== tag);
    if (list.length) {
      STATE.data.verseTags[vKey] = list;
    } else {
      delete STATE.data.verseTags[vKey];
    }
    saveLocalData();
    renderChapter();
    renderNotesPane();
    renderTagsPane();
  }

  // When set to a verse number, that verse's tag picker shows a free-text
  // "new tag" input instead of the dropdown, so the person can define a
  // brand-new tag; it reverts back to the dropdown once they confirm it (or
  // click/tab away), keeping every later tag choice a pick from that list.
  let addingTagForVerse = null;
  // Which verse's custom dropdown menu is currently open (we render our own
  // menu instead of a native <select> so it matches the app's look instead
  // of the OS's default picker chrome).
  let openTagPickerVerse = null;

  function renderTagPicker(book, chapter, vnum, tagsOnVerse) {
    if (addingTagForVerse === vnum) {
      return `<input class="tag-input tag-new-input" data-verse="${vnum}" placeholder="New tag name…" autocomplete="off">`;
    }
    const isOpen = openTagPickerVerse === vnum;
    const available = getAllTags().filter((t) => !tagsOnVerse.includes(t));
    let menu = '';
    if (isOpen) {
      const optionsHtml = available.length
        ? available.map((t) => `<button type="button" class="tag-picker-option" data-verse="${vnum}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')
        : `<div class="tag-picker-empty">No tags yet</div>`;
      menu = `<div class="tag-picker-menu" data-verse="${vnum}">
          ${optionsHtml}
          <button type="button" class="tag-picker-option tag-picker-new" data-verse="${vnum}">+ New tag…</button>
        </div>`;
    }
    return `<div class="tag-picker">
        <button type="button" class="tag-picker-btn" data-verse="${vnum}">+ tag</button>
        ${menu}
      </div>`;
  }

  function confirmNewTag(book, chapter, vnum, rawValue) {
    addingTagForVerse = null;
    const trimmed = rawValue.trim();
    if (trimmed) {
      addTagToVerse(book.key, chapter.chapter, vnum, trimmed); // re-renders internally
    } else {
      renderNotesPane();
    }
  }

  function renderNotesPane() {
    const pane = el('notesPane');
    const book = STATE.currentBook;
    const chapter = currentChapterObj();
    const cKey = chapterKey(book.key, chapter.chapter);

    let html = `<label>Chapter note — ${book.name} ${chapter.chapter}</label>
      <textarea id="chapterNoteInput" placeholder="Your thoughts on this chapter…">${escapeHtml(STATE.data.chapterNotes[cKey] || '')}</textarea>
      <label style="margin-top:14px">Verse notes &amp; tags</label>`;

    const showVerses = new Set();
    chapter.verses.forEach((v) => {
      const vKey = verseKey(book.key, chapter.chapter, v.verse);
      if (STATE.data.verseNotes[vKey] || (STATE.data.verseTags[vKey] || []).length) showVerses.add(v.verse);
    });
    if (focusedVerseForNote) showVerses.add(focusedVerseForNote);

    if (!showVerses.size) {
      html += `<div class="sync-status">Click any verse number in the reading pane to add a note or tags to it.</div>`;
    } else {
      Array.from(showVerses).sort((a, b) => a - b).forEach((vnum) => {
        const vKey = verseKey(book.key, chapter.chapter, vnum);
        const tags = STATE.data.verseTags[vKey] || [];
        html += `<div class="verse-note-block">
          <div class="vn-ref">${book.name} ${chapter.chapter}:${vnum}</div>
          <div class="vn-tags" data-verse="${vnum}">
            ${tags.map((t) => `<span class="tag-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)} <span class="tag-remove" data-tag="${escapeHtml(t)}">×</span></span>`).join('')}
            ${renderTagPicker(book, chapter, vnum, tags)}
          </div>
          <textarea id="vnote-${vnum}" data-verse="${vnum}" placeholder="Note for this verse…">${escapeHtml(STATE.data.verseNotes[vKey] || '')}</textarea>
        </div>`;
      });
    }
    pane.innerHTML = html;

    const chInput = el('chapterNoteInput');
    chInput.addEventListener('input', debounce(() => {
      STATE.data.chapterNotes[cKey] = chInput.value;
      saveLocalData();
    }, 500));

    pane.querySelectorAll('textarea[data-verse]').forEach((ta) => {
      ta.addEventListener('input', debounce(() => {
        const vnum = parseInt(ta.dataset.verse, 10);
        const vKey = verseKey(book.key, chapter.chapter, vnum);
        if (ta.value.trim()) {
          STATE.data.verseNotes[vKey] = ta.value;
        } else {
          delete STATE.data.verseNotes[vKey];
        }
        saveLocalData();
        renderChapter();
      }, 500));
    });

    pane.querySelectorAll('.tag-picker-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vnum = parseInt(btn.dataset.verse, 10);
        openTagPickerVerse = openTagPickerVerse === vnum ? null : vnum;
        renderNotesPane();
      });
    });
    pane.querySelectorAll('.tag-picker-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const vnum = parseInt(opt.dataset.verse, 10);
        openTagPickerVerse = null;
        if (opt.classList.contains('tag-picker-new')) {
          addingTagForVerse = vnum;
          renderNotesPane();
          refocusTagInput(vnum);
        } else {
          addTagToVerse(book.key, chapter.chapter, vnum, opt.dataset.tag);
        }
      });
    });
    pane.querySelectorAll('.tag-new-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          confirmNewTag(book, chapter, parseInt(input.dataset.verse, 10), input.value);
        } else if (e.key === 'Escape') {
          addingTagForVerse = null;
          renderNotesPane();
        }
      });
      input.addEventListener('blur', () => {
        // give a click on something else (e.g. Escape handling) a moment to
        // land first; if the field is still empty and still "active", just
        // revert to the picklist rather than leaving a blank input behind
        setTimeout(() => {
          if (addingTagForVerse !== null && document.activeElement !== input) {
            confirmNewTag(book, chapter, parseInt(input.dataset.verse, 10), input.value);
          }
        }, 150);
      });
    });
    pane.querySelectorAll('.tag-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const vnum = parseInt(e.target.closest('.vn-tags').dataset.verse, 10);
        removeTagFromVerse(book.key, chapter.chapter, vnum, e.target.dataset.tag);
      });
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ---------------------------------------------------------------------
  // Context pane (historical / study material)
  // ---------------------------------------------------------------------
  function renderContextPane() {
    const pane = el('contextPane');
    const fm = STATE.content.frontMatter;
    const book = STATE.currentBook;
    const chapter = currentChapterObj();
    const q = encodeURIComponent(`${book.name} ${chapter.chapter}`);

    let html = `<label>Study helps</label>
      <div class="sync-status" style="margin-bottom:14px">
        Live links to ChurchofJesusChrist.org, generated for whatever chapter you're reading.<br><br>
        <a href="https://www.churchofjesuschrist.org/search?lang=eng&query=${q}" target="_blank" rel="noopener">Search site for "${book.name} ${chapter.chapter}"</a><br>
        <a href="https://www.churchofjesuschrist.org/study/general-conference?lang=eng&query=${q}" target="_blank" rel="noopener">General Conference talks</a><br>
        <a href="https://www.churchofjesuschrist.org/study/manual/book-of-mormon-seminary-teacher-manual?lang=eng&query=${q}" target="_blank" rel="noopener">Seminary teacher manual</a>
      </div>
      <label>Historical background</label>
      <select id="fmSelect" style="width:100%;padding:6px;margin-bottom:10px;">
        <option value="introduction">Introduction (official)</option>
        <option value="brief_explanation">Brief explanation about the book</option>
        <option value="joseph_smith_testimony">Joseph Smith's account</option>
        <option value="three_witnesses">Testimony of Three Witnesses</option>
        <option value="eight_witnesses">Testimony of Eight Witnesses</option>
      </select>
      <div id="fmText" class="sync-status" style="white-space:pre-wrap;"></div>`;
    pane.innerHTML = html;

    const select = el('fmSelect');
    const textDiv = el('fmText');
    function renderFm() {
      const section = fm[select.value];
      textDiv.textContent = section ? section.text : '';
    }
    select.addEventListener('change', renderFm);
    renderFm();
  }

  // ---------------------------------------------------------------------
  // Highlights pane
  // ---------------------------------------------------------------------
  function renderHighlightsPane() {
    const pane = el('highlightsPane');
    const book = STATE.currentBook;
    const chapter = currentChapterObj();
    const inChapter = STATE.data.highlights.filter((h) => h.book === book.key && h.chapter === chapter.chapter);

    let html = `<label>Highlights in ${book.name} ${chapter.chapter}</label>`;
    if (!inChapter.length) {
      html += `<div class="sync-status">Select any text in the reading pane to highlight, underline, or box it. You can stack multiple types on the same words.</div>`;
    } else {
      inChapter
        .slice()
        .sort((a, b) => a.verse - b.verse || a.start - b.start)
        .forEach((h) => {
          const verseObj = chapter.verses.find((v) => v.verse === h.verse);
          const snippet = verseObj ? verseObj.text.slice(h.start, h.end) : '';
          html += `<div class="hl-list-item" data-verse="${h.verse}">
            <div class="ref">${book.name} ${chapter.chapter}:${h.verse} · ${h.type}</div>
            <div>"${escapeHtml(snippet)}"</div>
          </div>`;
        });
    }
    pane.innerHTML = html;
    pane.querySelectorAll('.hl-list-item').forEach((item) => {
      item.addEventListener('click', () => {
        const v = item.dataset.verse;
        const target = document.querySelector(`.verse[data-verse="${v}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Tags pane — browse every verse carrying a given tag, across all books
  // ---------------------------------------------------------------------
  function getAllTagsWithCounts() {
    const counts = {};
    Object.values(STATE.data.verseTags).forEach((tags) => tags.forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    return Object.entries(counts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }

  function bookOrderIndex(bookKey) {
    return STATE.content.books.findIndex((b) => b.key === bookKey);
  }

  function getVersesForTag(tag) {
    const results = [];
    Object.entries(STATE.data.verseTags).forEach(([key, tags]) => {
      if (!tags.includes(tag)) return;
      const [bookKey, chapterStr, verseStr] = key.split('|');
      const book = STATE.booksByKey[bookKey];
      if (!book) return;
      const chapterNum = parseInt(chapterStr, 10);
      const verseNum = parseInt(verseStr, 10);
      const chObj = book.chapters.find((c) => c.chapter === chapterNum);
      const vObj = chObj && chObj.verses.find((v) => v.verse === verseNum);
      results.push({
        bookKey,
        bookName: book.name,
        chapter: chapterNum,
        verse: verseNum,
        snippet: vObj ? vObj.text.slice(0, 100) : '',
      });
    });
    results.sort((a, b) => bookOrderIndex(a.bookKey) - bookOrderIndex(b.bookKey) || a.chapter - b.chapter || a.verse - b.verse);
    return results;
  }

  function renderTagsPane() {
    const pane = el('tagsPane');
    if (!pane || !STATE.content) return;

    if (!STATE.selectedTag) {
      const allTags = getAllTagsWithCounts();
      let html = `<label>Tags</label>`;
      if (!allTags.length) {
        html += `<div class="sync-status">Add tags to verses from the Notes panel (click a verse number, then type a tag) to browse them here by theme.</div>`;
      } else {
        html += allTags
          .map((t) => `<button class="tag-browse-btn" data-tag="${escapeHtml(t.tag)}">${escapeHtml(t.tag)} <span class="tag-count">${t.count}</span></button>`)
          .join('');
      }
      pane.innerHTML = html;
      pane.querySelectorAll('.tag-browse-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          STATE.selectedTag = btn.dataset.tag;
          renderTagsPane();
        });
      });
    } else {
      const tag = STATE.selectedTag;
      const matches = getVersesForTag(tag);
      let html = `<button class="btn secondary" id="tagBackBtn">← All tags</button>
        <label style="margin-top:12px">"${escapeHtml(tag)}" — ${matches.length} verse${matches.length === 1 ? '' : 's'}</label>`;
      html += matches
        .map(
          (m) => `<div class="hl-list-item" data-book="${m.bookKey}" data-chapter="${m.chapter}" data-verse="${m.verse}">
            <div class="ref">${m.bookName} ${m.chapter}:${m.verse}</div>
            <div>${escapeHtml(m.snippet)}${m.snippet.length >= 100 ? '…' : ''}</div>
          </div>`
        )
        .join('');
      pane.innerHTML = html;
      el('tagBackBtn').addEventListener('click', () => {
        STATE.selectedTag = null;
        renderTagsPane();
      });
      pane.querySelectorAll('.hl-list-item').forEach((item) => {
        item.addEventListener('click', () => {
          navigateTo(item.dataset.book, parseInt(item.dataset.chapter, 10));
          const verseNum = item.dataset.verse;
          setTimeout(() => {
            const target = document.querySelector(`.verse[data-verse="${verseNum}"]`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 60);
        });
      });
    }
  }

  // ---------------------------------------------------------------------
  // Settings / sync pane (talks to a Cloudflare Worker, not GitHub directly)
  // ---------------------------------------------------------------------
  function renderSettingsPane() {
    const pane = el('settingsPane');
    const s = STATE.settings;
    pane.innerHTML = `
      <label style="font-size:13px;margin-bottom:10px;">Sync</label>
      <div class="sync-status" style="margin-bottom:12px">Your notes and highlights sync through a small Cloudflare Worker you deploy (see worker.js in the repo), which holds your GitHub credentials server-side. This app only ever needs the Worker's URL and your passcode — never a GitHub token.</div>
      <div class="settings-row"><label>Worker URL</label><input id="workerUrlInput" value="${escapeHtml(s.workerUrl || '')}" placeholder="https://bom-sync.yourname.workers.dev"></div>
      <div class="settings-row"><label>Passcode</label><input id="passcodeInput" type="password" value="${escapeHtml(s.passcode || '')}" placeholder="whatever passcode you set on the Worker"></div>
      <button class="btn" id="syncSaveBtn">Save settings</button>
      <button class="btn secondary" id="syncPullBtn">Pull</button>
      <button class="btn secondary" id="syncPushBtn">Push</button>
      <div class="sync-status" id="syncStatus"></div>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border)">
      <label>Local backup</label>
      <button class="btn secondary" id="exportBtn">Export my data (.json)</button>
      <button class="btn secondary" id="importBtn">Import data</button>
      <input type="file" id="importFile" accept="application/json" style="display:none">
    `;
    el('syncSaveBtn').addEventListener('click', () => {
      STATE.settings = {
        workerUrl: el('workerUrlInput').value.trim().replace(/\/$/, ''),
        passcode: el('passcodeInput').value.trim(),
      };
      saveSettings(STATE.settings);
      setSyncStatus('Settings saved.');
    });
    el('syncPullBtn').addEventListener('click', () => syncPull(false));
    el('syncPushBtn').addEventListener('click', () => syncPush(true));
    el('exportBtn').addEventListener('click', exportData);
    el('importBtn').addEventListener('click', () => el('importFile').click());
    el('importFile').addEventListener('change', importDataFile);
  }

  function setSyncStatus(msg) {
    const s = el('syncStatus');
    if (s) s.textContent = msg;
  }

  async function syncPull(silent) {
    const s = STATE.settings;
    if (!s.workerUrl || !s.passcode) {
      if (!silent) setSyncStatus('Fill in the Worker URL and passcode first.');
      return;
    }
    setSyncStatus('Pulling…');
    try {
      const res = await fetch(s.workerUrl + '/data', {
        headers: { 'X-Passcode': s.passcode },
      });
      if (res.status === 401) throw new Error('Passcode rejected by Worker.');
      if (!res.ok) throw new Error(`Worker returned ${res.status}`);
      const remoteData = await res.json();
      if (remoteData.notFound) {
        setSyncStatus('No remote data yet — push to create it.');
        return;
      }
      if (!STATE.data.updatedAt || (remoteData.updatedAt || 0) >= STATE.data.updatedAt) {
        STATE.data = Object.assign(emptyData(), remoteData);
        localStorage.setItem(LS_DATA_KEY, JSON.stringify(STATE.data));
        if (STATE.currentBook) {
          renderChapter();
          renderNotesPane();
          renderHighlightsPane();
        }
      }
      setSyncStatus('Synced just now.');
    } catch (e) {
      console.warn(e);
      setSyncStatus('Pull failed: ' + e.message);
    }
  }

  async function syncPush(manual) {
    const s = STATE.settings;
    if (!s.workerUrl || !s.passcode) {
      if (manual) setSyncStatus('Fill in the Worker URL and passcode first.');
      return;
    }
    setSyncStatus('Pushing…');
    try {
      const res = await fetch(s.workerUrl + '/data', {
        method: 'PUT',
        headers: { 'X-Passcode': s.passcode, 'Content-Type': 'application/json' },
        body: JSON.stringify(STATE.data),
      });
      if (res.status === 401) throw new Error('Passcode rejected by Worker.');
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Worker returned ${res.status}: ${errText.slice(0, 150)}`);
      }
      setSyncStatus('Pushed just now.');
    } catch (e) {
      console.warn(e);
      setSyncStatus('Push failed: ' + e.message);
    }
  }

  function scheduleSyncPush() {
    if (!STATE.settings.workerUrl || !STATE.settings.passcode) return;
    clearTimeout(STATE.syncPushTimer);
    STATE.syncPushTimer = setTimeout(() => syncPush(false), 3000);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(STATE.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bom-study-data.json';
    a.click();
  }

  function importDataFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        STATE.data = Object.assign(emptyData(), parsed);
        saveLocalData();
        renderChapter();
        renderNotesPane();
        renderHighlightsPane();
        setGhStatus('Imported local file.');
      } catch (err) {
        alert('Could not read that file: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------
  // Global search (scripture text + notes)
  // ---------------------------------------------------------------------
  function wireSearch() {
    const input = el('globalSearch');
    input.addEventListener('input', debounce(() => runSearch(input.value.trim()), 250));
  }

  function runSearch(query) {
    const box = el('searchResults');
    if (!query || query.length < 2) {
      box.innerHTML = '';
      return;
    }
    const q = query.toLowerCase();
    const results = [];

    // scripture text
    outer: for (const book of STATE.content.books) {
      for (const chapter of book.chapters) {
        for (const v of chapter.verses) {
          if (v.text.toLowerCase().includes(q)) {
            results.push({
              type: 'verse', book: book.key, bookName: book.name, chapter: chapter.chapter, verse: v.verse,
              snippet: snippetAround(v.text, q),
            });
            if (results.length >= 40) break outer;
          }
        }
      }
    }

    // notes
    Object.entries(STATE.data.verseNotes).forEach(([key, text]) => {
      if (text.toLowerCase().includes(q)) {
        const [bookKey, chapter, verse] = key.split('|');
        const book = STATE.booksByKey[bookKey];
        results.push({ type: 'note', book: bookKey, bookName: book ? book.name : bookKey, chapter: +chapter, verse: +verse, snippet: snippetAround(text, q) });
      }
    });
    Object.entries(STATE.data.chapterNotes).forEach(([key, text]) => {
      if (text.toLowerCase().includes(q)) {
        const [bookKey, chapter] = key.split('|');
        const book = STATE.booksByKey[bookKey];
        results.push({ type: 'chapternote', book: bookKey, bookName: book ? book.name : bookKey, chapter: +chapter, snippet: snippetAround(text, q) });
      }
    });

    // tags
    Object.entries(STATE.data.verseTags).forEach(([key, tags]) => {
      const matchingTags = tags.filter((t) => t.includes(q));
      if (matchingTags.length) {
        const [bookKey, chapter, verse] = key.split('|');
        const book = STATE.booksByKey[bookKey];
        results.push({
          type: 'tag', book: bookKey, bookName: book ? book.name : bookKey, chapter: +chapter, verse: +verse,
          snippet: 'Tagged: ' + matchingTags.join(', '),
        });
      }
    });

    if (!results.length) {
      box.innerHTML = `<div class="search-result">No matches.</div>`;
      return;
    }
    box.innerHTML = results
      .slice(0, 60)
      .map((r) => {
        const label = r.type === 'verse' ? `${r.bookName} ${r.chapter}:${r.verse}`
          : r.type === 'note' ? `Note · ${r.bookName} ${r.chapter}:${r.verse}`
          : r.type === 'tag' ? `Tag · ${r.bookName} ${r.chapter}:${r.verse}`
          : `Chapter note · ${r.bookName} ${r.chapter}`;
        return `<div class="search-result" data-book="${r.book}" data-chapter="${r.chapter}" data-verse="${r.verse || ''}">
          <b>${label}</b><span class="snippet">${escapeHtml(r.snippet)}</span>
        </div>`;
      })
      .join('');
    box.querySelectorAll('.search-result').forEach((item) => {
      item.addEventListener('click', () => {
        const bookKey = item.dataset.book;
        const chapter = parseInt(item.dataset.chapter, 10);
        navigateTo(bookKey, chapter);
        const verse = item.dataset.verse;
        if (verse) {
          setTimeout(() => {
            const target = document.querySelector(`.verse[data-verse="${verse}"]`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 60);
        }
      });
    });
  }

  function snippetAround(text, q) {
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return text.slice(0, 80);
    const start = Math.max(0, idx - 30);
    const end = Math.min(text.length, idx + q.length + 40);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  // ---------------------------------------------------------------------
  // Misc UI wiring
  // ---------------------------------------------------------------------
  function wireGlobalUI() {
    wireSearch();
    wireToolbar();
    wireVerseSelection();

    document.querySelectorAll('.rp-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.rp-tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.rp-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        el(tab.dataset.pane).classList.add('active');
      });
    });

    el('prevChapterBtn').addEventListener('click', () => step(-1));
    el('nextChapterBtn').addEventListener('click', () => step(1));

    el('menuBtn').addEventListener('click', () => el('sidebar').classList.toggle('open'));
    el('panelBtn').addEventListener('click', openMobilePanel);

    window.addEventListener('beforeunload', () => {
      if (STATE.settings.workerUrl && STATE.settings.passcode) syncPush(false);
    });

    // Close the tag picker dropdown when clicking/tapping anywhere outside it.
    const closeTagPickerOutside = (e) => {
      if (openTagPickerVerse !== null && !e.target.closest('.tag-picker')) {
        openTagPickerVerse = null;
        renderNotesPane();
      }
    };
    document.addEventListener('mousedown', closeTagPickerOutside);
    document.addEventListener('touchstart', closeTagPickerOutside, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openTagPickerVerse !== null) {
        openTagPickerVerse = null;
        renderNotesPane();
      }
    });
  }

  function openMobilePanel() {
    el('rightpanel').classList.add('open');
  }
  function closeMobilePanels() {
    el('sidebar').classList.remove('open');
  }

  function step(dir) {
    const book = STATE.currentBook;
    const idx = book.chapters.findIndex((c) => c.chapter === STATE.currentChapter);
    if (idx + dir >= 0 && idx + dir < book.chapters.length) {
      navigateTo(book.key, book.chapters[idx + dir].chapter);
      return;
    }
    // move to next/prev book
    const bIdx = STATE.content.books.findIndex((b) => b.key === book.key);
    if (dir === 1 && bIdx + 1 < STATE.content.books.length) {
      const nb = STATE.content.books[bIdx + 1];
      navigateTo(nb.key, nb.chapters[0].chapter);
    } else if (dir === -1 && bIdx - 1 >= 0) {
      const pb = STATE.content.books[bIdx - 1];
      navigateTo(pb.key, pb.chapters[pb.chapters.length - 1].chapter);
    }
  }

  init();
})();

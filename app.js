/* Book of Mormon Study App
   All data (highlights, notes) is stored locally and, optionally, synced
   to a single JSON file in a GitHub repo using a personal access token
   the user supplies. Nothing is sent anywhere else. */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------
  const LS_DATA_KEY = 'bom_study_data_v1';
  const LS_SETTINGS_KEY = 'bom_gh_settings_v1';
  const LS_POSITION_KEY = 'bom_last_position_v1';

  function emptyData() {
    return { version: 1, highlights: [], chapterNotes: {}, verseNotes: {}, updatedAt: 0 };
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
    scheduleGithubPush();
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS_KEY);
      return raw ? JSON.parse(raw) : { owner: '', repo: '', token: '', path: 'data/study-data.json' };
    } catch (e) {
      return { owner: '', repo: '', token: '', path: 'data/study-data.json' };
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
    githubPushTimer: null,
    githubSha: null,
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

    if (STATE.settings.token && STATE.settings.owner && STATE.settings.repo) {
      await githubPull(true);
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
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

    wireVerseSelection();
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

  function handleSelectionChange() {
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
    STATE.pendingSelection = {
      bookKey: STATE.currentBook.key,
      chapter: STATE.currentChapter,
      verse: parseInt(verseEl.dataset.verse, 10),
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
    showToolbar(range);
  }

  let activeType = 'highlight';
  let activeColor = '#ffd54f';

  function showToolbar(range) {
    const bar = el('hlToolbar');
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
  }

  function hideToolbar() {
    el('hlToolbar').classList.remove('show');
    STATE.pendingSelection = null;
  }

  function wireToolbar() {
    document.querySelectorAll('.hl-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeType = btn.dataset.type;
        document.querySelectorAll('.hl-type-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        applyHighlight();
      });
    });
    document.querySelectorAll('.hl-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        activeColor = sw.dataset.color;
        applyHighlight();
      });
    });
    el('hlRemoveBtn').addEventListener('click', removeHighlightsInSelection);
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#hlToolbar') && !e.target.closest('.verse-text')) hideToolbar();
    });
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
    window.getSelection().removeAllRanges();
    hideToolbar();
    renderChapter();
    renderHighlightsPane();
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
    window.getSelection().removeAllRanges();
    hideToolbar();
    renderChapter();
    renderHighlightsPane();
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

  function renderNotesPane() {
    const pane = el('notesPane');
    const book = STATE.currentBook;
    const chapter = currentChapterObj();
    const cKey = chapterKey(book.key, chapter.chapter);

    let html = `<label>Chapter note — ${book.name} ${chapter.chapter}</label>
      <textarea id="chapterNoteInput" placeholder="Your thoughts on this chapter…">${escapeHtml(STATE.data.chapterNotes[cKey] || '')}</textarea>
      <label style="margin-top:14px">Verse notes</label>`;

    const versesWithNotes = chapter.verses.filter((v) => STATE.data.verseNotes[verseKey(book.key, chapter.chapter, v.verse)]);
    const showVerses = [...versesWithNotes.map((v) => v.verse)];
    if (focusedVerseForNote && !showVerses.includes(focusedVerseForNote)) showVerses.push(focusedVerseForNote);

    if (!showVerses.length) {
      html += `<div class="sync-status">Click any verse number in the reading pane to add a note to it.</div>`;
    } else {
      showVerses.sort((a, b) => a - b).forEach((vnum) => {
        const vKey = verseKey(book.key, chapter.chapter, vnum);
        html += `<div class="verse-note-block">
          <div class="vn-ref">${book.name} ${chapter.chapter}:${vnum}</div>
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
  // Settings / GitHub sync pane
  // ---------------------------------------------------------------------
  function renderSettingsPane() {
    const pane = el('settingsPane');
    const s = STATE.settings;
    pane.innerHTML = `
      <label style="font-size:13px;margin-bottom:10px;">GitHub sync</label>
      <div class="sync-status" style="margin-bottom:12px">Your notes and highlights can be stored as a JSON file in a GitHub repo you control, so they follow you across devices. Use a fine-grained personal access token scoped to just that repo (Contents: read and write).</div>
      <div class="settings-row"><label>Repo owner</label><input id="ghOwner" value="${escapeHtml(s.owner || '')}" placeholder="e.g. parkerlake"></div>
      <div class="settings-row"><label>Repo name</label><input id="ghRepo" value="${escapeHtml(s.repo || '')}" placeholder="e.g. scriptureStudyApp"></div>
      <div class="settings-row"><label>File path</label><input id="ghPath" value="${escapeHtml(s.path || 'data/study-data.json')}"></div>
      <div class="settings-row"><label>Personal access token</label><input id="ghToken" type="password" value="${escapeHtml(s.token || '')}" placeholder="github_pat_…"></div>
      <button class="btn" id="ghSaveBtn">Save settings</button>
      <button class="btn secondary" id="ghPullBtn">Pull from GitHub</button>
      <button class="btn secondary" id="ghPushBtn">Push to GitHub</button>
      <div class="sync-status" id="ghStatus"></div>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border)">
      <label>Local backup</label>
      <button class="btn secondary" id="exportBtn">Export my data (.json)</button>
      <button class="btn secondary" id="importBtn">Import data</button>
      <input type="file" id="importFile" accept="application/json" style="display:none">
    `;
    el('ghSaveBtn').addEventListener('click', () => {
      STATE.settings = {
        owner: el('ghOwner').value.trim(),
        repo: el('ghRepo').value.trim(),
        path: el('ghPath').value.trim() || 'data/study-data.json',
        token: el('ghToken').value.trim(),
      };
      saveSettings(STATE.settings);
      setGhStatus('Settings saved.');
    });
    el('ghPullBtn').addEventListener('click', () => githubPull(false));
    el('ghPushBtn').addEventListener('click', () => githubPush(true));
    el('exportBtn').addEventListener('click', exportData);
    el('importBtn').addEventListener('click', () => el('importFile').click());
    el('importFile').addEventListener('change', importDataFile);
  }

  function setGhStatus(msg) {
    const s = el('ghStatus');
    if (s) s.textContent = msg;
  }

  function b64EncodeUnicode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  }
  function b64DecodeUnicode(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function githubPull(silent) {
    const s = STATE.settings;
    if (!s.owner || !s.repo || !s.token) {
      if (!silent) setGhStatus('Fill in owner, repo, and token first.');
      return;
    }
    setGhStatus('Pulling…');
    try {
      const url = `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${s.path}`;
      const res = await fetch(url, {
        headers: { Authorization: `token ${s.token}`, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) {
        setGhStatus('No remote data file yet — push to create one.');
        return;
      }
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const json = await res.json();
      STATE.githubSha = json.sha;
      const remoteData = JSON.parse(b64DecodeUnicode(json.content));
      if (!STATE.data.updatedAt || (remoteData.updatedAt || 0) >= STATE.data.updatedAt) {
        STATE.data = Object.assign(emptyData(), remoteData);
        localStorage.setItem(LS_DATA_KEY, JSON.stringify(STATE.data));
        if (STATE.currentBook) {
          renderChapter();
          renderNotesPane();
          renderHighlightsPane();
        }
      }
      setGhStatus('Synced from GitHub just now.');
    } catch (e) {
      console.warn(e);
      setGhStatus('Pull failed: ' + e.message);
    }
  }

  async function githubPush(manual) {
    const s = STATE.settings;
    if (!s.owner || !s.repo || !s.token) {
      if (manual) setGhStatus('Fill in owner, repo, and token first.');
      return;
    }
    setGhStatus('Pushing…');
    try {
      const url = `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${s.path}`;
      // Always fetch latest sha right before writing to avoid clobbering
      let sha = STATE.githubSha;
      try {
        const head = await fetch(url, { headers: { Authorization: `token ${s.token}`, Accept: 'application/vnd.github+json' } });
        if (head.ok) {
          const headJson = await head.json();
          sha = headJson.sha;
        } else if (head.status === 404) {
          sha = undefined;
        }
      } catch (e) { /* ignore, fall back to cached sha */ }

      const body = {
        message: 'Update study data — ' + new Date().toISOString(),
        content: b64EncodeUnicode(JSON.stringify(STATE.data, null, 1)),
      };
      if (sha) body.sha = sha;

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `token ${s.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GitHub returned ${res.status}: ${errText.slice(0, 150)}`);
      }
      const json = await res.json();
      STATE.githubSha = json.content.sha;
      setGhStatus('Pushed to GitHub just now.');
    } catch (e) {
      console.warn(e);
      setGhStatus('Push failed: ' + e.message);
    }
  }

  function scheduleGithubPush() {
    if (!STATE.settings.token) return;
    clearTimeout(STATE.githubPushTimer);
    STATE.githubPushTimer = setTimeout(() => githubPush(false), 3000);
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

    if (!results.length) {
      box.innerHTML = `<div class="search-result">No matches.</div>`;
      return;
    }
    box.innerHTML = results
      .slice(0, 60)
      .map((r) => {
        const label = r.type === 'verse' ? `${r.bookName} ${r.chapter}:${r.verse}`
          : r.type === 'note' ? `Note · ${r.bookName} ${r.chapter}:${r.verse}`
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
      if (STATE.settings.token) githubPush(false);
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

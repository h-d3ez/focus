/**
 * FOCUS — Premium Todo Application
 * Refactored: high-precision timer · immutable undo · secure import · event delegation · tag filtering
 */

/* ============================================================
   STATE
   ============================================================ */

const state = {
  todos:           [],        // authoritative data store
  filter:          'all',     // 'all' | 'active' | 'completed'
  focusedIndex:    -1,        // keyboard nav cursor into filtered list
  pomodoroId:      null,      // id of task currently under pomodoro
  pomodoroEndTime: null,      // absolute ms timestamp — immune to tab throttling
  pomodoroTimer:   null,      // setInterval handle
  activeTagFilter: null,      // tag string or null for highlight-filter mode
  toastTimers:     [],
};

/* ============================================================
   LOCAL STORAGE
   ============================================================ */

const LS_KEY = 'focus_v2';

function persist() { localStorage.setItem(LS_KEY, JSON.stringify(state.todos)); }

function hydrate() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state.todos = JSON.parse(raw);
  } catch (_) { state.todos = []; }
}

/* ============================================================
   DOM REFERENCES
   ============================================================ */

const $input          = document.getElementById('todoInput');
const $list           = document.getElementById('todoList');
const $counter        = document.getElementById('taskCounter');
const $clearBtn       = document.getElementById('clearCompletedBtn');
const $filterTabs     = document.querySelectorAll('.filter-tab');
const $settingsBtn    = document.getElementById('settingsBtn');
const $settingsPanel  = document.getElementById('settingsPanel');
const $shortcutsBtn   = document.getElementById('shortcutsBtn');
const $shortcutsModal = document.getElementById('shortcutsModal');
const $closeModalBtn  = document.getElementById('closeModalBtn');
const $exportBtn      = document.getElementById('exportBtn');
const $importFile     = document.getElementById('importFile');
const $pomOverlay     = document.getElementById('pomodoroOverlay');
const $toasts         = document.getElementById('toastContainer');
const $tagFilterBar   = document.getElementById('tagFilterBar');
const $tagFilterName  = document.getElementById('tagFilterName');
const $tagFilterClear = document.getElementById('tagFilterClear');

/* ============================================================
   UTILITIES
   ============================================================ */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** HTML-escape a value; always returns a string even for non-strings */
function esc(val) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

/**
 * Strip HTML tags and dangerous characters, then cap length.
 * Used for every field arriving from untrusted import JSON.
 */
function sanitizeStr(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/<[^>]*>/g, '')          // strip any HTML tags
    .replace(/[<>"'`\\]/g, '')        // strip remaining dangerous chars
    .trim()
    .slice(0, maxLen);
}

/** Parse optional hashtag from raw input */
function parseTag(raw) {
  const match = raw.match(/#([a-zA-Z0-9_-]+)/);
  if (!match) return { text: raw.trim(), tag: null };
  return {
    tag:  match[1].toLowerCase().slice(0, 30),
    text: raw.replace(/#[a-zA-Z0-9_-]+/g, '').trim(),
  };
}

/** Format a total-seconds count as MM:SS using ceiling so 60:00 shows until fully elapsed */
function fmtTime(totalSecs) {
  const s = Math.max(0, Math.ceil(totalSecs));
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

/* ============================================================
   DATA LAYER — CRUD  (immutable-snapshot undo pattern)
   ============================================================ */

function addTodo(rawText) {
  const { text, tag } = parseTag(rawText);
  if (!text) return;
  state.todos.unshift({ id: uid(), text, completed: false, createdAt: Date.now(), tag, order: 0 });
  reindex();
  persist();
  render();
}

function toggleTodo(id) {
  const t = state.todos.find(t => t.id === id);
  if (!t) return;
  t.completed = !t.completed;
  if (t.completed && state.pomodoroId === id) stopPomodoro(true);
  persist();
  render();
}

/**
 * Delete with immutable undo.
 * The snapshot is taken BEFORE any splice/reindex so the undo closure
 * restores a pristine copy — no stale indices or ref corruption.
 */
function deleteTodo(id, { silent = false } = {}) {
  const idx = state.todos.findIndex(t => t.id === id);
  if (idx === -1) return;

  if (state.pomodoroId === id) stopPomodoro(true);

  // ── Deep snapshot BEFORE any mutation ──────────────────────
  const snapshot = state.todos.map(t => ({ ...t }));
  const deleted  = snapshot[idx];              // item from the pre-mutation array

  state.todos.splice(idx, 1);
  reindex();
  persist();
  render();

  if (!silent) {
    const label = deleted.text.length > 30 ? deleted.text.slice(0, 30) + '…' : deleted.text;
    showToast(`"${label}" removed`, () => {
      state.todos = snapshot;                  // restore pristine snapshot wholesale
      persist();
      render();
    });
  }
}

/**
 * Clear completed with immutable undo.
 * Snapshot captured before filter/reindex runs.
 */
function clearCompleted() {
  const removed = state.todos.filter(t => t.completed);
  if (!removed.length) return;

  // ── Deep snapshot BEFORE any mutation ──────────────────────
  const snapshot = state.todos.map(t => ({ ...t }));

  state.todos = state.todos.filter(t => !t.completed);
  reindex();
  persist();
  render();

  showToast(
    `${removed.length} completed task${removed.length > 1 ? 's' : ''} cleared`,
    () => { state.todos = snapshot; persist(); render(); }
  );
}

function reindex() { state.todos.forEach((t, i) => { t.order = i; }); }

/* ============================================================
   FILTER & TAG
   ============================================================ */

function filteredTodos() {
  switch (state.filter) {
    case 'active':    return state.todos.filter(t => !t.completed);
    case 'completed': return state.todos.filter(t =>  t.completed);
    default:          return [...state.todos];
  }
  // Note: activeTagFilter dims non-matching items via CSS — it doesn't remove them.
}

function setFilter(f) { state.filter = f; state.focusedIndex = -1; render(); }

/** Toggle tag filter; clicking the same tag twice clears it */
function setTagFilter(tag) {
  state.activeTagFilter = (state.activeTagFilter === tag) ? null : tag;
  render();
}

function clearTagFilter() { state.activeTagFilter = null; render(); }

/* ============================================================
   RENDER
   ============================================================ */

function render() {
  const all     = state.todos;
  const visible = filteredTodos();
  const active  = all.filter(t => !t.completed).length;
  const hasComp = all.some(t => t.completed);

  $counter.textContent = `${active} task${active !== 1 ? 's' : ''} remaining`;
  $clearBtn.classList.toggle('hidden', !hasComp);

  $filterTabs.forEach(tab => {
    const on = tab.dataset.filter === state.filter;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on);
  });

  // Tag filter bar
  const hasTagFilter = !!state.activeTagFilter;
  if ($tagFilterBar) {
    $tagFilterBar.hidden = !hasTagFilter;
    $tagFilterBar.setAttribute('aria-hidden', String(!hasTagFilter));
    if ($tagFilterName && hasTagFilter) $tagFilterName.textContent = `#${state.activeTagFilter}`;
  }

  // List state classes
  $list.classList.toggle('has-pomodoro',  !!state.pomodoroId);
  $list.classList.toggle('filtering-tag', hasTagFilter);

  if (!visible.length) { $list.innerHTML = emptyStateHTML(); return; }

  $list.innerHTML = '';
  visible.forEach(todo => $list.appendChild(buildItem(todo)));
}

function emptyStateHTML() {
  const msgs = {
    all:       ['All caught up.',      'Nothing left to do.'],
    active:    ['Nothing active.',     'All tasks complete!'],
    completed: ['No completed tasks.', 'Finish something first.'],
  };
  const [main, sub] = msgs[state.filter];
  return `<li class="empty-state" aria-label="${main}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
    <p>${main}</p><small>${sub}</small>
  </li>`;
}

/**
 * Build a single list item element.
 * NO event listeners attached here — all routing goes through $list delegation below.
 */
function buildItem(todo) {
  const li = document.createElement('li');

  const isTagMatch = state.activeTagFilter && todo.tag === state.activeTagFilter;

  li.className = [
    'todo-item',
    todo.completed                 ? 'completed'       : '',
    todo.id === state.pomodoroId   ? 'pomodoro-active' : '',
    isTagMatch                     ? 'tag-matched'     : '',
  ].filter(Boolean).join(' ');

  li.dataset.id = todo.id;
  li.setAttribute('draggable', 'true');
  li.setAttribute('tabindex',  '-1');
  li.setAttribute('role',      'listitem');
  li.setAttribute('aria-label', `${todo.completed ? 'Completed: ' : ''}${esc(todo.text)}`);

  // ── Pomodoro inline timer ─────────────────────────────────
  const secsRemaining = (todo.id === state.pomodoroId && state.pomodoroEndTime)
    ? Math.ceil(Math.max(0, state.pomodoroEndTime - Date.now()) / 1000)
    : 25 * 60;

  const pomHTML = todo.id === state.pomodoroId
    ? `<span class="pomodoro-timer" id="pom-display">
         <span class="pom-dot"></span>
         <span class="pom-time">${fmtTime(secsRemaining)}</span>
       </span>`
    : '';

  // ── Tag pill (click-filterable) ───────────────────────────
  const tagHTML = todo.tag
    ? `<span class="tag-pill${isTagMatch ? ' active-filter' : ''}"
            data-tag="${esc(todo.tag)}"
            role="button" tabindex="0"
            aria-label="Filter by #${esc(todo.tag)}">#${esc(todo.tag)}</span>`
    : '';

  // ── Pomodoro control button (incomplete tasks only) ───────
  const pomBtnHTML = !todo.completed
    ? `<button class="action-btn pom-btn" data-id="${esc(todo.id)}"
             title="${todo.id === state.pomodoroId ? 'Stop Pomodoro' : 'Start 25-min Pomodoro'}"
             aria-label="${todo.id === state.pomodoroId ? 'Stop Pomodoro' : 'Start Pomodoro'}">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
           ${todo.id === state.pomodoroId
             ? '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'
             : '<circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>'}
         </svg>
       </button>`
    : '';

  li.innerHTML = `
    <span class="drag-handle" aria-hidden="true">
      <svg viewBox="0 0 10 16" fill="currentColor">
        <circle cx="2" cy="2"  r="1.5"/><circle cx="8" cy="2"  r="1.5"/>
        <circle cx="2" cy="8"  r="1.5"/><circle cx="8" cy="8"  r="1.5"/>
        <circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/>
      </svg>
    </span>
    <input type="checkbox" class="todo-checkbox" id="cb-${esc(todo.id)}"
      ${todo.completed ? 'checked' : ''}
      aria-label="Toggle '${esc(todo.text)}'" />
    <div class="todo-content">
      <span class="todo-text">${esc(todo.text)}</span>
      ${tagHTML}${pomHTML}
    </div>
    <div class="item-actions">
      ${pomBtnHTML}
      <button class="action-btn del-btn" data-id="${esc(todo.id)}"
        title="Delete task" aria-label="Delete '${esc(todo.text)}'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>`;

  // ── No per-element event listeners — all delegated to $list ──
  return li;
}

/* ============================================================
   KEYBOARD NAVIGATION
   ============================================================ */

function listItems()  { return [...$list.querySelectorAll('.todo-item')]; }

function focusItem(idx) {
  const items = listItems();
  if (!items.length) return;
  idx = Math.max(0, Math.min(idx, items.length - 1));
  state.focusedIndex = idx;
  items.forEach((el, i) => el.classList.toggle('focused', i === idx));
  items[idx].focus({ preventScroll: false });
  items[idx].scrollIntoView({ block: 'nearest' });
}

function clearFocus() { listItems().forEach(el => el.classList.remove('focused')); state.focusedIndex = -1; }

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */

function showToast(message, undoCb) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <span class="toast-msg">${esc(message)}</span>
    ${undoCb ? '<button class="toast-undo">Undo</button>' : ''}
    <div class="toast-bar" style="width:100%"></div>`;

  if (undoCb) {
    toast.querySelector('.toast-undo').addEventListener('click', () => {
      dismissToast(toast, true);
      undoCb();
    });
  }

  $toasts.appendChild(toast);
  state.toastTimers.push(setTimeout(() => dismissToast(toast), 4000));
}

function dismissToast(toast, immediate = false) {
  if (toast.classList.contains('leaving')) return;
  toast.classList.add('leaving');
  setTimeout(() => toast.remove(), immediate ? 0 : 250);
}

/* ============================================================
   POMODORO — HIGH-PRECISION DELTA ENGINE
   ============================================================ */

function togglePomodoro(id) {
  (state.pomodoroId === id) ? stopPomodoro() : startPomodoro(id);
}

function startPomodoro(id) {
  if (state.pomodoroId) stopPomodoro(true);

  state.pomodoroId      = id;
  state.pomodoroEndTime = Date.now() + 25 * 60 * 1000;  // absolute target timestamp

  $pomOverlay.classList.add('active');
  document.body.classList.add('pomodoro-focus-mode');    // triggers CSS theme shift

  /*
   * Poll at 250 ms: delta from absolute end-timestamp means browser tab backgrounding,
   * device hibernation, or OS throttling cannot cause the timer to run slow — it
   * always catches up to real elapsed time on next tick.
   */
  state.pomodoroTimer = setInterval(() => {
    const remaining = Math.max(0, state.pomodoroEndTime - Date.now());
    const secs      = Math.ceil(remaining / 1000);

    // Surgical DOM update — only the time text node, avoids full re-render
    const timeEl = document.querySelector('#pom-display .pom-time');
    if (timeEl) timeEl.textContent = fmtTime(secs);

    if (remaining <= 0) {
      stopPomodoro();
      showToast('Pomodoro complete! Time for a break.', null);
    }
  }, 250);

  render();
}

function stopPomodoro(silent = false) {
  clearInterval(state.pomodoroTimer);
  state.pomodoroId      = null;
  state.pomodoroEndTime = null;
  state.pomodoroTimer   = null;
  $pomOverlay.classList.remove('active');
  document.body.classList.remove('pomodoro-focus-mode'); // reverts CSS theme
  if (!silent) render();
}

/* ============================================================
   CENTRALIZED EVENT DELEGATION — single $list listener
   ============================================================ */

let dragSrcId = null;

/**
 * Click routing: delete → pomodoro → tag filter.
 * All three are intercepted on the shared parent; no per-item listeners needed.
 */
$list.addEventListener('click', (e) => {
  const del = e.target.closest('.del-btn');
  if (del) { deleteTodo(del.dataset.id); return; }

  const pom = e.target.closest('.pom-btn');
  if (pom) { e.stopPropagation(); togglePomodoro(pom.dataset.id); return; }

  const tag = e.target.closest('.tag-pill');
  if (tag) { setTagFilter(tag.dataset.tag); return; }
});

/** Checkbox change bubbles reliably to $list */
$list.addEventListener('change', (e) => {
  if (!e.target.classList.contains('todo-checkbox')) return;
  const item = e.target.closest('.todo-item');
  if (item) toggleTodo(item.dataset.id);
});

// ── Drag — all five events delegated through $list ────────────

$list.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.todo-item');
  if (!item) return;
  dragSrcId = item.dataset.id;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

$list.addEventListener('dragover', (e) => {
  e.preventDefault();
  const item = e.target.closest('.todo-item');
  if (!item || item.classList.contains('empty-state')) return;
  e.dataTransfer.dropEffect = 'move';
  if (!item.classList.contains('drag-over')) {
    $list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    item.classList.add('drag-over');
  }
});

$list.addEventListener('dragleave', (e) => {
  const item = e.target.closest('.todo-item');
  // relatedTarget guard prevents spurious fires when crossing child element boundaries
  if (item && !item.contains(e.relatedTarget)) item.classList.remove('drag-over');
});

$list.addEventListener('drop', (e) => {
  e.preventDefault();
  const item = e.target.closest('.todo-item');
  if (!item) return;
  item.classList.remove('drag-over');
  const targetId = item.dataset.id;
  if (!dragSrcId || dragSrcId === targetId) return;

  const si = state.todos.findIndex(t => t.id === dragSrcId);
  const ti = state.todos.findIndex(t => t.id === targetId);
  if (si === -1 || ti === -1) return;

  const [moved] = state.todos.splice(si, 1);
  state.todos.splice(ti, 0, moved);
  reindex();
  persist();
  render();
});

$list.addEventListener('dragend', (e) => {
  const item = e.target.closest('.todo-item');
  if (item) item.classList.remove('dragging');
  $list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragSrcId = null;
});

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */

function exportBackup() {
  const blob = new Blob([JSON.stringify(state.todos, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'todos_backup.json' }).click();
  URL.revokeObjectURL(url);
  showToast('Backup exported.', null);
}

/**
 * Secure import:
 * - Validates root type and each item's required fields.
 * - Sanitizes every string field through sanitizeStr (strips HTML / dangerous chars).
 * - Tag: further restricted to /[a-zA-Z0-9_-]/ only — zero XSS surface even in template literals.
 * - Numeric fields validated with isFinite; booleans coerced safely.
 */
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const raw = JSON.parse(ev.target.result);
      if (!Array.isArray(raw)) throw new Error('Root must be an array');

      const data = raw.map((t, i) => {
        if (typeof t !== 'object' || t === null) throw new Error(`Item[${i}] is not an object`);
        if (typeof t.id   !== 'string' || !t.id.trim())   throw new Error(`Item[${i}] missing id`);
        if (typeof t.text !== 'string' || !t.text.trim()) throw new Error(`Item[${i}] missing text`);

        const rawTag = typeof t.tag === 'string' ? t.tag : '';

        return {
          id:        sanitizeStr(t.id, 50),
          text:      sanitizeStr(t.text, 500),
          completed: Boolean(t.completed),
          createdAt: (typeof t.createdAt === 'number' && isFinite(t.createdAt)) ? t.createdAt : Date.now(),
          // Tag: only alphanumeric, underscore, hyphen — any other character stripped entirely
          tag:       rawTag.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 30) || null,
          order:     (typeof t.order === 'number' && isFinite(t.order)) ? Math.floor(t.order) : i,
        };
      });

      state.todos = data;
      persist();
      render();
      showToast(`${data.length} task${data.length !== 1 ? 's' : ''} imported.`, null);
    } catch (_) {
      showToast('Import failed — invalid backup file.', null);
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   MODAL & SETTINGS HELPERS
   ============================================================ */

const openModal    = () => { $shortcutsModal.classList.add('open');    $shortcutsModal.setAttribute('aria-hidden','false'); $shortcutsBtn.classList.add('active');    $closeModalBtn.focus(); };
const closeModal   = () => { $shortcutsModal.classList.remove('open'); $shortcutsModal.setAttribute('aria-hidden','true');  $shortcutsBtn.classList.remove('active'); };
const toggleModal  = () => $shortcutsModal.classList.contains('open') ? closeModal() : openModal();
const openSettings = () => { $settingsPanel.classList.add('open');     $settingsPanel.setAttribute('aria-hidden','false'); $settingsBtn.classList.add('active'); };
const closeSettings= () => { $settingsPanel.classList.remove('open');  $settingsPanel.setAttribute('aria-hidden','true');  $settingsBtn.classList.remove('active'); };
const toggleSettings=() => $settingsPanel.classList.contains('open') ? closeSettings() : openSettings();

/* ============================================================
   DIRECT (non-list) EVENT LISTENERS
   ============================================================ */

$input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = $input.value.trim();
  if (text) { addTodo(text); $input.value = ''; }
});

$filterTabs.forEach(tab => tab.addEventListener('click', () => setFilter(tab.dataset.filter)));
$clearBtn.addEventListener('click', clearCompleted);
$settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
$shortcutsBtn.addEventListener('click', toggleModal);
$closeModalBtn.addEventListener('click', closeModal);
$shortcutsModal.addEventListener('click', (e) => { if (e.target === $shortcutsModal) closeModal(); });
$exportBtn.addEventListener('click', () => { exportBackup(); closeSettings(); });
$importFile.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) importBackup(f);
  $importFile.value = '';
  closeSettings();
});
$pomOverlay.addEventListener('click', () => { if (state.pomodoroId) stopPomodoro(); });
if ($tagFilterClear) $tagFilterClear.addEventListener('click', clearTagFilter);

document.addEventListener('click', (e) => {
  if ($settingsPanel.classList.contains('open')
    && !$settingsPanel.contains(e.target)
    && !$settingsBtn.contains(e.target)) closeSettings();
});

/* ============================================================
   GLOBAL KEYBOARD SHORTCUTS
   ============================================================ */

document.addEventListener('keydown', (e) => {
  const inInput  = ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);
  const modalOpen = $shortcutsModal.classList.contains('open');

  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); toggleModal(); return; }

  if (e.key === 'Escape') {
    if (modalOpen)                                 { closeModal();     return; }
    if ($settingsPanel.classList.contains('open')) { closeSettings();  return; }
    if (state.activeTagFilter)                     { clearTagFilter(); return; }
    if (state.pomodoroId)                          { stopPomodoro();   return; }
    $input.blur(); clearFocus();
    return;
  }

  if (inInput || modalOpen) return;

  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $input.focus(); clearFocus(); return; }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const items = listItems();
    if (!items.length) return;
    focusItem(state.focusedIndex < items.length - 1 ? state.focusedIndex + 1 : 0);
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const items = listItems();
    if (!items.length) return;
    focusItem(state.focusedIndex > 0 ? state.focusedIndex - 1 : items.length - 1);
    return;
  }

  if (e.key === ' ' && state.focusedIndex >= 0) {
    e.preventDefault();
    const el = listItems()[state.focusedIndex];
    if (!el) return;
    const prev = state.focusedIndex;
    toggleTodo(el.dataset.id);
    requestAnimationFrame(() => { const ni = listItems(); if (ni.length) focusItem(Math.min(prev, ni.length - 1)); });
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && state.focusedIndex >= 0) {
    e.preventDefault();
    const el = listItems()[state.focusedIndex];
    if (!el) return;
    const prev = state.focusedIndex;
    deleteTodo(el.dataset.id);
    requestAnimationFrame(() => { const ni = listItems(); if (ni.length) focusItem(Math.min(prev, ni.length - 1)); });
    return;
  }
});

/* ============================================================
   BOOT
   ============================================================ */

hydrate();
render();

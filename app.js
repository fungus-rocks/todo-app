import { renderInline } from './todo-md.js';
import { parse, refOf, locate } from './formats.js';
import { makeClient } from './github.js';
import { Store } from './store.js';

const $ = (id) => document.getElementById(id);
const els = {
  list: $('list'),
  summary: $('summary'),
  status: $('status'),
  toggleDone: $('toggle-done'),
  toast: $('toast'),
  dialog: $('settings'),
  form: $('settings-form'),
  settingsError: $('settings-error'),
};

const SETTINGS_KEY = 'todo:settings';
const LINGER_MS = 1600; // a task you just checked stays visible this long before hiding
const MIC_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const CHECK_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let settings = {
  token: '',
  repo: '',
  branch: 'main',
  path: 'Todos.md',
  lang: '',
  showDone: false,
  ...storage.get(SETTINGS_KEY, {}),
};
const saveSettings = () => storage.set(SETTINGS_KEY, settings);

let store = null;
let doc = parse('');
let editing = null; // ref of the task being edited in place
let cancelEdit = false;
let draft = null; // the open "new todo" line: { el, input, mic, section, parent }
let deferred = false;
let seenSkipped = 0;
const justDone = new Map();

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- rendering ----------

function render() {
  // Never rebuild the list under someone's thumb while they edit a task.
  if (editing && document.activeElement?.closest?.('.edit')) {
    deferred = true;
    return;
  }
  deferred = false;
  if (store?.loaded) doc = parse(store.text);
  renderHeader();
  if (!store || !store.loaded) {
    draft = null; // the list is replaced wholesale below
    if (!store) return renderWelcome();
    els.list.innerHTML = '<div class="skeleton"></div>'.repeat(3);
    return;
  }

  const now = Date.now();
  const lingering = (t) => now - (justDone.get(lingerKey(t)) ?? 0) < LINGER_MS;
  const visible = (t) => settings.showDone || !t.done || lingering(t) || t.children.some(visible);
  const editingTask = editing && locate(doc, editing);

  const taskHtml = (t) => {
    const i = doc.tasks.indexOf(t);
    const kids = t.children.filter(visible);
    const isEditing = t === editingTask;
    const check = `<button class="check" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}">${CHECK_SVG}</button>`;
    const body = isEditing
      ? `<div class="edit"><input value="${esc(t.text)}" aria-label="Edit todo" enterkeyhint="done" autocapitalize="sentences">
           <div class="actions">${doc.kind === 'table' ? '' : '<button type="button" data-act="subtask">+ Subtask</button>'}<button type="button" data-act="delete" class="danger">Delete</button></div></div>`
      : `<div class="text">${renderInline(t.text) || '&nbsp;'}${(t.badges ?? []).map((b) => ` <span class="badge">${esc(b)}</span>`).join('')}</div>`;
    return `<li class="${t.done ? 'done' : ''}${isEditing ? ' editing' : ''}">
      <div class="row" data-i="${i}">${check}${body}</div>
      ${kids.length ? `<ul class="children">${kids.map(taskHtml).join('')}</ul>` : ''}</li>`;
  };

  renderSections(shownSections(), (s) => {
    const open = s.tasks.filter((t) => !t.done).length;
    const hidden = s.tasks.filter((t) => !visible(t)).length;
    const items = s.tasks.filter((t) => !t.parent && visible(t)).map(taskHtml).join('');
    const title = s.title || 'Inbox';
    return {
      head: `<h2>${esc(title)}</h2><span class="count">${open || ''}</span>
        <button class="add-here" data-add aria-label="Add to ${esc(title)}">+</button>`,
      items:
        (items ? `<ul>${items}</ul>` : `<div class="empty" data-add>${s.tasks.length ? 'All done ✓' : 'Nothing here yet'}</div>`) +
        (hidden ? `<button class="more" data-show-done>${hidden} completed</button>` : ''),
    };
  });
  if (draft && !draft.el.isConnected) draft = null; // its section vanished
}

// Updates sections in place instead of rebuilding the list, so an open
// "new todo" line keeps its focus and keyboard while items change around it.
function renderSections(sections, build) {
  const existing = new Map([...els.list.children].filter((n) => n.dataset.key != null).map((n) => [n.dataset.key, n]));
  let prev = null;
  for (const s of sections) {
    let el = existing.get(s.key);
    if (!el) {
      el = document.createElement('section');
      el.className = 'section';
      el.dataset.key = s.key;
      el.innerHTML = '<div class="section-head"></div><div class="card"><div class="draft-slot"></div><div class="items"></div></div>';
    }
    const { head, items } = build(s);
    el.querySelector('.section-head').innerHTML = head;
    el.querySelector('.items').innerHTML = items;
    const at = prev ? prev.nextSibling : els.list.firstChild;
    if (el !== at) els.list.insertBefore(el, at); // only moves what's out of place
    existing.delete(s.key);
    prev = el;
  }
  // Drop the welcome/skeleton placeholders and any section that no longer exists.
  for (const n of [...els.list.children]) if (n.dataset.key == null || existing.get(n.dataset.key) === n) n.remove();
}

function shownSections() {
  const headed = doc.sections.filter((s) => s.level >= 2);
  return doc.sections.filter((s) => s.level >= 2 || s.tasks.length || (!headed.length && s === doc.sections.at(-1)));
}

function renderHeader() {
  els.status.hidden = !store;
  els.toggleDone.setAttribute('aria-pressed', String(settings.showDone));
  els.toggleDone.title = settings.showDone ? 'Hide completed' : 'Show completed';
  if (!store) {
    els.summary.textContent = 'Not connected';
    return;
  }
  const n = store.pending.length;
  const state = store.status === 'idle' ? 'loading' : store.status;
  els.status.dataset.state = state;
  els.status.querySelector('.label').textContent = {
    loading: store.loaded ? 'Updating' : 'Loading',
    synced: 'Synced',
    saving: 'Saving',
    offline: n ? `Offline · ${n} unsaved` : 'Offline',
    auth: 'Sign in',
    error: 'Sync error',
  }[state];
  if (store.loaded) {
    const open = doc.tasks.filter((t) => !t.done).length;
    const done = doc.tasks.length - open;
    els.summary.textContent = `${open} open${done ? ` · ${done} done` : ''}`;
  } else {
    els.summary.textContent = settings.path;
  }
}

function renderWelcome() {
  els.list.innerHTML = `<div class="welcome">
    <h2>Connect your todo note</h2>
    <p>This app edits one Markdown note in your GitHub repo, the same file Obsidian shows.
       Your phone talks to GitHub directly; there's no server in between.</p>
    <ol>
      <li>On GitHub, <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">create a fine-grained token</a>.</li>
      <li>Repository access: <b>Only select repositories</b>, then pick your vault.</li>
      <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
      <li>Copy the token and paste it here.</li>
    </ol>
    <button class="primary" data-open-settings>Connect GitHub</button>
  </div>`;
}

function defaultSection() {
  const shown = shownSections();
  return shown.find((s) => s.key === doc.defaultSection)?.key ?? shown.find((s) => s.level >= 2)?.key ?? shown[0]?.key ?? '';
}

const lingerKey = (t) => `${t.section.key}\n${t.text}`;

// ---------- actions ----------

function toggle(task) {
  const done = !task.done;
  if (done && !settings.showDone) {
    justDone.set(lingerKey(task), Date.now());
    setTimeout(render, LINGER_MS + 50);
  }
  store.apply({ type: 'toggle', ref: refOf(task), done, at: Date.now() });
}

function startEdit(task) {
  editing = refOf(task);
  render();
  const input = els.list.querySelector('.edit input');
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// Applies the edit and returns the task as it now stands in the note.
function finishEdit(value) {
  if (!editing) return null;
  const ref = editing;
  const task = locate(doc, ref);
  const cancelled = cancelEdit;
  cancelEdit = false;
  editing = null;
  const text = value.trim();
  if (!task || cancelled || !text || text === task.text) {
    render();
    return task;
  }
  const sectionKey = task.section.key;
  store.apply({ type: 'edit', ref, text });
  return doc.tasks.find((t) => t.section.key === sectionKey && t.text === text) ?? null;
}

function remove(task) {
  const count = (t) => t.children.reduce((n, c) => n + 1 + count(c), 0);
  const n = count(task);
  if (n && !confirm(`Delete this todo and its ${n} subtask${n > 1 ? 's' : ''}?`)) return;
  editing = null;
  store.apply({ type: 'delete', ref: refOf(task) });
  toast('Deleted');
}

// ---------- new todo line ----------

// Opens an empty line at the top of a section (or under a task, for a
// subtask) and focuses it. Must run inside the tap so iOS shows the keyboard.
function openDraft(sectionKey, parent = null) {
  if (draft && draft.section === sectionKey && draft.parent?.raw === parent?.raw) return draft.input.focus();
  closeDraft(true);
  const slot = [...els.list.children].find((n) => n.dataset.key === sectionKey)?.querySelector('.draft-slot');
  if (!slot) return;

  const el = document.createElement('div');
  el.className = 'draft';
  el.innerHTML = `<span class="check ghost"></span>
    <div class="draft-body">
      ${parent ? `<div class="draft-hint">Subtask of <b>${esc(locate(doc, parent)?.text ?? '')}</b></div>` : ''}
      <input aria-label="New todo" placeholder="${parent ? 'New subtask' : 'New todo'}" enterkeyhint="done" autocapitalize="sentences" autocomplete="off">
    </div>
    <button type="button" class="round mic" aria-label="Dictate (hold to switch language)">${MIC_SVG}<span class="lang"></span></button>`;
  slot.append(el);
  draft = { el, input: el.querySelector('input'), mic: el.querySelector('.mic'), section: sectionKey, parent };
  updateLangBadge();
  wireDraft(draft);
  draft.input.focus();
  el.scrollIntoView({ block: 'nearest' });
}

function commitDraft() {
  const text = draft.input.value.trim();
  if (!text || !store) return;
  draft.input.value = '';
  store.apply(draft.parent ? { type: 'add', parent: draft.parent, text } : { type: 'add', section: draft.section, text, position: 'top' });
}

function closeDraft(commit) {
  if (!draft) return;
  if (commit) commitDraft();
  if (rec && recInput === draft.input) rec.abort();
  draft.el.remove();
  draft = null;
}

function wireDraft(d) {
  d.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.isComposing || e.keyCode === 229) return; // Enter that picks a Chinese IME candidate
      if (d.input.value.trim()) commitDraft(); // stays open for the next one
      else closeDraft(false);
    } else if (e.key === 'Escape') {
      closeDraft(false);
    }
  });
  // Tapping elsewhere saves what was typed, like Reminders. The delay lets a
  // tap on the mic (which iOS reports as a blur) keep the line open.
  d.input.addEventListener('blur', () => {
    setTimeout(() => {
      if (draft === d && document.activeElement !== d.input && !(rec && recInput === d.input)) closeDraft(true);
    }, 250);
  });
  // Keep the keyboard up while the mic is pressed.
  const keepFocus = (e) => e.preventDefault();
  d.mic.addEventListener('mousedown', keepFocus);
  d.mic.addEventListener('pointerdown', (e) => {
    keepFocus(e);
    held = false;
    if (Recognition) holdTimer = setTimeout(() => ((held = true), switchLang()), 550);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) d.mic.addEventListener(ev, () => clearTimeout(holdTimer));
  d.mic.addEventListener('contextmenu', keepFocus);
  d.mic.addEventListener('click', () => {
    if (held) held = false;
    else listen(d.input, d.mic);
  });
}

// ---------- list events ----------

// Keep focus in the edit box when its action buttons are pressed.
els.list.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.actions button')) e.preventDefault();
});

els.list.addEventListener('click', (e) => {
  const el = e.target;
  if (el.closest('[data-open-settings]')) return openSettings();
  if (el.closest('[data-show-done]')) return setShowDone(true);

  if (el.closest('[data-add]')) return openDraft(el.closest('.section').dataset.key);
  if (el.closest('.draft')) return;

  const row = el.closest('.row[data-i]');
  const task = row && doc.tasks[+row.dataset.i];
  if (!task) return;
  if (el.closest('.check')) return toggle(task);

  const act = el.closest('[data-act]')?.dataset.act;
  if (act) {
    const value = row.querySelector('.edit input')?.value ?? task.text;
    if (act === 'delete') {
      editing = null;
      return remove(task);
    }
    const current = finishEdit(value);
    if (current) openDraft(current.section.key, refOf(current));
    return;
  }
  if (el.closest('a, .edit')) return;
  startEdit(task);
});

els.list.addEventListener('keydown', (e) => {
  if (!e.target.matches('.edit input')) return;
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    e.target.blur();
  } else if (e.key === 'Escape') {
    cancelEdit = true;
    e.target.blur();
  }
});

els.list.addEventListener('focusout', (e) => {
  if (!e.target.matches('.edit input') || !editing) return;
  finishEdit(e.target.value);
  if (deferred) render();
});

// ---------- voice ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let voiceBlocked = false;
let holdTimer = null;
let held = false;

function voiceLang() {
  return settings.lang || (navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
}

let recInput = null;

function listen(input, mic) {
  if (rec) return rec.stop();
  if (!Recognition || voiceBlocked) {
    input.focus();
    return toast('Tap the mic on your keyboard to dictate');
  }
  const before = input.value.trim();
  const joiner = voiceLang().startsWith('zh') ? '' : ' ';
  rec = new Recognition();
  recInput = input;
  rec.lang = voiceLang();
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join('').trim();
    input.value = [before, said].filter(Boolean).join(joiner);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      // Some iOS home-screen apps refuse speech recognition; the keyboard mic always works.
      voiceBlocked = true;
      input.focus();
      toast('Voice is blocked here. Use the mic on your keyboard.');
    } else if (e.error === 'no-speech') {
      toast("Didn't catch that");
    } else if (e.error !== 'aborted') {
      toast(`Voice error: ${e.error}`);
    }
  };
  rec.onend = () => {
    rec = recInput = null;
    mic.classList.remove('live');
    if (input.isConnected) input.focus();
  };
  try {
    rec.start();
    mic.classList.add('live');
  } catch {
    rec = recInput = null;
  }
}

function updateLangBadge() {
  const badge = draft?.mic.querySelector('.lang');
  if (!badge) return;
  badge.hidden = !Recognition;
  badge.textContent = voiceLang().startsWith('zh') ? '中' : 'EN';
}

function switchLang() {
  settings.lang = voiceLang().startsWith('zh') ? 'en-US' : 'zh-CN';
  saveSettings();
  updateLangBadge();
  toast(settings.lang === 'zh-CN' ? 'Voice: 中文' : 'Voice: English');
}

// ---------- header ----------

function setShowDone(on) {
  settings.showDone = on;
  saveSettings();
  render();
}
els.toggleDone.addEventListener('click', () => setShowDone(!settings.showDone));
$('open-settings').addEventListener('click', () => openSettings());
els.status.addEventListener('click', () => {
  if (store?.status === 'auth') return openSettings();
  if (store?.status === 'error') toast(store.error);
  store?.refresh();
});

// ---------- settings ----------

function openSettings() {
  const f = els.form.elements;
  for (const k of ['token', 'repo', 'path', 'branch', 'lang']) f[k].value = settings[k] ?? '';
  els.settingsError.textContent = store?.status === 'auth' ? store.error : '';
  $('forget').hidden = !settings.token;
  $('cancel-settings').hidden = !settings.token;
  els.dialog.showModal();
  // First setup goes straight to the token field; later visits shouldn't pop the keyboard.
  (settings.token ? els.dialog.querySelector('h2') : f.token).focus();
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = els.form.elements;
  const next = {
    ...settings,
    token: f.token.value.trim(),
    repo: f.repo.value
      .trim()
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/(\.git|\/)$/, ''),
    path: f.path.value.trim() || 'Todos.md',
    branch: f.branch.value.trim() || 'main',
    lang: f.lang.value,
  };
  if (!next.token || !/^[\w.-]+\/[\w.-]+$/.test(next.repo)) {
    els.settingsError.textContent = 'Add a token and a repository like owner/name.';
    return;
  }
  const reconnect = ['token', 'repo', 'path', 'branch'].some((k) => next[k] !== settings[k]) || !store;
  if (reconnect) {
    const btn = $('save-settings');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await makeClient(next).get();
    } catch (err) {
      els.settingsError.textContent = err.message;
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }
  settings = next;
  saveSettings();
  els.dialog.close();
  if (reconnect) connect();
  else render();
});

$('cancel-settings').addEventListener('click', () => els.dialog.close());
$('forget').addEventListener('click', () => {
  if (store?.pending.length && !confirm('Some changes have not reached GitHub yet. Forget the token anyway?')) return;
  settings.token = '';
  saveSettings();
  els.dialog.close();
  connect();
});

// ---------- sync lifecycle ----------

function connect() {
  if (!settings.token || !settings.repo) {
    store = null;
    render();
    return Promise.resolve();
  }
  const key = `todo:cache:${settings.repo}:${settings.branch}:${settings.path}`;
  store = new Store({
    client: makeClient(settings),
    saved: storage.get(key, {}),
    save: (state) => storage.set(key, state),
    onChange() {
      if (store.skipped > seenSkipped) {
        seenSkipped = store.skipped;
        toast('A change was skipped: that todo was edited on another device.');
      }
      render();
    },
  });
  seenSkipped = 0;
  render();
  return store.refresh();
}

setInterval(() => {
  if (document.visibilityState === 'visible') store?.refresh();
}, 30_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') store?.refresh();
  else store?.flush();
});
addEventListener('online', () => store?.refresh());

// One-time setup link: …/#repo=owner/name&path=Todo.md (the fragment never reaches a server).
function readSetupLink() {
  if (!location.hash.includes('=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of ['repo', 'branch', 'path', 'token']) if (p.get(k)) settings[k] = p.get(k);
  saveSettings();
  history.replaceState(null, '', location.pathname + location.search);
}

// Shortcut / Siri entry point: …/?add=Buy%20milk&section=Personal
function quickAdd() {
  const p = new URLSearchParams(location.search);
  const text = p.get('add')?.trim();
  if (!text) return;
  history.replaceState(null, '', location.pathname);
  if (!store) return toast('Connect GitHub first, then try again');
  const want = p.get('section')?.toLowerCase();
  const section = want && doc.sections.find((s) => s.title.toLowerCase() === want || s.key.toLowerCase() === want);
  const key = section?.key ?? defaultSection();
  store.apply({ type: 'add', section: key, text, position: 'top' });
  toast(`Added to ${doc.sections.find((s) => s.key === key)?.title || 'your list'}`);
}

// Keep toasts above the iOS keyboard.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

readSetupLink();
connect().then(quickAdd);

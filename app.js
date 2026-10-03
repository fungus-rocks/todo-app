import { parse, refOf, locate, renderInline } from './todo-md.js';
import { makeClient } from './github.js';
import { Store } from './store.js';

const $ = (id) => document.getElementById(id);
const els = {
  list: $('list'),
  summary: $('summary'),
  status: $('status'),
  toggleDone: $('toggle-done'),
  composer: $('composer'),
  section: $('section'),
  input: $('new'),
  mic: $('mic'),
  send: $('send'),
  target: $('target'),
  toast: $('toast'),
  dialog: $('settings'),
  form: $('settings-form'),
  settingsError: $('settings-error'),
};

const SETTINGS_KEY = 'todo:settings';
const LINGER_MS = 1600; // a task you just checked stays visible this long before hiding
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
  path: 'Todo-Main.md',
  lang: '',
  showDone: false,
  section: null,
  ...storage.get(SETTINGS_KEY, {}),
};
const saveSettings = () => storage.set(SETTINGS_KEY, settings);

let store = null;
let doc = parse('');
let editing = null; // ref of the task being edited in place
let cancelEdit = false;
let target = null; // { ref, label } when adding subtasks
let deferred = false;
let seenSkipped = 0;
let pickerKeys = '';
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
  renderComposer();
  if (!store) return renderWelcome();
  if (!store.loaded) {
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
           <div class="actions"><button type="button" data-act="subtask">+ Subtask</button><button type="button" data-act="delete" class="danger">Delete</button></div></div>`
      : `<div class="text">${renderInline(t.text) || '&nbsp;'}</div>`;
    return `<li class="${t.done ? 'done' : ''}${isEditing ? ' editing' : ''}">
      <div class="row" data-i="${i}">${check}${body}</div>
      ${kids.length ? `<ul class="children">${kids.map(taskHtml).join('')}</ul>` : ''}</li>`;
  };

  const sections = shownSections();
  if (!sections.length) {
    els.list.innerHTML = `<div class="welcome"><h2>No todos yet</h2><p>Add one below. It lands at the end of <b>${esc(settings.path)}</b>.</p></div>`;
    return;
  }
  els.list.innerHTML = sections
    .map((s) => {
      const si = doc.sections.indexOf(s);
      const open = s.tasks.filter((t) => !t.done).length;
      const hidden = s.tasks.filter((t) => !visible(t)).length;
      const items = s.tasks.filter((t) => !t.parent && visible(t)).map(taskHtml).join('');
      const title = s.title || 'Inbox';
      return `<section class="section">
        <div class="section-head"><h2>${esc(title)}</h2><span class="count">${open || ''}</span>
          <button class="add-here" data-section="${si}" aria-label="Add to ${esc(title)}">+</button></div>
        <div class="card">
          ${items ? `<ul>${items}</ul>` : `<div class="empty" data-section="${si}">${s.tasks.length ? 'All done ✓' : 'Nothing here yet'}</div>`}
          ${hidden ? `<button class="more" data-show-done>${hidden} completed</button>` : ''}
        </div></section>`;
    })
    .join('');
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

function renderComposer() {
  const opts = store?.loaded ? shownSections() : [];
  const keys = opts.map((s) => s.key).join('\n');
  if (keys !== pickerKeys) {
    pickerKeys = keys;
    els.section.innerHTML = opts.map((s) => `<option value="${esc(s.key)}">${esc(s.title || 'Inbox')}</option>`).join('');
  }
  els.section.value = defaultSection();
  els.section.disabled = !opts.length || Boolean(target);
  els.target.hidden = !target;
  if (target) els.target.querySelector('b').textContent = target.label;
  els.input.placeholder = target ? 'Add a subtask' : 'Add a todo';
  const badge = els.mic.querySelector('.lang');
  badge.hidden = !Recognition;
  badge.textContent = voiceLang().startsWith('zh') ? '中' : 'EN';
  updateSend();
}

function updateSend() {
  els.send.disabled = !store || !els.input.value.trim();
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
  if (!store?.loaded || shown.some((s) => s.key === settings.section)) return settings.section ?? '';
  return shown.find((s) => s.level >= 2)?.key ?? shown[0]?.key ?? '';
}

const lingerKey = (t) => `${t.section.key}\n${t.text}`;

// ---------- actions ----------

function toggle(task) {
  const done = !task.done;
  if (done && !settings.showDone) {
    justDone.set(lingerKey(task), Date.now());
    setTimeout(render, LINGER_MS + 50);
  }
  store.apply({ type: 'toggle', ref: refOf(task), done });
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

function setTarget(task) {
  target = task ? { ref: refOf(task), label: task.text } : null;
  renderComposer();
  if (task) els.input.focus();
}

function add(text) {
  if (!text || !store) return;
  store.apply(target ? { type: 'add', parent: target.ref, text } : { type: 'add', section: els.section.value, text });
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

  const here = el.closest('[data-section]');
  if (here) {
    const section = doc.sections[+here.dataset.section];
    setTarget(null);
    settings.section = section.key;
    saveSettings();
    renderComposer();
    return els.input.focus();
  }

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
    if (current) setTarget(current);
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

// ---------- composer ----------

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  add(els.input.value.trim());
  els.input.value = '';
  updateSend();
});

// Enter that confirms a Chinese IME candidate must not also submit the todo.
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) e.preventDefault();
});
els.input.addEventListener('input', updateSend);

els.section.addEventListener('change', () => {
  settings.section = els.section.value;
  saveSettings();
});

$('clear-target').addEventListener('click', () => setTarget(null));

// ---------- voice ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let voiceBlocked = false;
let holdTimer = null;
let held = false;

function voiceLang() {
  return settings.lang || (navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
}

function listen() {
  if (rec) return rec.stop();
  if (!Recognition || voiceBlocked) {
    els.input.focus();
    return toast('Tap the mic on your keyboard to dictate');
  }
  const before = els.input.value.trim();
  const joiner = voiceLang().startsWith('zh') ? '' : ' ';
  rec = new Recognition();
  rec.lang = voiceLang();
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join('').trim();
    els.input.value = [before, said].filter(Boolean).join(joiner);
    updateSend();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      // Some iOS home-screen apps refuse speech recognition; the keyboard mic always works.
      voiceBlocked = true;
      els.input.focus();
      toast('Voice is blocked here. Use the mic on your keyboard.');
    } else if (e.error === 'no-speech') {
      toast("Didn't catch that");
    } else if (e.error !== 'aborted') {
      toast(`Voice error: ${e.error}`);
    }
  };
  rec.onend = () => {
    rec = null;
    els.mic.classList.remove('live');
  };
  try {
    rec.start();
    els.mic.classList.add('live');
  } catch {
    rec = null;
  }
}

function switchLang() {
  settings.lang = voiceLang().startsWith('zh') ? 'en-US' : 'zh-CN';
  saveSettings();
  renderComposer();
  toast(settings.lang === 'zh-CN' ? 'Voice: 中文' : 'Voice: English');
}

els.mic.addEventListener('pointerdown', () => {
  held = false;
  if (Recognition) holdTimer = setTimeout(() => ((held = true), switchLang()), 550);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) els.mic.addEventListener(ev, () => clearTimeout(holdTimer));
els.mic.addEventListener('contextmenu', (e) => e.preventDefault());
els.mic.addEventListener('click', () => {
  if (held) held = false;
  else listen();
});

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
    path: f.path.value.trim() || 'Todo-Main.md',
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
  if (!store) {
    els.input.value = text;
    updateSend();
    return toast('Connect GitHub first, then tap send');
  }
  const want = p.get('section')?.toLowerCase();
  const section = want && doc.sections.find((s) => s.title.toLowerCase() === want);
  store.apply({ type: 'add', section: section?.key ?? defaultSection(), text });
  toast(`Added to ${section?.title ?? (els.section.selectedOptions[0]?.text || 'your list')}`);
}

// Keep the composer above the iOS keyboard.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    document.documentElement.classList.toggle('kb', kb > 80);
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

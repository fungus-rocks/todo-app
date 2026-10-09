// The Hermes todo table: one Markdown table, one row per todo.
//
//   | section | priority | task | status | finished_at | finish_before |
//   | --- | --- | --- | --- | --- | --- |
//   | z | high | send ig recap | new |  |  |
//
// Columns are found by header name. A change rewrites only its own row (or
// inserts / removes one), formatted the way Hermes's write_todo_list.py writes
// rows, so Hermes's scripts and Obsidian both keep reading the file as before.

// Mirrors SECTION_ORDER / PRIORITY_ORDER / STATUS_ORDER in write_todo_list.py.
const SECTIONS = ['170', 'suki', 'z'];
const PRIORITIES = ['high', 'medium', 'low'];
const STATUSES = ['new', 'in_progress', 'finished'];
const DEFAULT_SECTION = 'z';

const HEADER_RE = /^\s*\|(.*\|)?\s*section\s*\|(.*\|)?\s*task\s*\|/i;
const SEP_RE = /^\s*\|?\s*:?-{3,}/;

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const formatRow = (values) => `| ${values.join(' | ')} |`;
// Hermes splits rows on every '|' and stores fields in lowercase.
const cleanCell = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim().toLowerCase();
const rank = (list, v) => (list.includes(v) ? list.indexOf(v) : 99);
const title = (s) => (/^\d/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1));

export function detect(text) {
  return text.split(/\r?\n/).some((l) => HEADER_RE.test(l));
}

export function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const header = lines.findIndex((l) => HEADER_RE.test(l));
  const cols = header < 0 ? [] : cells(lines[header]).map((c) => c.toLowerCase());
  const col = Object.fromEntries(cols.map((c, i) => [c, i]));

  const rows = [];
  let afterHeader = header;
  if (header >= 0) {
    let i = header + 1;
    if (SEP_RE.test(lines[i] ?? '')) afterHeader = i++;
    for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const v = cells(lines[i]);
      if (v.length < cols.length || !v[col.task]) continue;
      rows.push({ line: i, raw: lines[i], values: v });
    }
  }

  const sectionOf = new Map();
  const ensure = (key) => {
    if (!sectionOf.has(key)) sectionOf.set(key, { key, title: title(key), level: 2, line: -1, tasks: [] });
    return sectionOf.get(key);
  };
  for (const s of SECTIONS) ensure(s);

  const tasks = rows.map(({ line, raw, values }) => {
    const get = (name) => (values[col[name]] ?? '').toLowerCase();
    const section = ensure(get('section') || DEFAULT_SECTION);
    const status = get('status') || 'new';
    const priority = get('priority');
    const due = get('finish_before');
    const task = {
      kind: 'row',
      line,
      raw,
      values,
      text: values[col.task],
      status,
      done: status === 'finished',
      badges: [
        ...(status === 'in_progress' ? ['in progress'] : []),
        ...(priority && priority !== 'high' ? [priority] : []),
        ...(due ? [`due ${due}`] : []),
      ],
      priority,
      depth: 0,
      parent: null,
      children: [],
      section,
    };
    section.tasks.push(task);
    return task;
  });

  const sections = [...sectionOf.values()].sort((a, b) => rank(SECTIONS, a.key) - rank(SECTIONS, b.key));
  return { kind: 'table', eol, lines, header, afterHeader, col, cols, sections, tasks, defaultSection: DEFAULT_SECTION };
}

// Rows are addressed by section and task text, never by line number: Hermes
// re-sorts the whole table on every write.
export function refOf(task) {
  const same = task.section.tasks.filter((t) => t.text === task.text);
  return { section: task.section.key, text: task.text, raw: task.raw, nth: same.indexOf(task) };
}

export function locate(doc, ref) {
  const section = doc.sections.find((s) => s.key === ref.section);
  const found = section ? section.tasks.filter((t) => t.text === ref.text) : [];
  return found[Math.min(ref.nth, found.length - 1)] ?? null;
}

export function applyOp(text, op) {
  const doc = parse(text);
  if (doc.header < 0) return { text, ok: false };
  const lines = doc.lines.slice();
  const task = op.ref ? locate(doc, op.ref) : null;
  if (op.ref && !task) return { text, ok: false };
  const { col } = doc;

  const rewrite = (changes) => {
    const v = task.values.slice();
    for (const [name, value] of Object.entries(changes)) if (name in col) v[col[name]] = value;
    lines[task.line] = formatRow(v);
  };

  switch (op.type) {
    case 'toggle':
      if (op.done) rewrite({ status: 'finished', finished_at: stamp(op.at) });
      else rewrite({ status: 'new', finished_at: '' });
      break;
    case 'edit': {
      const body = cleanCell(op.text);
      if (!body) return { text, ok: false };
      rewrite({ task: body });
      break;
    }
    case 'delete':
      lines.splice(task.line, 1);
      break;
    case 'add': {
      const body = cleanCell(op.text);
      if (!body) return { text, ok: false };
      const section = cleanCell(op.section) || DEFAULT_SECTION;
      const row = doc.cols.map((c) => ({ section, priority: 'high', task: body, status: 'new' })[c] ?? '');
      // Same order Hermes keeps: section, then priority, then status.
      const key = (s, p, st) => [rank(SECTIONS, s), rank(PRIORITIES, p), rank(STATUSES, st)];
      const mine = key(section, 'high', 'new');
      const cmp = (t) => {
        const k = key(t.section.key, t.priority, t.status);
        for (let i = 0; i < 3; i++) if (k[i] !== mine[i]) return k[i] - mine[i];
        return 0;
      };
      // 'top' goes first among its equals (Hermes's sort is stable, so it stays there).
      const prev = doc.tasks.filter((t) => (op.position === 'top' ? cmp(t) < 0 : cmp(t) <= 0)).at(-1);
      lines.splice(prev ? prev.line + 1 : doc.afterHeader + 1, 0, formatRow(row));
      break;
    }
    default:
      return { text, ok: false };
  }
  return { text: lines.join(doc.eol), ok: true };
}

export function applyOps(text, ops) {
  const skipped = [];
  for (const op of ops) {
    const r = applyOp(text, op);
    if (r.ok) text = r.text;
    else skipped.push(op);
  }
  return { text, skipped };
}

// Local time as "YYYY-MM-DD HH:MM", the format write_todo_list.py records.
function stamp(at) {
  const d = at ? new Date(at) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

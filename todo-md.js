// A line-level model of an Obsidian todo note.
//
// Every change rewrites only the line it touches (or inserts / removes whole
// lines). Headings, prose, frontmatter and indentation pass through untouched,
// so the note stays pleasant to edit by hand in Obsidian.

const TASK_RE = /^([ \t]*)([-*+]|\d+[.)]) \[(.)\](?:[ \t]+(.*))?$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const DONE = new Set(['x', 'X', '-']); // '-' is Obsidian's "cancelled"

const indentWidth = (ws) => [...ws].reduce((w, c) => w + (c === '\t' ? 4 : 1), 0);
const leading = (line) => /^[ \t]*/.exec(line)[0];
const clean = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();

export function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);

  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) start = end + 1;
  }

  // Tasks above the first heading live in an untitled preamble section.
  const preamble = { key: '', title: '', level: 0, line: start - 1, tasks: [] };
  const sections = [preamble];
  const tasks = [];
  let section = preamble;
  let stack = [];
  let fence = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence) fence = null;
      continue;
    }
    if (f) {
      fence = f[1][0];
      stack = [];
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      section = { key: line.trim(), title: plainText(h[2]), level: h[1].length, line: i, tasks: [] };
      sections.push(section);
      stack = [];
      continue;
    }

    const m = TASK_RE.exec(line);
    if (m) {
      const width = indentWidth(m[1]);
      while (stack.length && stack[stack.length - 1].width >= width) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : null;
      const task = {
        line: i,
        raw: line,
        indent: m[1],
        width,
        marker: m[2],
        status: m[3],
        done: DONE.has(m[3]),
        text: m[4] ?? '',
        depth: stack.length,
        parent,
        children: [],
        section,
      };
      parent?.children.push(task);
      section.tasks.push(task);
      tasks.push(task);
      stack.push(task);
      continue;
    }

    // Unindented prose ends any list nesting.
    if (line.trim() && !/^[ \t]/.test(line)) stack = [];
  }

  return { eol, lines, sections, tasks };
}

// A task is addressed by its section and exact line, never by line number:
// line numbers shift whenever another device edits the note.
export function refOf(task) {
  const same = task.section.tasks.filter((t) => t.raw === task.raw);
  return { section: task.section.key, raw: task.raw, nth: same.indexOf(task) };
}

export function locate(doc, ref) {
  const section = doc.sections.find((s) => s.key === ref.section);
  let found = section ? section.tasks.filter((t) => t.raw === ref.raw) : [];
  if (!found.length) found = doc.tasks.filter((t) => t.raw === ref.raw); // section renamed elsewhere
  return found[Math.min(ref.nth, found.length - 1)] ?? null;
}

// Returns { text, ok }. ok is false when the op no longer applies, e.g. the
// task was edited or deleted on another device first.
export function applyOp(text, op) {
  const doc = parse(text);
  const lines = doc.lines.slice();
  const task = op.ref ? locate(doc, op.ref) : null;
  if (op.ref && !task) return { text, ok: false };

  switch (op.type) {
    case 'toggle': {
      const at = task.indent.length + task.marker.length + 2; // the char inside [ ]
      lines[task.line] = task.raw.slice(0, at) + (op.done ? 'x' : ' ') + task.raw.slice(at + 1);
      break;
    }
    case 'edit': {
      const body = clean(op.text);
      if (!body) return { text, ok: false };
      lines[task.line] = task.raw.slice(0, task.indent.length + task.marker.length + 4) + ' ' + body;
      break;
    }
    case 'delete':
      lines.splice(task.line, subtreeEnd(lines, task) - task.line + 1);
      break;
    case 'add': {
      const body = clean(op.text);
      if (!body) return { text, ok: false };
      insertTask(doc, lines, op, body);
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

function insertTask(doc, lines, op, body) {
  if (op.parent) {
    const parent = locate(doc, op.parent);
    if (parent) {
      lines.splice(subtreeEnd(lines, parent) + 1, 0, `${parent.indent}${indentUnit(doc)}- [ ] ${body}`);
      return;
    }
  }

  const section = doc.sections.find((s) => s.key === (op.section ?? ''));
  if (!section) {
    // The section vanished (renamed or deleted elsewhere): recreate it at the
    // end rather than lose the todo.
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, ...(end ? [''] : []), op.section, `- [ ] ${body}`);
    return;
  }

  const top = section.tasks.filter((t) => !t.parent);
  const last = top[top.length - 1];
  const at = last ? subtreeEnd(lines, last) + 1 : section.line + 1;
  lines.splice(at, 0, `${last ? last.indent : ''}- [ ] ${body}`);
}

// Last line belonging to a task: its subtasks and any deeper-indented notes.
function subtreeEnd(lines, task) {
  let end = task.line;
  for (let i = task.line + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (HEADING_RE.test(line) || indentWidth(leading(line)) <= task.width) break;
    end = i;
  }
  return end;
}

// Reuse whatever indentation the note already nests with (Obsidian defaults to tabs).
function indentUnit(doc) {
  const child = doc.tasks.find((t) => t.parent && t.indent.startsWith(t.parent.indent));
  return child ? child.indent.slice(child.parent.indent.length) : '\t';
}

export function taskText(raw) {
  return TASK_RE.exec(raw)?.[4] ?? raw.trim();
}

export function plainText(md) {
  return md
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, (_, t) => t.replace(/#\^?/, ' › '))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/\*(\S.*?)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Just enough Markdown to make task text readable; everything is escaped first.
export function renderInline(md) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  const link = (href, label) => keep(`<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`);

  const s = md
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`))
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) =>
      keep(`<span class="wikilink">${esc(a ?? t.replace(/#\^?/, ' › '))}</span>`),
    )
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => link(u, t))
    .replace(/https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g, (u) => link(u, u));

  return esc(s)
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu, '$1<span class="tag">#$2</span>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

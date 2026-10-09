import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, refOf, applyOp, applyOps, renderInline, plainText } from '../todo-md.js';

const NOTE = `# Planning Hub

Intro paragraph that must survive untouched.

## Personal


## [[Side Project]]
- [x] Shipped thing
- [ ] **Bold task**
- [ ] Parent task
\t- [x] First child
\t- [ ] Second child
- [ ] Last top-level

## Errands 杂事
- [ ] 买牛奶
`;

const find = (text, s) => parse(text).tasks.find((t) => t.text === s);

test('parses sections, nesting and status', () => {
  const doc = parse(NOTE);
  assert.deepEqual(
    doc.sections.map((s) => s.title),
    ['', 'Planning Hub', 'Personal', 'Side Project', 'Errands 杂事'],
  );
  const parent = find(NOTE, 'Parent task');
  assert.equal(parent.children.length, 2);
  assert.equal(parent.children[0].done, true);
  assert.equal(parent.children[1].depth, 1);
  assert.equal(find(NOTE, '买牛奶').section.title, 'Errands 杂事');
});

test('toggle rewrites only the status character', () => {
  const t = find(NOTE, '**Bold task**');
  const out = applyOp(NOTE, { type: 'toggle', ref: refOf(t), done: true }).text;
  assert.equal(out, NOTE.replace('- [ ] **Bold task**', '- [x] **Bold task**'));
  const back = applyOp(out, { type: 'toggle', ref: refOf(find(out, '**Bold task**')), done: false }).text;
  assert.equal(back, NOTE);
});

test('add goes after the last top-level task and its children', () => {
  const out = applyOp(NOTE, { type: 'add', section: '## [[Side Project]]', text: 'New one' }).text;
  assert.match(out, /- \[ \] Last top-level\n- \[ \] New one\n\n## Errands/);
});

test('add into an empty section lands right under the heading', () => {
  const out = applyOp(NOTE, { type: 'add', section: '## Personal', text: 'Call mom' }).text;
  assert.match(out, /## Personal\n- \[ \] Call mom\n\n\n## \[\[Side Project\]\]/);
});

test('subtask reuses the note’s tab indentation', () => {
  const parent = find(NOTE, 'Parent task');
  const out = applyOp(NOTE, { type: 'add', parent: refOf(parent), text: 'Third child' }).text;
  assert.match(out, /\t- \[ \] Second child\n\t- \[ \] Third child\n- \[ \] Last top-level/);
});

test('delete removes the task with its subtasks', () => {
  const out = applyOp(NOTE, { type: 'delete', ref: refOf(find(NOTE, 'Parent task')) }).text;
  assert.ok(!out.includes('child'));
  assert.match(out, /\*\*Bold task\*\*\n- \[ \] Last top-level/);
});

test('edit keeps indentation and status', () => {
  const t = find(NOTE, 'First child');
  const out = applyOp(NOTE, { type: 'edit', ref: refOf(t), text: 'Renamed\nchild' }).text;
  assert.match(out, /\t- \[x\] Renamed child\n/);
});

test('ops replay onto a note another device changed meanwhile', () => {
  const ops = [
    { type: 'toggle', ref: refOf(find(NOTE, 'Last top-level')), done: true },
    { type: 'add', section: '## Errands 杂事', text: '取快递' },
  ];
  // Elsewhere: two lines were added above, shifting every line number.
  const remote = NOTE.replace('## Personal\n', '## Personal\n- [ ] From the Mac\n- [ ] Another\n');
  const { text, skipped } = applyOps(remote, ops);
  assert.equal(skipped.length, 0);
  assert.match(text, /- \[x\] Last top-level/);
  assert.match(text, /From the Mac/);
  assert.match(text, /- \[ \] 买牛奶\n- \[ \] 取快递\n$/);
});

test('an op on a task edited elsewhere is skipped, not misapplied', () => {
  const op = { type: 'toggle', ref: refOf(find(NOTE, 'Last top-level')), done: true };
  const remote = NOTE.replace('Last top-level', 'Reworded elsewhere');
  const { text, skipped } = applyOps(remote, [op]);
  assert.equal(skipped.length, 1);
  assert.equal(text, remote);
});

test('duplicate lines are told apart by position', () => {
  const note = '## A\n- [ ] same\n- [ ] same\n';
  const second = parse(note).tasks[1];
  const out = applyOp(note, { type: 'toggle', ref: refOf(second), done: true }).text;
  assert.equal(out, '## A\n- [ ] same\n- [x] same\n');
});

test('adding to a vanished section recreates it at the end', () => {
  const out = applyOp('## A\n- [ ] a\n', { type: 'add', section: '## Inbox', text: 'x' }).text;
  assert.equal(out, '## A\n- [ ] a\n\n## Inbox\n- [ ] x\n');
});

test('frontmatter, code fences and CRLF are left alone', () => {
  const note = '---\ntags: [todo]\n---\n## A\n```\n- [ ] not a task\n```\n- [ ] real\n'.replace(/\n/g, '\r\n');
  const doc = parse(note);
  assert.equal(doc.tasks.length, 1);
  const out = applyOp(note, { type: 'toggle', ref: refOf(doc.tasks[0]), done: true }).text;
  assert.equal(out, note.replace('- [ ] real', '- [x] real'));
});

test('inline rendering escapes HTML and keeps links safe', () => {
  assert.equal(
    renderInline('**hi** <b>x</b> [[Note|alias]] [site](https://a.b/c) #tag'),
    '<strong>hi</strong> &lt;b&gt;x&lt;/b&gt; <span class="wikilink">alias</span> <a href="https://a.b/c" target="_blank" rel="noopener">site</a> <span class="tag">#tag</span>',
  );
  assert.ok(!renderInline('[x](javascript:alert(1))').includes('<a'));
  assert.equal(plainText('[[Hermes Agent]]'), 'Hermes Agent');
});

test('position top puts a new todo first in its section', () => {
  const out = applyOp(NOTE, { type: 'add', section: '## [[Side Project]]', text: 'First', position: 'top' }).text;
  assert.match(out, /## \[\[Side Project\]\]\n- \[ \] First\n- \[x\] Shipped thing/);
  const empty = applyOp(NOTE, { type: 'add', section: '## Personal', text: 'Solo', position: 'top' }).text;
  assert.match(empty, /## Personal\n- \[ \] Solo\n/);
});

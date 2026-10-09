import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, refOf, applyOp, applyOps, detect } from '../todo-table.js';
import * as formats from '../formats.js';

const NOTE = `| section | priority | task | status | finished_at | finish_before |
| --- | --- | --- | --- | --- | --- |
| 170 | high | clean up garage | new |  |  |
| suki | medium | umbrella insurance | in_progress |  | 2026-11-01 |
| z | high | send ig recap for april | new |  |  |
| z | high | 记账 | new |  |  |
| z | low | old thing | finished | 2026-09-01 10:00 |  |
`;
const find = (text, s) => parse(text).tasks.find((t) => t.text === s);

test('detects and parses the Hermes table', () => {
  assert.ok(detect(NOTE));
  assert.ok(!detect('## A\n- [ ] x\n'));
  const doc = parse(NOTE);
  assert.deepEqual(doc.sections.map((s) => s.title), ['170', 'Suki', 'Z']);
  assert.equal(doc.tasks.length, 5);
  const u = find(NOTE, 'umbrella insurance');
  assert.deepEqual(u.badges, ['in progress', 'medium', 'due 2026-11-01']);
  assert.equal(find(NOTE, 'old thing').done, true);
});

test('checking off sets status and finished_at like write_todo_list.py', () => {
  const t = find(NOTE, 'clean up garage');
  const at = new Date(2026, 9, 9, 14, 5).getTime();
  const out = applyOp(NOTE, { type: 'toggle', ref: refOf(t), done: true, at }).text;
  assert.equal(out, NOTE.replace('| 170 | high | clean up garage | new |  |  |', '| 170 | high | clean up garage | finished | 2026-10-09 14:05 |  |'));
  const back = applyOp(out, { type: 'toggle', ref: refOf(find(out, 'clean up garage')), done: false }).text;
  assert.equal(back, NOTE);
});

test('add lands in Hermes sort order, lowercased, pipes made safe', () => {
  const out = applyOp(NOTE, { type: 'add', section: 'z', text: 'Call Mom | dad' }).text;
  assert.match(out, /\| z \| high \| 记账 \| new \|  \|  \|\n\| z \| high \| call mom \/ dad \| new \|  \|  \|\n\| z \| low \| old thing/);
  const s = applyOp(NOTE, { type: 'add', section: 'suki', text: 'vet' }).text;
  assert.match(s, /clean up garage \| new \|  \|  \|\n\| suki \| high \| vet \| new \|  \|  \|\n\| suki \| medium/);
});

test('add to an empty table goes under the separator', () => {
  const empty = '| section | priority | task | status | finished_at | finish_before |\n| --- | --- | --- | --- | --- | --- |\n';
  assert.equal(applyOp(empty, { type: 'add', section: 'z', text: 'x' }).text, empty + '| z | high | x | new |  |  |\n');
  assert.deepEqual(parse(empty).sections.map((s) => s.key), ['170', 'suki', 'z']);
});

test('ops survive Hermes re-sorting and reformatting the table', () => {
  const ops = [{ type: 'toggle', ref: refOf(find(NOTE, '记账')), done: true }, { type: 'edit', ref: refOf(find(NOTE, 'clean up garage')), text: 'Clean garage' }];
  const resorted = NOTE.replace('| z | high | send ig recap for april | new |  |  |\n| z | high | 记账 | new |  |  |', '|z|high|记账|new|||\n| z | high | send ig recap for april | new |  |  |');
  const { text, skipped } = applyOps(resorted, ops);
  assert.equal(skipped.length, 0);
  assert.match(text, /\| z \| high \| 记账 \| finished \| \d{4}-\d\d-\d\d \d\d:\d\d \|  \|/);
  assert.match(text, /\| 170 \| high \| clean garage \| new \|/);
});

test('delete removes just that row; missing rows are skipped', () => {
  const out = applyOp(NOTE, { type: 'delete', ref: refOf(find(NOTE, '记账')) }).text;
  assert.ok(!out.includes('记账'));
  assert.equal(out.split('\n').length, NOTE.split('\n').length - 1);
  assert.equal(applyOp(out, { type: 'delete', ref: refOf(find(NOTE, '记账')) }).ok, false);
});

test('formats dispatcher picks the right model', () => {
  assert.equal(formats.parse(NOTE).kind, 'table');
  assert.equal(formats.parse('## A\n- [ ] x\n').kind, undefined);
});

test('real Hermes list parses fully and round-trips', () => {
  const real = readFileSync('/Users/zheqian/Z/Ideaverse/Todos.md', 'utf8');
  const doc = parse(real);
  assert.equal(doc.tasks.length, real.trim().split('\n').length - 2);
  let t = real;
  // Check off and un-check every open row (re-checking a finished row would stamp a new finished_at).
  for (let i = 0; i < doc.tasks.length; i++) {
    if (doc.tasks[i].done) continue;
    for (const _ of [0, 1]) { const task = parse(t).tasks[i]; t = applyOp(t, { type: 'toggle', ref: refOf(task), done: !task.done }).text; }
  }
  assert.equal(t, real);
});

test('position top puts a new todo first in its section', () => {
  const out = applyOp(NOTE, { type: 'add', section: 'z', text: 'first!', position: 'top' }).text;
  assert.match(out, /in_progress \|  \| 2026-11-01 \|\n\| z \| high \| first! \| new \|  \|  \|\n\| z \| high \| send ig recap/);
  const empty = applyOp(NOTE, { type: 'add', section: '170', text: 'x', position: 'top' }).text;
  assert.match(empty, /\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| 170 \| high \| x \| new/);
});

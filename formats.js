// Picks the note format from the file itself: a Hermes-style todo table, or
// Obsidian checkboxes under headings.

import * as checklist from './todo-md.js';
import * as table from './todo-table.js';

const formatOf = (text) => (table.detect(text) ? table : checklist);

export const parse = (text) => formatOf(text).parse(text);
export const applyOps = (text, ops) => formatOf(text).applyOps(text, ops);
export const refOf = (task) => (task.kind === 'row' ? table : checklist).refOf(task);
export const locate = (doc, ref) => (doc.kind === 'table' ? table : checklist).locate(doc, ref);
export const refText = (ref) => ref.text ?? checklist.taskText(ref.raw);

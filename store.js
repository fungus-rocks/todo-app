// Keeps the list in step with GitHub.
//
// The screen shows `base` (the last text seen on GitHub) with `pending` ops
// replayed on top. Saving fetches the newest file, replays the ops onto it
// and writes it back with that file's sha; if anything changed in between,
// GitHub refuses the write and we simply fetch and replay again. Ops survive
// reloads, so a change made offline is sent the next time the app opens.

import { applyOps, refText } from './formats.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Store {
  constructor({ client, saved = {}, save = () => {}, onChange = () => {}, debounceMs = 800 }) {
    this.client = client;
    this.save = save;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.base = saved.base ?? null;
    this.sha = saved.sha ?? null;
    this.pending = saved.pending ?? [];
    this.etag = null;
    this.status = this.base === null ? 'loading' : 'idle';
    this.error = null;
    this.skipped = 0;
    this.stale = []; // shas we have written past; GitHub can still serve them for a moment
    this.timer = null;
    this.flushing = null;
    this.again = false;
    this.recompute();
  }

  get loaded() {
    return this.base !== null;
  }

  recompute() {
    this.text = applyOps(this.base ?? '', this.pending).text;
  }

  emit() {
    this.save({ base: this.base, sha: this.sha, pending: this.pending });
    this.onChange(this);
  }

  apply(op) {
    this.pending.push(op);
    this.recompute();
    this.status = 'saving';
    this.emit();
    this.schedule();
  }

  schedule(ms = this.debounceMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }

  async refresh() {
    if (this.flushing) return; // a flush reads the newest file anyway
    try {
      const res = await this.client.get({ etag: this.etag });
      if (!res.notModified && !this.stale.includes(res.sha)) {
        this.base = res.text;
        this.sha = res.sha;
        this.etag = res.etag;
        this.recompute();
      }
      this.status = this.pending.length ? 'saving' : 'synced';
      this.error = null;
      if (this.pending.length) this.schedule(0);
    } catch (e) {
      this.fail(e);
    }
    this.emit();
  }

  flush() {
    clearTimeout(this.timer);
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    if (!this.pending.length) return Promise.resolve();
    this.flushing = this.#flush().finally(() => {
      this.flushing = null;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    });
    return this.flushing;
  }

  async #flush() {
    this.status = 'saving';
    this.emit();
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await sleep(600 * attempt);
        const batch = this.pending.slice();
        const remote = await this.client.get();
        if (this.stale.includes(remote.sha)) continue; // our own write hasn't propagated yet

        const { text, skipped } = applyOps(remote.text, batch);
        let sha = remote.sha;
        if (text !== remote.text) {
          try {
            sha = (await this.client.put(text, remote.sha, commitMessage(batch))).sha;
          } catch (e) {
            if (e.code === 'conflict') continue;
            throw e;
          }
          this.stale = [...this.stale.slice(-9), remote.sha];
        }

        this.base = text;
        this.sha = sha;
        this.etag = null;
        this.pending = this.pending.slice(batch.length); // keep ops added while we were saving
        this.skipped += skipped.length;
        this.recompute();
        this.status = this.pending.length ? 'saving' : 'synced';
        this.error = null;
        if (this.pending.length) this.again = true;
        this.emit();
        return;
      }
      throw Object.assign(new Error('Kept colliding with edits from another device.'), { code: 'conflict' });
    } catch (e) {
      this.fail(e);
      this.emit();
    }
  }

  fail(e) {
    this.status = { offline: 'offline', auth: 'auth' }[e.code] ?? 'error';
    this.error = e.message;
  }
}

export function commitMessage(ops) {
  const short = (s) => (s.length > 60 ? s.slice(0, 59) + '…' : s);
  const lines = ops.map((op) => {
    const text = short(op.type === 'add' ? op.text : refText(op.ref));
    if (op.type === 'toggle') return `${op.done ? '✓' : '○'} ${text}`;
    return `${{ add: '+', edit: '✎', delete: '−' }[op.type] ?? '·'} ${text}`;
  });
  return lines.length === 1 ? `todo: ${lines[0]}` : `todo: ${lines.length} changes\n\n${lines.join('\n')}`;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, commitMessage } from '../store.js';
import { parse, refOf } from '../todo-md.js';
import { makeClient, encode, decode } from '../github.js';

// In-memory stand-in for one file on GitHub, with knobs for the awkward cases.
function fakeRepo(text) {
  const repo = { text, version: 1, commits: [], staleReads: 0, offline: false };
  const sha = () => `sha${repo.version}`;
  repo.edit = (fn) => {
    repo.text = fn(repo.text);
    repo.version++;
  };
  repo.client = {
    async get({ etag } = {}) {
      if (repo.offline) throw Object.assign(new Error('offline'), { code: 'offline' });
      if (repo.staleReads > 0) {
        repo.staleReads--;
        return { text: repo.prev, sha: `sha${repo.version - 1}`, etag: null };
      }
      if (etag === sha()) return { notModified: true };
      return { text: repo.text, sha: sha(), etag: sha() };
    },
    async put(text, base, message) {
      if (repo.offline) throw Object.assign(new Error('offline'), { code: 'offline' });
      if (base !== sha()) throw Object.assign(new Error('conflict'), { code: 'conflict' });
      repo.prev = repo.text;
      repo.text = text;
      repo.version++;
      repo.commits.push(message);
      return { sha: sha() };
    },
  };
  return repo;
}

const NOTE = '## Home\n- [ ] Fix shelf\n- [ ] Buy curtain\n';
const task = (store, text) => parse(store.text).tasks.find((t) => t.text === text);

async function connected(repo, saved) {
  const store = new Store({ client: repo.client, saved, debounceMs: 5 });
  await store.refresh();
  return store;
}

test('a change is written to GitHub and the screen agrees', async () => {
  const repo = fakeRepo(NOTE);
  const store = await connected(repo);
  store.apply({ type: 'toggle', ref: refOf(task(store, 'Fix shelf')), done: true });
  assert.match(store.text, /- \[x\] Fix shelf/); // optimistic
  await store.flush();
  assert.equal(repo.text, '## Home\n- [x] Fix shelf\n- [ ] Buy curtain\n');
  assert.equal(store.status, 'synced');
  assert.deepEqual(repo.commits, ['todo: ✓ Fix shelf']);
});

test('rapid taps go out as one commit', async () => {
  const repo = fakeRepo(NOTE);
  const store = await connected(repo);
  store.apply({ type: 'toggle', ref: refOf(task(store, 'Fix shelf')), done: true });
  store.apply({ type: 'add', section: '## Home', text: 'Hang picture' });
  await store.flush();
  assert.equal(repo.commits.length, 1);
  assert.match(repo.commits[0], /^todo: 2 changes\n\n✓ Fix shelf\n\+ Hang picture$/);
});

test('an edit from the Mac in between is kept, not overwritten', async () => {
  const repo = fakeRepo(NOTE);
  const store = await connected(repo);
  store.apply({ type: 'toggle', ref: refOf(task(store, 'Buy curtain')), done: true });
  repo.edit((t) => t.replace('## Home\n', '## Home\n- [ ] Added on Mac\n'));
  await store.flush();
  assert.equal(repo.text, '## Home\n- [ ] Added on Mac\n- [ ] Fix shelf\n- [x] Buy curtain\n');
  assert.equal(store.text, repo.text);
});

test('a write that races another device retries on the newer file', async () => {
  const repo = fakeRepo(NOTE);
  const store = await connected(repo);
  const realPut = repo.client.put;
  let raced = false;
  repo.client.put = async (...args) => {
    if (!raced) {
      raced = true;
      repo.edit((t) => t + '- [ ] Sneaked in\n'); // lands between our read and our write
    }
    return realPut(...args);
  };
  store.apply({ type: 'add', section: '## Home', text: 'Mine' });
  await store.flush();
  assert.match(repo.text, /Sneaked in/);
  assert.match(repo.text, /Mine/);
  assert.equal(repo.commits.length, 1);
});

test('offline changes persist and go out once back online', async () => {
  const repo = fakeRepo(NOTE);
  let saved;
  const store = new Store({ client: repo.client, save: (s) => (saved = structuredClone(s)), debounceMs: 5 });
  await store.refresh();
  repo.offline = true;
  store.apply({ type: 'add', section: '## Home', text: 'Offline idea' });
  await store.flush();
  assert.equal(store.status, 'offline');
  assert.equal(saved.pending.length, 1);

  // App is closed and reopened later, now online.
  repo.offline = false;
  const reopened = new Store({ client: repo.client, saved, debounceMs: 5 });
  assert.match(reopened.text, /Offline idea/); // visible before the network answers
  await reopened.refresh();
  await reopened.flush();
  assert.match(repo.text, /- \[ \] Offline idea\n$/);
  assert.equal(reopened.pending.length, 0);
});

test('a stale read right after our own write does not roll the list back', async () => {
  const repo = fakeRepo(NOTE);
  const store = await connected(repo);
  store.apply({ type: 'add', section: '## Home', text: 'Fresh' });
  await store.flush();
  repo.staleReads = 1;
  await store.refresh();
  assert.match(store.text, /Fresh/);
});

test('ops on a task deleted elsewhere are dropped and counted', async () => {
  const repo = fakeRepo(NOTE);
  const store = await connected(repo);
  store.apply({ type: 'toggle', ref: refOf(task(store, 'Fix shelf')), done: true });
  repo.edit((t) => t.replace('- [ ] Fix shelf\n', ''));
  await store.flush();
  assert.equal(store.skipped, 1);
  assert.equal(store.pending.length, 0);
  assert.equal(repo.commits.length, 0);
});

test('commit messages stay short', () => {
  const long = 'x'.repeat(100);
  assert.equal(commitMessage([{ type: 'add', text: long }]).length, 'todo: + '.length + 60);
});

test('base64 round-trips UTF-8', () => {
  const s = '买牛奶 ✓ emoji 🎙️\n\ttab';
  assert.equal(decode(encode(s)), s);
});

test('github client maps HTTP failures to codes', async () => {
  const respond = (status, body = {}) => async () => new Response(JSON.stringify(body), { status });
  const mk = (fetch) => makeClient({ token: 't', repo: 'o/r', path: 'Todo-Main.md', fetch });
  await assert.rejects(mk(respond(401)).get(), { code: 'auth' });
  await assert.rejects(mk(respond(404)).get(), { code: 'auth' });
  await assert.rejects(mk(respond(409)).put('x', 's', 'm'), { code: 'conflict' });
  await assert.rejects(mk(respond(422, { message: 'sha does not match' })).put('x', 's', 'm'), { code: 'conflict' });
  await assert.rejects(mk(async () => { throw new TypeError('Failed to fetch'); }).get(), { code: 'offline' });

  let seen;
  const ok = mk(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ content: encode('hi'), sha: 'abc' }), { status: 200, headers: { ETag: 'W/"1"' } });
  });
  assert.deepEqual(await ok.get(), { text: 'hi', sha: 'abc', etag: 'W/"1"' });
  assert.equal(seen.url, 'https://api.github.com/repos/o/r/contents/Todo-Main.md?ref=main');
  assert.equal(seen.init.cache, 'no-store');
});

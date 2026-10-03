// Minimal client for one file through GitHub's contents API. The browser
// talks to GitHub directly; there is no server of our own in between.

const API = 'https://api.github.com';

export function makeClient({ token, repo, branch = 'main', path, fetch = globalThis.fetch.bind(globalThis) }) {
  const url = `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };

  async function call(method, target, { body, etag } = {}) {
    let res;
    try {
      res = await fetch(target, {
        method,
        // GitHub marks these responses cacheable for 60s; a cached read right
        // after a write would show the old list.
        cache: 'no-store',
        headers: {
          ...headers,
          ...(etag ? { 'If-None-Match': etag } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body && JSON.stringify(body),
      });
    } catch {
      throw failure('offline', 'Offline. Changes are kept on this device.');
    }
    if (res.status === 304) return { notModified: true };
    const json = await res.json().catch(() => ({}));
    if (res.ok) return { json, etag: res.headers.get('ETag') };

    const msg = json.message ?? res.statusText;
    if (res.status === 401) throw failure('auth', 'GitHub rejected the token.');
    if (res.status === 403 && /rate limit/i.test(msg)) throw failure('rate', 'GitHub rate limit reached. Try again shortly.');
    if (res.status === 403 || res.status === 404) throw failure('auth', `The token can't reach ${repo}/${path}.`);
    if (res.status === 409 || (res.status === 422 && /sha/i.test(msg))) throw failure('conflict', 'Changed elsewhere.');
    throw failure('http', `GitHub ${res.status}: ${msg}`);
  }

  return {
    async get({ etag } = {}) {
      const r = await call('GET', `${url}?ref=${encodeURIComponent(branch)}`, { etag });
      if (r.notModified) return r;
      return { text: decode(r.json.content), sha: r.json.sha, etag: r.etag };
    },
    async put(text, sha, message) {
      const r = await call('PUT', url, { body: { message, content: encode(text), sha, branch } });
      return { sha: r.json.content.sha };
    },
  };
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// btoa/atob only speak Latin-1; go through UTF-8 bytes so Chinese text survives.
export function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

import { put, list, del } from '@vercel/blob';
import { applyOp, compact, seed, view, UserError, ROLES } from '../public/logic.js';
import { signToken, readToken } from './_auth.js';

// One shared demo workspace stored as a versioned JSON blob. Every save writes a NEW pathname so a read can never
// hit a cached older copy; the newest version wins and older ones are deleted after a save.
// Limit (see README): two saves at the exact same moment can overwrite each other. Fine for a demo, not for a real shop.
const PREFIX = 'makhzan/state-';
const RESET_MS = 6 * 60 * 60 * 1000;

async function versions() {
  const { blobs } = await list({ prefix: PREFIX });
  return blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
}
async function load() {
  try {
    const [newest] = await versions();
    if (!newest) throw new Error('empty');
    const s = await (await fetch(newest.url, { cache: 'no-store' })).json();
    if (Date.now() - s.resetAt > RESET_MS) throw new Error('expired');
    return s;
  } catch {
    const s = seed(); await save(s); return s;
  }
}
async function save(s) {
  const old = await versions().catch(() => []);
  await put(PREFIX + String(Date.now()).padStart(15, '0') + '.json', JSON.stringify(s), { access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 });
  if (old.length) await del(old.map((b) => b.url)).catch(() => {});
}

export const store = { load, save };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const state = await store.load();
    const now = Date.now();
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      if (JSON.stringify(body).length > 40000) return res.status(413).json({ error: 'Too large' });
      const op = body.op || {};
      if (op.type === 'login') {
        const u = state.users.find((x) => x.pin === String(op.pin || ''));
        if (!u) return res.status(401).json({ error: 'Wrong PIN' });
        return res.status(200).json({ token: signToken(u.id, now), me: { id: u.id, name: u.name, role: u.role } });
      }
      const user = readToken(auth, state.users, now);
      if (!user) return res.status(401).json({ error: 'Sign in again' });
      if (op.type === 'reset') {
        if (user.role !== ROLES.owner) return res.status(403).json({ error: 'Owner only' });
        const fresh = seed(now); await store.save(fresh);
        return res.status(200).json({ ...view(fresh, user, now), result: {} });
      }
      const result = applyOp(state, op, { user, now });
      compact(state);
      await store.save(state);
      return res.status(200).json({ ...view(state, user, now), result });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const user = readToken(auth, state.users, now);
    if (!user) return res.status(401).json({ error: 'Sign in again' });
    return res.status(200).json(view(state, user, now));
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    return res.status(500).json({ error: 'Server error' });
  }
}

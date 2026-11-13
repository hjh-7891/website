/**
 * 违规记录管理系统 · Cloudflare Pages Functions 版
 *
 * 存储：KV 中一个 key（默认 "db"）里存整个 JSON 数据库
 * 登录：无状态签名 token（HMAC-SHA256），密码摘要用 WebCrypto 计算
 * 静态页：由 Pages 直接托管（public/ 目录）
 *
 * 需要的绑定（wrangler.toml / Pages 项目设置里配置）：
 *   DB   KV namespace（变量名必须是 DB）
 * 需要密钥（wrangler pages secret put TOKEN_SECRET）：任意长随机字符串
 */

const DB_KEY = 'db';
const DB_VERSION = 1;
const SESSION_HOURS = 12;
const REMEMBER_HOURS = 24 * 30;
const TOKEN_PREFIX = 'v1';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function ok(data, status = 200) {
  return json({ ok: true, data }, status);
}

function fail(error, status = 400) {
  return json({ ok: false, error }, status);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + '_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nowIso() {
  return new Date().toISOString();
}

function str(value, max) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return max ? s.slice(0, max) : s;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(salt, password) {
  return sha256(salt + ':' + password);
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* 数据库（KV 里一个 JSON）                                            */
/* ------------------------------------------------------------------ */

async function seedDb(env) {
  const salt = randomSalt();
  const passwordHash = await hashPassword(salt, 'admin123');
  return {
    version: DB_VERSION,
    users: [
      {
        id: newId('u'),
        username: 'admin',
        salt,
        passwordHash,
        pv: 1,
        role: 'admin',
        status: 'active',
        createdAt: nowIso()
      }
    ],
    records: []
  };
}

async function readDb(env) {
  const raw = await env.DB.get(DB_KEY);
  if (raw) {
    try {
      const db = JSON.parse(raw);
      if (db && Array.isArray(db.users) && Array.isArray(db.records)) return db;
    } catch (e) {
      /* 数据损坏时落到下面重新播种，原内容另存一份便于排查 */
      await env.DB.put(DB_KEY + '_broken_' + Date.now(), raw);
    }
  }
  const seeded = await seedDb(env);
  await env.DB.put(DB_KEY, JSON.stringify(seeded));
  return seeded;
}

async function writeDb(env, db) {
  await env.DB.put(DB_KEY, JSON.stringify(db));
}

/* ------------------------------------------------------------------ */
/* Token（无状态签名）                                                 */
/* ------------------------------------------------------------------ */

function b64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncodeText(text) {
  return b64url(new TextEncoder().encode(text));
}

function b64urlDecodeText(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signToken(user, secret, ttlHours) {
  const payload = {
    uid: user.id,
    pv: user.pv || 1,
    exp: Date.now() + (ttlHours || SESSION_HOURS) * 3600 * 1000
  };
  const body = TOKEN_PREFIX + '.' + b64urlEncodeText(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + b64url(new Uint8Array(sigBuf));
}

async function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [prefix, payloadPart, sigPart] = parts;
  if (prefix !== TOKEN_PREFIX) return null;

  const body = prefix + '.' + payloadPart;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    atob(sigPart.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (sigPart.length % 4)) % 4))
      .split('')
      .map((c) => c.charCodeAt(0))
  );
  const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(body));
  if (!valid) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeText(payloadPart));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

/* ------------------------------------------------------------------ */
/* 鉴权                                                                */
/* ------------------------------------------------------------------ */

function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt
  };
}

async function currentUser(request, env, db) {
  if (!env.TOKEN_SECRET) throw new Error('未配置 TOKEN_SECRET，请在 Cloudflare 里执行 wrangler secret put TOKEN_SECRET');
  const token = bearer(request);
  if (!token) return null;
  const payload = await verifyToken(token, env.TOKEN_SECRET);
  if (!payload) return null;
  const user = db.users.find((u) => u.id === payload.uid);
  if (!user || user.status !== 'active') return null;
  if ((user.pv || 1) !== payload.pv) return null; // 改过密码 → 旧 token 作废
  return user;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function validateRecord(input) {
  const record = {
    violator: str(input.violator, 50),
    steamId: str(input.steamId, 50),
    violationType: str(input.violationType, 100),
    handler: str(input.handler, 50),
    handleTime: str(input.handleTime, 30),
    handleResult: str(input.handleResult, 2000),
    resultType: str(input.resultType, 20),
    resultDuration: str(input.resultDuration, 10),
    resultUnit: str(input.resultUnit, 12),
    resultNote: str(input.resultNote, 200),
    remark: str(input.remark, 2000)
  };

  if (!record.violator) return { error: '违规人不能为空' };
  if (!record.steamId) return { error: 'Steam64ID 不能为空' };
  if (!record.violationType) return { error: '违规类型不能为空' };
  if (!record.handler) return { error: '处理人不能为空' };
  if (!record.handleTime) return { error: '处理时间不能为空' };
  if (!record.handleResult) return { error: '处理结果不能为空' };
  return { record };
}

function validateUsername(username) {
  if (!username) return '用户名不能为空';
  if (username.length < 2 || username.length > 20) return '用户名需为 2–20 个字符';
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(username)) return '用户名只能包含中英文、数字、下划线、点或短横线';
  return '';
}

function validatePassword(password) {
  if (!password) return '密码不能为空';
  if (String(password).length < 6) return '密码至少 6 位';
  if (String(password).length > 64) return '密码过长';
  return '';
}

/* ------------------------------------------------------------------ */
/* API 路由                                                            */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/api';

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      body = (await request.json()) || {};
    } catch (e) {
      return fail('请求体不是合法 JSON');
    }
  }

  const db = await readDb(env);

  /* ---- 登录（不需要 token） ---- */
  if (path === '/api/login' && method === 'POST') {
    if (!env.TOKEN_SECRET) {
      return fail('未配置 TOKEN_SECRET：请在 Pages 项目的「变量和密钥」里添加，值为任意 32 位以上随机字符串，添加后必须重新部署', 500);
    }

    const username = str(body.username, 20);
    const password = String(body.password || '');
    if (!username || !password) return fail('请输入用户名和密码', 400);

    const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return fail('用户名或密码错误', 401);
    if (user.status !== 'active') return fail('该账号已被停用，请联系管理员', 403);

    const hash = await hashPassword(user.salt, password);
    if (hash !== user.passwordHash) return fail('用户名或密码错误', 401);

    const remember = Boolean(body.remember);
    const token = await signToken(user, env.TOKEN_SECRET, remember ? REMEMBER_HOURS : SESSION_HOURS);
    return ok({ token, user: publicUser(user), remember });
  }

  if (path === '/api/logout' && method === 'POST') {
    // 无状态 token，由客户端丢弃即可
    return ok({ loggedOut: true });
  }

  /* ---- 以下全部需要登录 ---- */
  const me = await currentUser(request, env, db);
  if (!me) return fail('未登录或登录已失效', 401);

  if (path === '/api/me' && method === 'GET') {
    return ok(publicUser(me));
  }

  if (path === '/api/me/password' && method === 'POST') {
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');

    const err = validatePassword(newPassword);
    if (err) return fail(err);

    if ((await hashPassword(me.salt, oldPassword)) !== me.passwordHash) {
      return fail('原密码不正确', 401);
    }

    me.salt = randomSalt();
    me.passwordHash = await hashPassword(me.salt, newPassword);
    me.pv = (me.pv || 1) + 1;
    await writeDb(env, db);
    return ok({ changed: true });
  }

  /* ---- 违规记录 ---- */
  if (path === '/api/records' && method === 'GET') {
    const records = db.records.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return ok(records);
  }

  if (path === '/api/records' && method === 'POST') {
    const result = validateRecord(body);
    if (result.error) return fail(result.error);

    const record = Object.assign(result.record, {
      id: newId('r'),
      createdBy: me.username,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    db.records.unshift(record);
    await writeDb(env, db);
    return ok(record, 201);
  }

  const recordMatch = path.match(/^\/api\/records\/([\w-]+)$/);
  if (recordMatch) {
    const id = recordMatch[1];
    const index = db.records.findIndex((r) => r.id === id);
    if (index === -1) return fail('记录不存在', 404);

    if (method === 'PUT') {
      if (me.role !== 'admin') return fail('只有管理员可以编辑记录', 403);
      const result = validateRecord(body);
      if (result.error) return fail(result.error);
      db.records[index] = Object.assign({}, db.records[index], result.record, { updatedAt: nowIso() });
      await writeDb(env, db);
      return ok(db.records[index]);
    }

    if (method === 'DELETE') {
      if (me.role !== 'admin') return fail('只有管理员可以删除记录', 403);
      db.records.splice(index, 1);
      await writeDb(env, db);
      return ok({ deleted: id });
    }
  }

  /* ---- 账号 ---- */
  if (path === '/api/users' && method === 'GET') {
    const users = db.users
      .slice()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(publicUser);
    return ok(users);
  }

  if (path === '/api/users' && method === 'POST') {
    if (me.role !== 'admin') return fail('只有管理员可以创建账号', 403);

    const username = str(body.username, 20);
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'normal';

    const nameErr = validateUsername(username);
    if (nameErr) return fail(nameErr);
    const passErr = validatePassword(password);
    if (passErr) return fail(passErr);
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return fail('该用户名已被使用', 409);
    }

    const salt = randomSalt();
    const user = {
      id: newId('u'),
      username,
      salt,
      passwordHash: await hashPassword(salt, password),
      pv: 1,
      role,
      status: 'active',
      createdAt: nowIso()
    };
    db.users.push(user);
    await writeDb(env, db);
    return ok(publicUser(user), 201);
  }

  const userMatch = path.match(/^\/api\/users\/([\w-]+)(\/password)?$/);
  if (userMatch) {
    const id = userMatch[1];
    const isPassword = Boolean(userMatch[2]);
    const index = db.users.findIndex((u) => u.id === id);
    if (index === -1) return fail('账号不存在', 404);
    const target = db.users[index];

    if (isPassword && method === 'POST') {
      if (me.role !== 'admin') return fail('只有管理员可以重置密码', 403);
      const passErr = validatePassword(body.newPassword);
      if (passErr) return fail(passErr);
      target.salt = randomSalt();
      target.passwordHash = await hashPassword(target.salt, body.newPassword);
      target.pv = (target.pv || 1) + 1;
      await writeDb(env, db);
      return ok({ reset: target.username });
    }

    if (method === 'PATCH') {
      if (me.role !== 'admin') return fail('只有管理员可以修改账号', 403);
      if (target.id === me.id && body.status && body.status !== target.status) {
        return fail('不能停用自己的账号', 400);
      }
      if (body.status === 'active' || body.status === 'disabled') {
        target.status = body.status;
      }
      await writeDb(env, db);
      return ok(publicUser(target));
    }

    if (method === 'DELETE') {
      if (me.role !== 'admin') return fail('只有管理员可以删除账号', 403);
      if (target.id === me.id) return fail('不能删除自己的账号', 400);
      if (target.role === 'admin' && db.users.filter((u) => u.role === 'admin' && u.status === 'active').length <= 1) {
        return fail('至少要保留一个可用的管理员账号', 400);
      }
      db.users.splice(index, 1);
      await writeDb(env, db);
      return ok({ deleted: target.username });
    }
  }

  return fail('接口不存在：' + method + ' ' + path, 404);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Pages Functions 入口（路由 /api/[[path]] 全捕获）                    */
/* ------------------------------------------------------------------ */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  try {
    return await handleApi(request, env, url);
  } catch (err) {
    return fail('服务端错误：' + (err && err.message ? err.message : String(err)), 500);
  }
}
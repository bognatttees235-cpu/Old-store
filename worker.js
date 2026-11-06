// Cloudflare Worker: аккаунты, права администратора по ключу, загрузка APK в GitHub.
// Переменные (Settings → Variables): GH_TOKEN, REPO ("ник/репозиторий"), SECRET (длинная случайная строка),
// ADMIN_KEYS (JSON-список ключей админа: ["ключ1","ключ2"]), MODERATE ("1" = новые приложения сначала на проверку).
// Привязка KV (Settings → Bindings → KV namespace): имя переменной USERS.
const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
const fromB64 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
const toB64 = (s) => btoa(unescape(encodeURIComponent(s)));

async function pbkdf2(pass, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, k, 256));
}
async function sign(env, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(env.SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
async function makeToken(env, u) {
  const d = btoa(JSON.stringify({ u, e: Date.now() + 30 * 864e5 }));
  return d + "." + (await sign(env, d));
}
async function readToken(env, t) {
  if (!t || String(t).indexOf(".") < 0) return null;
  const [d, s] = String(t).split(".");
  if (s !== (await sign(env, d))) return null;
  const p = JSON.parse(atob(d));
  return p.e > Date.now() ? p.u : null;
}

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
    if (req.method === "OPTIONS") return out({});
    if (req.method !== "POST") return out({ ok: true });

    const path = new URL(req.url).pathname;
    let body = {}, form = null;
    if (path === "/upload") form = await req.formData();
    else body = await req.json().catch(() => ({}));

    // ---- регистрация и вход
    if (path === "/register" || path === "/login") {
      const name = String(body.user || "").toLowerCase(), pass = String(body.pass || "");
      if (!/^[a-z0-9_]{3,20}$/.test(name)) return out({ error: "Имя: 3–20 символов, латиница, цифры или _" }, 400);
      if (pass.length < 6) return out({ error: "Пароль не короче 6 символов" }, 400);
      const key = "u:" + name, rec = await env.USERS.get(key, "json");
      if (path === "/register") {
        if (rec) return out({ error: "Такое имя уже занято" }, 409);
        const salt = crypto.randomUUID();
        await env.USERS.put(key, JSON.stringify({ salt, hash: await pbkdf2(pass, salt), admin: false }));
        return out({ ok: true, token: await makeToken(env, name), user: name, admin: false });
      }
      if (!rec || rec.hash !== (await pbkdf2(pass, rec.salt))) return out({ error: "Неверное имя или пароль" }, 403);
      if (rec.banned) return out({ error: "Аккаунт заблокирован" }, 403);
      return out({ ok: true, token: await makeToken(env, name), user: name, admin: !!rec.admin });
    }

    // ---- дальше нужен вход в аккаунт
    const uname = await readToken(env, form ? form.get("token") : body.token);
    const rec = uname ? await env.USERS.get("u:" + uname, "json") : null;
    if (!rec) return out({ error: "Войдите в аккаунт" }, 401);
    if (rec.banned) return out({ error: "Аккаунт заблокирован", banned: true }, 403);
    const me = { name: uname, admin: !!rec.admin };

    if (path === "/me") return out({ ok: true, user: me.name, admin: me.admin });

    if (path === "/admin") { // получить права администратора по ключу
      let keys;
      const raw = String(env.ADMIN_KEYS || "").trim();
      try { keys = JSON.parse(raw); } catch (e) { keys = raw.split(","); }
      if (!Array.isArray(keys)) keys = [String(keys)];
      keys = keys.map((k) => String(k).trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      if (keys.indexOf(String(body.key || "").trim()) < 0) return out({ error: "Неверный ключ администратора" }, 403);
      rec.admin = true;
      await env.USERS.put("u:" + uname, JSON.stringify(rec));
      return out({ ok: true, admin: true });
    }

    const gh = (p, o = {}) => fetch("https://api.github.com/repos/" + env.REPO + "/contents/" + p, {
      ...o, headers: { Authorization: "Bearer " + env.GH_TOKEN, "User-Agent": "apk-worker", Accept: "application/vnd.github+json" },
    });
    const getList = async (f) => {
      const r = await gh(f);
      if (!r.ok) return { sha: undefined, data: { apps: [] } };
      const j = await r.json(), data = JSON.parse(fromB64(j.content));
      if (!data.apps) data.apps = [];
      return { sha: j.sha, data };
    };
    const putList = (f, data, sha, msg) => gh(f, { method: "PUT", body: JSON.stringify({ message: msg, content: toB64(JSON.stringify(data, null, 1)), sha }) });

    // ---- действия администратора
    if (["/pending", "/approve", "/delete", "/users", "/ban", "/unban"].indexOf(path) >= 0) {
      if (!me.admin) return out({ error: "Нужны права администратора" }, 403);
      if (path === "/users") {
        const l = await env.USERS.list({ prefix: "u:" });
        const users = await Promise.all(l.keys.map(async (k) => { const r = (await env.USERS.get(k.name, "json")) || {}; return { name: k.name.slice(2), admin: !!r.admin, banned: !!r.banned }; }));
        return out({ ok: true, users });
      }
      if (path === "/ban" || path === "/unban") {
        const t = String(body.name || "").toLowerCase(), r = await env.USERS.get("u:" + t, "json");
        if (!r) return out({ error: "Пользователь не найден" }, 404);
        if (r.admin) return out({ error: "Нельзя заблокировать администратора" }, 400);
        r.banned = path === "/ban";
        await env.USERS.put("u:" + t, JSON.stringify(r));
        return out({ ok: true });
      }
      if (path === "/pending") return out({ ok: true, apps: (await getList("pending.json")).data.apps });
      const id = String(body.id || "");
      if (path === "/approve") {
        const p = await getList("pending.json"), i = p.data.apps.findIndex((a) => a.id === id);
        if (i < 0) return out({ error: "Не найдено" }, 404);
        const a = p.data.apps.splice(i, 1)[0], c = await getList("apps.json");
        c.data.apps.push(a);
        await putList("apps.json", c.data, c.sha, "Одобрено: " + a.name);
        await putList("pending.json", p.data, p.sha, "Из очереди: " + a.name);
        return out({ ok: true });
      }
      const f = body.from === "pending" ? "pending.json" : "apps.json", c = await getList(f), n = c.data.apps.length;
      c.data.apps = c.data.apps.filter((a) => a.id !== id);
      if (c.data.apps.length === n) return out({ error: "Не найдено" }, 404);
      await putList(f, c.data, c.sha, "Удалено: " + id);
      return out({ ok: true });
    }

    // ---- загрузка приложения (нужен только аккаунт)
    if (path === "/upload") {
      const file = form.get("file");
      if (!file || !String(file.name).toLowerCase().endsWith(".apk")) return out({ error: "Нужен файл .apk" }, 400);
      if (file.size > 25 * 1024 * 1024) return out({ error: "Файл больше 25 МБ" }, 413);
      const buf = new Uint8Array(await file.arrayBuffer());
      const hash = hex(await crypto.subtle.digest("SHA-256", buf));
      const name = String(form.get("name")).slice(0, 60);
      const id = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app") + "-" + Date.now();
      const apkPath = "apps/" + id + ".apk";
      let r = await gh(apkPath, { method: "PUT", body: JSON.stringify({ message: "APK: " + name, content: b64(buf) }) });
      if (!r.ok) return out({ error: "GitHub: не удалось сохранить APK" }, 502);
      const moderated = env.MODERATE === "1" && !me.admin, listFile = moderated ? "pending.json" : "apps.json";
      const L = await getList(listFile);
      L.data.apps.push({
        id, name, cat: form.get("cat") === "game" ? "game" : "app", version: String(form.get("version")).slice(0, 20),
        minSdk: parseInt(form.get("minSdk"), 10) || 4, size: (file.size / 1048576).toFixed(1) + " МБ", apk: apkPath,
        icon: "", desc: "", featured: false, author: me.name, sha256: hash,
      });
      r = await putList(listFile, L.data, L.sha, "Каталог: " + name);
      if (!r.ok) return out({ error: "GitHub: не удалось обновить каталог" }, 502);
      return out({ ok: true, msg: moderated ? "Принято, ждёт проверки администратора." : "Опубликовано. Сайт обновится через минуту." });
    }
    return out({ error: "Неизвестный запрос" }, 404);
  },
};

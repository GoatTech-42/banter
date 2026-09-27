// banter - goattech chat (Luke 9/26). Lean + encrypted at rest:
// - message bodies + media + bios AES-256-GCM (key in ramjet-data/banter/key.hex, 0600)
// - retention: 400 msgs/room, media expires after 21d, images capped client-side
// - private groups by invite code only, 20-member cap, owner/mod kick+ban
// - DMs need mutual friends; invites deliver the code by DM (system message)
// - no voice chat (Luke's call). severe slurs filtered; basic swearing fine.
import { readFile, writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, randomUUID, createHash } from "node:crypto";

const DIR = "/home/luke/goattech/ramjet-data/banter";
const MSG_DIR = join(DIR, "msgs");
const MEDIA_DIR = join(DIR, "media");
const META = join(DIR, "meta.json");
const MAX_MSGS = 400, MAX_GROUP = 20, MEDIA_MAX_AGE = 21 * 864e5, MEDIA_MAX_BYTES = 450 * 1024, AVATAR_MAX_BYTES = 90 * 1024;
const SLURS = /\b(n[i1!]+g+[e3]+r+s?|n[i1!]+g+a+h?s?|f+a+g+g*[o0]+t+s?|k[i1!]+k+e+s?|t+r+a+n+n+(y|i+e+)?s?\b|ch[i1!]+n+k+s?|sp[i1!]+c+s?|wetback?s?|g[o0][o0]+k+s?)\b/gi;

let key = null;
async function loadKey() {
	if (key) return key;
	try { key = Buffer.from((await readFile(join(DIR, "key.hex"), "utf8")).trim(), "hex"); }
	catch (e) {
		key = randomBytes(32);
		await mkdir(DIR, { recursive: true });
		await writeFile(join(DIR, "key.hex"), key.toString("hex"), { mode: 0o600 });
	}
	return key;
}
function enc(text, k) {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", k, iv);
	const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
	return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function dec(o, k) {
	try {
		if (!o || !o.iv) return "";
		const d = createDecipheriv("aes-256-gcm", k, Buffer.from(o.iv, "base64"));
		d.setAuthTag(Buffer.from(o.tag, "base64"));
		return Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]).toString("utf8");
	} catch (e) { return ""; }
}
async function loadMeta() {
	try { return JSON.parse(await readFile(META, "utf8")); }
	catch (e) { return { users: {}, rooms: {}, seq: 1 }; }
}
async function saveMeta(m) { await mkdir(DIR, { recursive: true }); await writeFile(META, JSON.stringify(m)); }
function userRec(meta, id) {
	const u = meta.users[id] || (meta.users[id] = { id, name: "", createdAt: Date.now() });
	if (!Array.isArray(u.friends)) u.friends = [];
	if (!Array.isArray(u.freqIn)) u.freqIn = [];
	if (!Array.isArray(u.freqOut)) u.freqOut = [];
	return u;
}
function uidFor(ctx, meta) {
	// ramjet passes ctx.user as the username STRING (older addons may pass an
	// object) - accept both. Bug fix 9/26: object-only access collapsed every
	// user into "anon".
	const cu = ctx && ctx.user;
	const raw = (typeof cu === "string" && cu) || (cu && (cu.id || cu.name || cu.email)) || "anon";
	const id = "u-" + createHash("sha256").update(String(raw)).digest("hex").slice(0, 12);
	userRec(meta, id);
	return id;
}
async function appendMsg(roomId, rec) {
	await mkdir(MSG_DIR, { recursive: true });
	const f = join(MSG_DIR, roomId + ".log");
	await writeFile(f, JSON.stringify(rec) + "\n", { flag: "a" });
	try {
		const lines = (await readFile(f, "utf8")).trim().split("\n");
		if (lines.length > MAX_MSGS) await writeFile(f, lines.slice(-MAX_MSGS).join("\n") + "\n");
	} catch (e) {}
}
async function readMsgs(roomId, after, k) {
	try {
		const lines = (await readFile(join(MSG_DIR, roomId + ".log"), "utf8")).trim().split("\n");
		const out = [];
		for (const ln of lines) {
			let r; try { r = JSON.parse(ln); } catch (e) { continue; }
			if (r.i <= after) continue;
			const body = JSON.parse(dec(r.body, k) || "{}");
			out.push({ i: r.i, u: r.u, ts: r.ts, type: r.type, ...(r.bot ? { bot: r.bot } : {}), ...body });
		}
		return out;
	} catch (e) { return []; }
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }
async function body(req) { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch (e) { return {}; } }
function clean(text) { return String(text || "").replace(SLURS, "***").slice(0, 2000); }
function isMod(room, me) { return room.owner === me || (room.mods || []).includes(me); }
async function storeMedia(k, b64, cap) {
	const buf = Buffer.from(String(b64 || ""), "base64");
	if (!buf.length || buf.length > cap) return null;
	const mid = randomUUID().slice(0, 12).replace(/-/g, "") + randomBytes(2).toString("hex");
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", k, iv);
	await mkdir(MEDIA_DIR, { recursive: true });
	await writeFile(join(MEDIA_DIR, mid + ".bin"), Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]));
	return mid;
}
function pubUser(u) { return u.name ? { name: u.name, avatar: u.avatar || "" } : null; }

export default async function banter(req, res, route, url, ctx) {
	const k = await loadKey();
	const meta = await loadMeta();
	const me = uidFor(ctx, meta);
	const R = String(route || "");

	if (R === "state" && req.method === "GET") {
		const myRec = userRec(meta, me);
		await saveMeta(meta);
		const rooms = Object.values(meta.rooms).filter((r) => r.members.includes(me)).map((r) => {
			const otherId = r.kind === "dm" ? r.members.find((id) => id !== me) : null;
			const other = otherId && meta.users[otherId];
			return {
				id: r.id, name: r.name, kind: r.kind, icon: r.icon || null,
				otherName: other && other.name ? other.name : null,
				code: isMod(r, me) ? r.code : undefined, owner: r.owner === me, mod: isMod(r, me),
				members: r.members.length, last: r.last || 0,
			};
		});
		const users = {};
		for (const u of Object.values(meta.users)) { const p = pubUser(u); if (p) users[u.id] = p; }
		return json(res, 200, { ok: true, me, name: myRec.name || "", rooms, users, friends: myRec.friends, freqIn: myRec.freqIn, freqOut: myRec.freqOut });
	}
	if (R === "name" && req.method === "POST") {
		const b = await body(req);
		const name = String(b.name || "").trim().slice(0, 24);
		if (!name) return json(res, 400, { error: "need a name" });
		userRec(meta, me).name = clean(name);
		await saveMeta(meta);
		return json(res, 200, { ok: true });
	}
	if (R === "profile" && req.method === "GET") {
		const u = meta.users[url.searchParams.get("user") || ""];
		if (!u || !u.name) return json(res, 404, { error: "no such user" });
		const myRec = userRec(meta, me);
		const rel = myRec.friends.includes(u.id) ? "friends" : myRec.freqOut.includes(u.id) ? "sent" : myRec.freqIn.includes(u.id) ? "incoming" : "none";
		return json(res, 200, { ok: true, id: u.id, name: u.name, avatar: u.avatar || "", bio: dec(u.bio, k), rel });
	}
	if (R === "profile" && req.method === "POST") {
		const b = await body(req);
		userRec(meta, me).bio = enc(clean(b.bio).slice(0, 300), k);
		await saveMeta(meta);
		return json(res, 200, { ok: true });
	}
	if (R === "avatar" && req.method === "POST") {
		const b = await body(req);
		const mid = await storeMedia(k, b.data, AVATAR_MAX_BYTES);
		if (!mid) return json(res, 413, { error: "avatar too big or empty" });
		userRec(meta, me).avatar = mid;
		await saveMeta(meta);
		return json(res, 200, { ok: true, avatar: mid });
	}
	if ((R === "friend" || R === "unfriend" || R === "accept" || R === "decline") && req.method === "POST") {
		const b = await body(req);
		const other = meta.users[String(b.user || "")];
		if (!other || other.id === me) return json(res, 404, { error: "no such user" });
		userRec(meta, other.id);
		const mine = userRec(meta, me);
		const rm = (a, v) => { const i = a.indexOf(v); if (i >= 0) a.splice(i, 1); };
		if (R === "friend") {
			if (mine.friends.includes(other.id)) return json(res, 200, { ok: true, rel: "friends" });
			if (mine.freqIn.includes(other.id)) { // they asked already - accepting makes it mutual
				rm(mine.freqIn, other.id); rm(other.freqOut, me);
				mine.friends.push(other.id); other.friends.push(me);
			} else if (!mine.freqOut.includes(other.id)) { mine.freqOut.push(other.id); other.freqIn.push(me); }
		}
		if (R === "accept") { if (mine.freqIn.includes(other.id)) { rm(mine.freqIn, other.id); rm(other.freqOut, me); mine.friends.push(other.id); other.friends.push(me); } }
		if (R === "decline") { rm(mine.freqIn, other.id); rm(other.freqOut, me); }
		if (R === "unfriend") { rm(mine.friends, other.id); rm(other.friends, me); }
		await saveMeta(meta);
		return json(res, 200, { ok: true });
	}
	if (R === "room" && req.method === "POST") {
		const b = await body(req);
		const name = clean(b.name).slice(0, 40) || "room";
		const id = "r-" + randomUUID().slice(0, 8);
		const icon = b.emoji ? { emoji: String(b.emoji).slice(0, 8) } : null;
		meta.rooms[id] = { id, name, kind: "room", code: randomBytes(4).toString("hex"), owner: me, mods: [], banned: [], icon, members: [me], createdAt: Date.now(), last: 0 };
		await saveMeta(meta);
		return json(res, 200, { ok: true, id, code: meta.rooms[id].code });
	}
	if (R === "join" && req.method === "POST") {
		const b = await body(req);
		const room = Object.values(meta.rooms).find((r) => r.code === String(b.code || "").trim().toLowerCase());
		if (!room) return json(res, 404, { error: "no room with that code" });
		if ((room.banned || []).includes(me)) return json(res, 403, { error: "banned from that room" });
		if (!room.members.includes(me)) {
			if (room.members.length >= MAX_GROUP) return json(res, 403, { error: "room is full (20)" });
			room.members.push(me);
		}
		await saveMeta(meta);
		return json(res, 200, { ok: true, id: room.id });
	}
	if ((R === "kick" || R === "ban" || R === "mod" || R === "rename" || R === "roomicon") && req.method === "POST") {
		const b = await body(req);
		const room = meta.rooms[b.room];
		if (!room || room.kind !== "room" || !room.members.includes(me)) return json(res, 403, { error: "not in that room" });
		if (R === "rename") { if (!isMod(room, me)) return json(res, 403, { error: "mods only" }); room.name = clean(b.name).slice(0, 40) || room.name; }
		if (R === "roomicon") {
			if (!isMod(room, me)) return json(res, 403, { error: "mods only" });
			if (b.emoji) room.icon = { emoji: String(b.emoji).slice(0, 8) };
			else if (b.data) { const mid = await storeMedia(k, b.data, AVATAR_MAX_BYTES); if (!mid) return json(res, 413, { error: "icon too big" }); room.icon = { media: mid }; }
		}
		if (R === "kick" || R === "ban") {
			if (!isMod(room, me)) return json(res, 403, { error: "mods only" });
			const target = String(b.user || "");
			if (target === room.owner) return json(res, 403, { error: "can't touch the owner" });
			const i = room.members.indexOf(target); if (i >= 0) room.members.splice(i, 1);
			if (R === "ban" && !(room.banned || (room.banned = [])).includes(target)) room.banned.push(target);
		}
		if (R === "mod") {
			if (room.owner !== me) return json(res, 403, { error: "owner only" });
			const target = String(b.user || "");
			room.mods = room.mods || [];
			const i = room.mods.indexOf(target);
			if (b.on && i < 0 && room.members.includes(target)) room.mods.push(target);
			if (!b.on && i >= 0) room.mods.splice(i, 1);
		}
		await saveMeta(meta);
		return json(res, 200, { ok: true });
	}
	if (R === "members" && req.method === "GET") {
		const room = meta.rooms[url.searchParams.get("room") || ""];
		if (!room || !room.members.includes(me)) return json(res, 403, { error: "not in that room" });
		const list = room.members.map((id) => { const u = meta.users[id] || {}; return { id, name: u.name || "?", avatar: u.avatar || "", owner: room.owner === id, mod: isMod(room, id) }; });
		return json(res, 200, { ok: true, members: list, me, roomOwner: room.owner === me, iMod: isMod(room, me) });
	}
	if (R === "invite" && req.method === "POST") {
		const b = await body(req);
		const room = meta.rooms[b.room];
		const other = meta.users[String(b.user || "")];
		if (!room || room.kind !== "room" || !room.members.includes(me)) return json(res, 403, { error: "not in that room" });
		if (!other) return json(res, 404, { error: "no such user" });
		if (room.members.includes(other.id)) return json(res, 200, { ok: true, note: "already in" });
		// deliver the code as a system invite message in a dm (friend gate bypassed for invites)
		let dm = Object.values(meta.rooms).find((r) => r.kind === "dm" && r.members.includes(me) && r.members.includes(other.id));
		if (!dm) {
			dm = { id: "d-" + randomUUID().slice(0, 8), name: "dm", kind: "dm", code: "", owner: me, mods: [], banned: [], icon: null, members: [me, other.id], createdAt: Date.now(), last: 0 };
			meta.rooms[dm.id] = dm;
		}
		const rec = { i: meta.seq++, u: me, ts: Date.now(), type: "invite", body: enc(JSON.stringify({ room: room.id, roomName: room.name, code: room.code }), k) };
		await appendMsg(dm.id, rec);
		dm.last = rec.ts;
		await saveMeta(meta);
		return json(res, 200, { ok: true });
	}
	if (R === "dm" && req.method === "POST") {
		const b = await body(req);
		const other = meta.users[String(b.user || "")];
		if (!other) return json(res, 404, { error: "no such user" });
		// mutual friends only (Luke 9/34: replaces the shared-room rule)
		if (!userRec(meta, me).friends.includes(other.id)) return json(res, 403, { error: "friends first" });
		const existing = Object.values(meta.rooms).find((r) => r.kind === "dm" && r.members.includes(me) && r.members.includes(other.id));
		if (existing) return json(res, 200, { ok: true, id: existing.id });
		const id = "d-" + randomUUID().slice(0, 8);
		meta.rooms[id] = { id, name: "dm", kind: "dm", code: "", owner: me, mods: [], banned: [], icon: null, members: [me, other.id], createdAt: Date.now(), last: 0 };
		await saveMeta(meta);
		return json(res, 200, { ok: true });
	}
	if (R === "msg" && req.method === "POST") {
		const b = await body(req);
		const room = meta.rooms[b.room];
		if (!room || !room.members.includes(me)) return json(res, 403, { error: "not in that room" });
		const type = ["text", "image", "gif", "poll"].includes(b.type) ? b.type : "text";
		const payload = {};
		if (type === "text") { payload.text = clean(b.text); if (!payload.text.trim()) return json(res, 400, { error: "empty" }); }
		if (type === "gif") { payload.url = String(b.url || "").slice(0, 300); if (!/^https:\/\/[a-z0-9.-]*tenor\.com\//.test(payload.url)) return json(res, 400, { error: "bad gif" }); payload.text = clean(b.text); }
		if (type === "poll") {
			payload.question = clean(b.question).slice(0, 120);
			payload.options = (Array.isArray(b.options) ? b.options : []).slice(0, 6).map((o) => clean(o).slice(0, 40)).filter(Boolean);
			payload.votes = {};
			if (payload.options.length < 2 || !payload.question) return json(res, 400, { error: "poll needs a question + 2 options" });
		}
		if (type === "image") {
			const mid = await storeMedia(k, b.data, MEDIA_MAX_BYTES);
			if (!mid) return json(res, 413, { error: "image too big" });
			payload.media = mid;
			payload.text = clean(b.text);
		}
		const rec = { i: meta.seq++, u: me, ts: Date.now(), type, body: enc(JSON.stringify(payload), k) };
		if (typeof b.bot === "string" && b.bot.trim()) rec.bot = clean(b.bot).slice(0, 24);
		await appendMsg(room.id, rec);
		room.last = rec.ts;
		await saveMeta(meta);
		return json(res, 200, { ok: true, i: rec.i });
	}
	if (R === "msgs" && req.method === "GET") {
		const room = meta.rooms[url.searchParams.get("room") || ""];
		if (!room || !room.members.includes(me)) return json(res, 403, { error: "not in that room" });
		const after = parseInt(url.searchParams.get("after") || "0") || 0;
		const msgs = await readMsgs(room.id, after, k);
		const users = {};
		for (const u of Object.values(meta.users)) { const p = pubUser(u); if (p) users[u.id] = p; }
		return json(res, 200, { ok: true, msgs, users, me });
	}
	if (R === "vote" && req.method === "POST") {
		const b = await body(req);
		const room = meta.rooms[b.room];
		if (!room || !room.members.includes(me)) return json(res, 403, { error: "not in that room" });
		const f = join(MSG_DIR, room.id + ".log");
		let lines = [];
		try { lines = (await readFile(f, "utf8")).trim().split("\n"); } catch (e) { return json(res, 404, { error: "no poll" }); }
		let done = false;
		const out = lines.map((ln) => {
			let r; try { r = JSON.parse(ln); } catch (e) { return ln; }
			if (r.i === b.msg && r.type === "poll") {
				const pb = JSON.parse(dec(r.body, k) || "{}");
				pb.votes = pb.votes || {};
				pb.votes[me] = Math.max(0, Math.min((b.option | 0), (pb.options || []).length - 1));
				r.body = enc(JSON.stringify(pb), k);
				done = true;
				return JSON.stringify(r);
			}
			return ln;
		});
		if (done) await writeFile(f, out.join("\n") + "\n");
		return json(res, done ? 200 : 404, { ok: done });
	}
	if (R === "gifsearch" && req.method === "GET") {
		// tenor public demo key (what proxy sites use) - zero storage, results proxied
		const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
		if (!q) return json(res, 200, { ok: true, gifs: [] });
		try {
			const r = await fetch("https://g.tenor.com/v1/search?q=" + encodeURIComponent(q) + "&key=LIVDSRZULELA&limit=12&media_filter=basic", { signal: AbortSignal.timeout(10000) });
			const d = await r.json();
			const gifs = ((d && d.results) || []).map((g) => {
				const m = (g.media && g.media[0]) || {};
				const tiny = (m.tinygif && m.tinygif.url) || (m.nanogif && m.nanogif.url) || "";
				const full = (m.gif && m.gif.url) || tiny;
				return tiny && full ? { id: g.id, tiny: "/api/banter/gifimg?u=" + Buffer.from(tiny).toString("base64"), full: "/api/banter/gifimg?u=" + Buffer.from(full).toString("base64") } : null;
			}).filter(Boolean);
			return json(res, 200, { ok: true, gifs });
		} catch (e) { return json(res, 502, { error: "gif search failed" }); }
	}
	if (R === "gifimg" && req.method === "GET") {
		let u = "";
		try { u = Buffer.from(String(url.searchParams.get("u") || ""), "base64").toString(); } catch (e) {}
		if (!/^https:\/\/[a-z0-9.-]*tenor\.com\//.test(u)) return json(res, 400, { error: "bad url" });
		try {
			const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
			if (!r.ok) return json(res, 502, { error: "gif fetch failed" });
			res.writeHead(200, { "content-type": r.headers.get("content-type") || "image/gif", "cache-control": "public, max-age=86400" });
			if (!r.body) return res.end();
			for await (const chunk of r.body) { if (!res.write(chunk)) await new Promise((d2) => res.once("drain", d2)); }
			return res.end();
		} catch (e) { return json(res, 502, { error: "gif fetch failed" }); }
	}
	if (R === "media" && req.method === "GET") {
		const mid = String(url.searchParams.get("id") || "");
		if (!/^[a-f0-9]{12,16}$/.test(mid)) return json(res, 400, { error: "bad id" });
		try {
			const raw = await readFile(join(MEDIA_DIR, mid + ".bin"));
			const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16);
			const d = createDecipheriv("aes-256-gcm", k, iv);
			d.setAuthTag(tag);
			const buf = Buffer.concat([d.update(ct), d.final()]);
			res.writeHead(200, { "content-type": "image/webp", "cache-control": "private, max-age=86400" });
			return res.end(buf);
		} catch (e) { return json(res, 404, { error: "gone" }); }
	}
	if (R === "sweep" && req.method === "POST") {
		let n = 0;
		try {
			for (const f of await readdir(MEDIA_DIR)) {
				const st = await stat(join(MEDIA_DIR, f));
				if (Date.now() - st.mtimeMs > MEDIA_MAX_AGE) { await unlink(join(MEDIA_DIR, f)); n++; }
			}
		} catch (e) {}
		return json(res, 200, { ok: true, swept: n });
	}
	return json(res, 404, { error: "unknown banter route" });
}

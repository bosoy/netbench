// a2s - steam master server query (A2S_INFO), только встроенный dgram
// формат: https://developer.valvesoftware.com/wiki/Server_Queries
'use strict';

const dgram = require('dgram');
const { execFile } = require('child_process');
const NIX = require('./nixstat.js');

const HEAD = [0xFF, 0xFF, 0xFF, 0xFF];
const C_INFO = 0x54, C_PLAYER = 0x55, C_RULES = 0x56;
// запрос info обязан нести текст "Source Engine Query": без него сервер делает
// вид, что нас не существует, и отвечает challenge'ем в пустоту
const QUERY_TEXT = Array.from(Buffer.from('Source Engine Query', 'utf8'));
// challenge приходит двумя байтами: 0x67 - старым (goldsrc), 0x41 - в актуальном
// протоколе valve. раньше знал только 0x67, поэтому живой ответ читался как null
const S2A_CHALLENGE = [0x67, 0x41];
const S2A_INFO_SRC = 0x49;       // актуальный ответ, им говорит arma 3
const S2A_INFO = [0x6D, 0x6A];   // goldsrc / старый source, остался для старых сборок
const S2A_SCHEDULER = 0x66;     // зарезервированный байт планировщика перед командой
const S2A_PLAYER = 0x44;
const S2A_RULES = 0x45;

// повтор с challenge обязан идти с того же ip:port, что и первый запрос,
// поэтому сокет один на весь обмен, а не на каждую отправку
function openSocket() {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket('udp4');
		sock.once('error', reject);
		sock.bind(0, () => resolve(sock));
	});
}

function ask(sock, host, port, payload, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), timeoutMs);
		sock.once('message', (msg) => { clearTimeout(timer); resolve(msg); });
		sock.send(Buffer.from(payload), port, host, (err) => { if (err) { clearTimeout(timer); resolve(null); } });
	});
}

function readStr(buf, i) {
	const j = buf.indexOf(0, i);
	if (j < 0) return ['', buf.length];
	return [buf.toString('utf8', i, j), j + 1];
}

function buildReq(cmd, chall) {
	// info: текст "Source Engine Query" обязателен, а challenge в первом запросе
	// не нужен вовсе - четыре 0xff там путают сервер. повтор обязан нести ровно
	// те 4 байта, что пришлись на ответе challenge
	if (cmd !== C_INFO) {
		// player и rules текста не несут: только challenge (-1 в первом запросе)
		return Buffer.from([...HEAD, cmd, ...(chall || [0xFF, 0xFF, 0xFF, 0xFF])]);
	}
	const parts = [...HEAD, cmd, ...QUERY_TEXT, 0];
	if (chall) for (const b of chall) parts.push(b);
	return Buffer.from(parts);
}

// вызов команды с обязательным эхом challenge. повтор обязан идти тем же сокетом
// и на тот же порт, поэтому сокет один на весь обмен
async function command(sock, host, port, cmd, timeoutMs) {
	let msg = await ask(sock, host, port, buildReq(cmd, null), timeoutMs);
	if (!msg) return { msg: null };
	let i = 4;
	if (msg[i] === S2A_SCHEDULER) i++;
	if (S2A_CHALLENGE.indexOf(msg[i]) >= 0) {
		const chall = msg.slice(i + 1, i + 5);
		msg = await ask(sock, host, port, buildReq(cmd, chall), timeoutMs);
		if (!msg) return { msg: null, challengeOnly: true };
	}
	return { msg };
}

function parseInfo(msg) {
	if (!msg || msg.length < 6 || msg.readUInt32LE(0) !== 0xFFFFFFFF) return null;
	let i = 4;
	if (msg[i] === S2A_SCHEDULER) i++;
	if (S2A_CHALLENGE.indexOf(msg[i]) >= 0) return { challenge: msg.slice(i + 1, i + 5) };
	const src = msg[i] === S2A_INFO_SRC;
	if (!src && S2A_INFO.indexOf(msg[i]) < 0) return null;
	i++;
	const out = { protocol: msg[i], reply: msg[i - 1] };
	i++;
	let s;
	[s, i] = readStr(msg, i); out.name = s;
	[s, i] = readStr(msg, i); out.map = s;
	[s, i] = readStr(msg, i); out.folder = s;
	[s, i] = readStr(msg, i); out.game = s;
	if (i + 8 > msg.length) return out;
	out.appId = msg.readUInt16LE(i);
	i += 2;
	// счётчики идут подряд в обоих протоколах, а вот за ними в актуальном ответе
	// стоит НЕ версия: serverType, environment, затем visibility и vac, и только
	// за ними номер сборки. два последних байта парсер пропускал - версия
	// читалась из нулевого visibility, проверка не проходила, и живой сервер
	// отдавал «info table unreadable»
	out.players = msg[i]; out.maxPlayers = msg[i + 1]; out.bots = msg[i + 2];
	out.dedicated = String.fromCharCode(msg[i + 3] || 0);
	out.os = String.fromCharCode(msg[i + 4] || 0);
	let version = '';
	for (const skip of (src ? [2, 0] : [0, 2])) {
		const [v] = readStr(msg, i + 5 + skip);
		if (/^[0-9][0-9a-zA-Z._]*$/.test(v)) { version = v; break; }
	}
	out.version = version;
	// правдоподобие считаем, но не блокируем ответ: имена и карта читаются
	// всегда, а спорные слоты должны уехать в лог, а не исчезнуть в «no answer»
	const bad = [];
	if (!(out.maxPlayers >= 1 && out.maxPlayers <= 1024)) bad.push('maxPlayers=' + out.maxPlayers);
	if (out.players > out.maxPlayers) bad.push('players=' + out.players + ' > max');
	if (out.bots > out.maxPlayers) bad.push('bots=' + out.bots + ' > max');
	if (!/[drlDRL]/.test(out.dedicated)) bad.push('dedicated=' + JSON.stringify(out.dedicated));
	if (bad.length) out.suspect = bad.join(', ');
	return out;
}

// правила (A2S_RULES) - это пары нуль-терминированных строк после счётчика.
// для arma 3 браузерные данные едут именно здесь, а не в info
function parseRules(msg) {
	if (!msg || msg.length < 7 || msg.readUInt32LE(0) !== 0xFFFFFFFF) return null;
	let i = 4;
	if (msg[i] === S2A_SCHEDULER) i++;
	if (msg[i] !== S2A_RULES) return null;
	const count = msg.readUInt16LE(i + 1);
	const pairs = [];
	let k = i + 3;
	while (k < msg.length && pairs.length < count * 2) {
		let name, value;
		[name, k] = readStr(msg, k);
		if (k > msg.length) break;
		[value, k] = readStr(msg, k);
		pairs.push({ name: name, value: value });
		if (name === '' && value === '') break;
	}
	return { count: count, pairs: pairs };
}

function parsePlayers(msg) {
	if (!msg || msg.length < 6 || msg.readUInt32LE(0) !== 0xFFFFFFFF) return null;
	let i = 4;
	if (msg[i] === S2A_SCHEDULER) i++;
	if (msg[i] !== S2A_PLAYER) return null;
	const n = msg[i + 1];
	const names = [];
	let k = i + 2;
	for (let j = 0; j < n && k < msg.length; j++) {
		let name;
		[name, k] = readStr(msg, k);
		names.push(name);
		k += 8;   // score (int32) + time (float32), нас они не интересуют
	}
	return { count: n, names: names };
}

// слоты из правил: настоящий ключ ещё ни разу не подтверждён живым ответом,
// поэтому пробуем только явно похожие формы, а ВСЕ пары уезжают в report.json -
// следующий лог должен назвать правильный ключ сам
function slotsFromRules(pairs) {
	const out = {};
	for (const p of pairs || []) {
		const k = String(p.name || '').toLowerCase();
		const v = String(p.value == null ? '' : p.value).trim();
		const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
		if (frac && /slot|players|max/.test(k)) {
			out.players = +frac[1]; out.maxPlayers = +frac[2];
		} else if (/^(#)?(maxplayers|max_slots|maximumslots|slots|totalplayers)$/.test(k) && /^\d+$/.test(v)) {
			out.maxPlayers = +v;
		} else if (/^(#)?(players|currentplayers|connectedplayers)$/.test(k) && /^\d+$/.test(v)) {
			out.players = +v;
		}
		if (/^#?(world|map|worldname)$/.test(k) && v) out.map = v;
		if (/^#?(mission|missionname|taskname)$/.test(k) && v) out.mission = v;
		if (/^#?(hostname|name)$/.test(k) && v) out.name = v;
	}
	if (out.maxPlayers != null && out.maxPlayers >= 1 && out.maxPlayers <= 1024) return out;
	delete out.maxPlayers;
	return Object.keys(out).length ? out : null;
}

async function a2sQuery(host, port, timeoutMs = 2500) {
	const target = host + ':' + port;
	const fail = (err, extra) => Object.assign({ ok: false, target: target, err: err }, extra || {});
	let sock;
	try { sock = await openSocket(); } catch (e) { return fail('socket: ' + e.message); }
	const t0 = Date.now();
	try {
		let res = await command(sock, host, port, C_INFO, timeoutMs);
		let info = parseInfo(res.msg);
		if (info && info.name !== undefined && !info.suspect) {
			info.ok = true; info.via = 'info'; info.target = target; info.rttMs = Date.now() - t0;
			return info;
		}
		// что именно помешало info: пустота, один только challenge и нечитаемый
		// ответ - ТРИ РАЗНЫХ диагноза, и второй доказывает, что сокет нас слышит
		const infoErr = res.challengeOnly ? 'info sent a challenge, then stayed silent'
			: !res.msg ? 'no UDP answer'
			: info && info.challenge ? 'challenge twice, no table'
			: !info ? 'answer is not an info table (0x' + (res.msg && res.msg.length > 4 ? res.msg[4] : 0).toString(16) + ')'
			: info.suspect ? 'info counters implausible: ' + info.suspect
			: 'info table unreadable';
		// 2. игрок и правила на тот же порт: браузерные данные arma 3 по спецификации
		// сообщества едут именно в правилах, и пробуем их не только когда info молчит
		const pl = await command(sock, host, port, C_PLAYER, timeoutMs);
		const ru = await command(sock, host, port, C_RULES, timeoutMs);
		const players = parsePlayers(pl.msg);
		const rules = parseRules(ru.msg);
		const fromRules = rules ? slotsFromRules(rules.pairs) : null;
		const seen = (pl.msg ? 'player ' : '') + (ru.msg ? 'rules ' : '');
		if (fromRules && fromRules.maxPlayers != null) {
			const q = Object.assign({}, fromRules);
			if (players && players.count) q.players = players.count;
			if (!q.name) q.name = (info && info.name) || '';
			if (!q.map) q.map = (info && info.map) || '';
			q.ok = true; q.via = 'rules'; q.target = target; q.rttMs = Date.now() - t0;
			q.rules = rules.pairs;
			return q;
		}
		// 3. info дал таблицу и счётчики в неё укладываются, но смутило что-то
		// ещё (например номер сборки не там, где мы его ждём): спорная строка
		// в логе лучше молчания - слоты берём отсюда
		if (info && info.name !== undefined && info.maxPlayers >= 1 && info.maxPlayers <= 1024 &&
			info.players <= info.maxPlayers) {
			const q = Object.assign({}, info);
			q.ok = true; q.via = 'info?'; q.target = target; q.rttMs = Date.now() - t0;
			if (rules) q.rules = rules.pairs;
			return q;
		}
		// ни слотов, ни имени: пишем честно, что хоть как-то ответило, и
		// кладём полученные ключи - их разберёт следующий лог
		const dump = {};
		if (rules) dump.rules = rules.pairs;
		if (info && info.name !== undefined) {
			dump.infoFields = { reply: info.reply, name: info.name, map: info.map, players: info.players,
				maxPlayers: info.maxPlayers, bots: info.bots, version: info.version, suspect: info.suspect };
		}
		if (players && players.count) dump.playerNames = players.names;
		if (res.msg) dump.infoBytes = res.msg.length;
		return fail(infoErr + (seen ? '; answered: ' + seen.trim() + (rules ? ' (' + rules.pairs.length / 2 + ' rule pairs)' : '') : '; player and rules silent too'), dump);
	} finally {
		try { sock.close(); } catch (e) {}
	}
}

// какие из портов слушают udp на ЭТОЙ машине, и на каких адресах. netstat
// локален, поэтому ответ годится только когда цель - loopback: для чужого ip
// «не слушает» ничего не значит. null = netstat не дал читаемого вывода,
// и это не «портов нет»
function udpListeners(ports) {
	return new Promise((resolve) => {
		// linux: netstat там либо отсутствует (busybox), либо не печатает нужную
		// колонку, а /proc/net/udp отдаёт то же самое и без внешнего процесса.
		// форма результата не меняется, поэтому диагноз в netbench.js не знает,
		// на какой ос он собран
		if (NIX.isLinux()) {
			const all = NIX.listenPorts({});
			// фильтр по тем же портам, что и в ветке netstat: без него на
			// коробке с десятком сервисов диагноз «в 2401-2406 ничего не
			// слушает» превратился бы в список всей машины
			if (!all) return resolve(null);
			const want = new Set(ports.map(String));
			return resolve(all.filter((l) => want.has(String(l.port))));
		}
		execFile('netstat', ['-ano', '-p', 'UDP'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
			if (err || !stdout) return resolve(null);
			const want = new Map(ports.map((p) => [String(p), []]));
			for (const line of String(stdout).split(/\r?\n/)) {
				const f = line.trim().split(/\s+/);
				if (f.length < 4 || f[0].toUpperCase() !== 'UDP') continue;
				const m = /^(.*):(\d+)$/.exec(f[1]);       // колонка Local Address
				if (!m) continue;
				const list = want.get(m[2]);
				if (list && list.indexOf(m[1]) < 0) list.push(m[1]);
			}
			const out = [];
			for (const p of ports) {
				const addrs = want.get(String(p));
				if (addrs.length) out.push({ port: p, addrs });
			}
			resolve(out);
		});
	});
}

// адреса, к которым сервер привязан явно: 0.0.0.0 и :: ловят и loopback,
// а вот bind на адрес сетевой карты означает, что запрос на 127.0.0.1 просто
// никуда не приходит - и это ровно то, что даёт «no UDP answer» при живом сервере
function boundIps(listeners) {
	const ips = [];
	for (const l of listeners || []) {
		for (const a of l.addrs) {
			if (a === '0.0.0.0' || a === '::' || /^\[?::\]?$/.test(a)) continue;
			if (/^\[?127\./.test(a)) continue;
			if (ips.indexOf(a) < 0) ips.push(a);
		}
	}
	return ips;
}

module.exports = { a2sQuery, udpListeners, boundIps };

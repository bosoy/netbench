#!/usr/bin/env node
// netbench - железо + линия + basic.cfg
// node netbench.js [--players 40] [--vd 3000] [--world heavy] [--prio balanced] [--target 1.1.1.1:2302]
'use strict';

const os = require('os');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const M = require('./model.js');
const S = require('./sizing.js');
const I = require('./i18n.js');
const NIX = require('./nixstat.js');
const { a2sQuery, udpListeners, boundIps } = require('./a2s.js');

// язык экрана известен уже в parseArgs (usage() печатается до configure)
// батник задаёт то же самое переменными окружения: в них путь с пробелами
// не надо цитировать, а флаг командной строки пришлось бы
let SCREEN_LANG = process.env.NETBENCH_LANG === 'en' ? 'en' : 'ru';

const DOWN_URL = 'https://speed.cloudflare.com/__down?bytes=';
const UP_URL = 'https://speed.cloudflare.com/__up';
const DOWN_MAX = 25000000;   // крупные запросы endpoint режет 4xx-кодом, поэтому лесенка размеров
const UA = { 'User-Agent': 'netbench/1.0' };

function parseArgs(argv) {
	const a = {
		players: 40, vd: 3000, world: 'heavy', prio: 'balanced',
		uplink: null, seconds: 8, samples: 12,
		targets: ['1.1.1.1:443', '8.8.8.8:53'],
		a2s: [], playersGiven: false, auto: false, calibrate: false, aiCap: null,
		watch: null, every: 30, report: false,
		out: '.', comments: true, units: true, skipHw: false, skipNet: false,
		lang: SCREEN_LANG, tee: process.env.NETBENCH_TEE || null,
		set: {},
	};
	// число, а не «что угодно следом за флагом»: nan в uplink превращает всю
	// матрицу соответствия в nan и «nothing fits», и человек ищет проблему в
	// линии вместо перепутанных аргументов батника
	const num = (flag, v) => {
		if (typeof v !== 'string' || v.trim() === '' || isNaN(Number(v))) {
			console.error(flag + ' wants a number, got: ' + (v == null ? 'nothing' : '"' + v + '"'));
			console.error('runbook: netbench_run.cmd [uplink_mbit] [ip:port] [slots] [unit_cap]');
			console.error('the server address may also come first: netbench_run.cmd 127.0.0.1:2402 40 150');
			process.exit(2);
		}
		return Number(v);
	};
	for (let i = 0; i < argv.length; i++) {
		const t = argv[i];
		const next = () => argv[++i];
		switch (t) {
			case '--players': a.players = num(t, next()); a.playersGiven = true; break;
			case '--uplink': a.uplink = num(t, next()); break;
			case '--vd': a.vd = num(t, next()); a.vdGiven = true; break;
			case '--world': a.world = next(); a.worldGiven = true; break;
			case '--prio': a.prio = next(); a.prioGiven = true; break;
			case '--seconds': a.seconds = num(t, next()); break;
			case '--samples': a.samples = num(t, next()); break;
			case '--target': a.targets.push(next()); break;
			case '--a2s': a.a2s.push(next()); break;
			case '--ai-cap': a.aiCap = num(t, next()); break;
			case '--auto': a.auto = true; break;
			case '--calibrate': a.calibrate = true; break;
			case '--watch': a.watch = /^\d+$/.test(argv[i + 1]) ? +argv[++i] : 1440; break;
			case '--every': a.every = Math.max(5, num(t, next())); break;
			case '--report': a.report = true; break;
			case '--out': a.out = next(); break;
			case '--lang': a.lang = next() === 'en' ? 'en' : 'ru'; SCREEN_LANG = a.lang; break;
			case '--tee': a.tee = next(); break;
			case '--no-comments': a.comments = false; break;
			case '--no-units': a.units = false; break;
			case '--no-hw': a.skipHw = true; break;
			case '--no-net': a.skipNet = true; break;
			case '--set': { const s = next(); const i2 = s.indexOf('='); if (i2 > 0) a.set[s.slice(0, i2).trim()] = +s.slice(i2 + 1); break; }
			case '-h': case '--help': usage(); process.exit(0);
			default: console.error('unknown option: ' + t); usage(); process.exit(2);
		}
	}
	if (!M.WORLD[a.world]) a.world = 'heavy';
	if (!M.PRIO[a.prio]) a.prio = 'balanced';
	return a;
}

const USAGE_RU = `netbench - scan hardware, test the line, write basic.cfg

  --players N        слотов на сервере (вход модели); живой --a2s с другим
                     числом перебивает его и это пишется в логе   default 40
  --uplink M         Mbit/s upload; с флагом канал не грузится вовсе, без него
                     скорость меряется (download и upload ~18 секунд загрузки)
  --vd M             дальность видимости, м                    default 3000
  --world quiet|busy|heavy   плотность сцены                   default heavy
  --prio smooth|balanced|save                                   default balanced
  --target host:port дополнительный RTT-адрес (можно несколько),
                     например свой сервер 78.30.250.1:2302
  --a2s ip:port      запрос A2S к живому серверу: сначала info, если он молчит -
                     player и rules; берёт MaxPlayers как slots (можно несколько)
  --auto             записать в basic.cfg лучший класс сцены/приоритет,
                     который влезает в измеренный uplink (по умолчанию только совет)
  --calibrate        запомнить этот бокс как опорную точку для оценки железа;
                     pair with --players/--ai-cap с тем, что на нём реально держат
  --ai-cap N         ваш ffa_evo_allunitmax на опорной машине (для калибровки)
  --seconds N        окно замера скорости, с                   default 8
  --samples N        число замеров RTT на адрес                default 12
  --watch [M]        НЕ разовый прогон, а наблюдение весь день: каждые --every
                     секунд снимать байты адаптера, CPU/RAM процесса сервера и
                     число игроков по A2S; через M минут вывести сводку.     default 1440
                     M обязано быть числом: адреса идут только после --a2s, как
                     в  node netbench.js --watch 1440 --a2s 127.0.0.1:2302
                     --a2s 127.0.0.1:2303 ; сутки с адресами проще запускать
                     netbench_watch.cmd - он сам спрашивает порт и порт+1
  --every S         интервал съёма для --watch, с              default 30
  --report          не снимать, а посчитать сводку по уже собранному watch\\samples.csv
                     линия и точка модели (world/prio/slots/vd) для сравнения
                     берутся из out\\report.json одиночного прогона, если их не
                     задать здесь; слоты сводка всегда берёт с живых ответов
  --out DIR          куда положить basic.cfg и report.json     default .
  --set Key=Value    ручная переопреда любого ключа модели
  --lang ru|en       язык ЭКРАНА: на старых консолях (win7/2008) русские
                     подписи не рисуются, там просят --lang en
  --tee FILE         дублировать вывод в FILE по-русски, независимо от --lang
  --no-comments --no-units --no-hw --no-net
`;

const USAGE_EN = `netbench - scan hardware, test the line, write basic.cfg

  --players N        server slots (model input); a live --a2s answer with
                     another count wins over it and the log says so   default 40
  --uplink M         Mbit/s upload. with it the channel is NOT loaded at all;
                     without it the speed test runs (about 18 s of traffic)
  --vd M             view distance, m                          default 3000
  --world quiet|busy|heavy   scene density                     default heavy
  --prio smooth|balanced|save                                   default balanced
  --target host:port extra RTT address (repeatable), e.g. your server
                     78.30.250.1:2302
  --a2s ip:port      A2S query to a live server: info first, then player and
                     rules if info stays silent; takes MaxPlayers as slots (repeatable)
  --auto             write the best scene class/priority that still fits the
                     measured uplink into basic.cfg (default: advice only)
  --calibrate        remember this box as the reference point for the hardware
                     estimate; pair with --players/--ai-cap of what it really holds
  --ai-cap N         your ffa_evo_allunitmax on the reference box (calibration)
  --seconds N        speed test window, s                      default 8
  --samples N        RTT samples per address                   default 12
  --watch [M]        not a one shot run: all-day recorder. every --every
                     seconds take NIC bytes, server process CPU/RAM and the
                     A2S player count; print the summary after M minutes.  default 1440
                     M must be a number: addresses only go after --a2s, as in
                     node netbench.js --watch 1440 --a2s 127.0.0.1:2302
                     --a2s 127.0.0.1:2303 ; for a day with addresses it is
                     simpler to run netbench_watch.cmd, which asks every port
                     and the port above it
  --every S          sampling interval for --watch, s           default 30
  --report           do not sample: rebuild the summary from watch\\samples.csv
                     the line and the model point (world/prio/slots/vd) the
                     summary compares against come from out\\report.json of the
                     one shot run unless given here; the slot count of the
                     summary always comes from the live answers of the day
  --out DIR          where basic.cfg and report.json go         default .
  --set Key=Value    manual override of any model key
  --lang ru|en       language OF THE SCREEN: old consoles (win7/2008) cannot
                     draw russian labels, that is what --lang en is for
  --tee FILE         append the russian text of every line to FILE, whatever
                     --lang says - the files stay russian
  --no-comments --no-units --no-hw --no-net
`;

function usage() {
	// --lang может стоять и ПОСЛЕ ошибочного флага, а подсказку печатаем именно
	// в момент ошибки: язык берём из всей строки, иначе на win7/2008 русский
	// блок выйдет квадратиками там, где человек его и не просил
	const li = process.argv.lastIndexOf('--lang');
	if (li >= 0 && process.argv[li + 1] === 'en') SCREEN_LANG = 'en';
	console.log(SCREEN_LANG === 'en' ? USAGE_EN : USAGE_RU);
}

// ---------------------------------------------------------------- hardware

function readHw() {
	const ps1 = path.join(__dirname, 'hw.ps1');
	const info = { source: 'node' };
	info.cpu_model = os.cpus()[0] ? os.cpus()[0].model : '';
	info.os_platform = os.platform() + ' ' + os.release() + ' ' + os.arch();
	info.node = process.version;
	// linux: powershell там нет и быть не должен, а те же ключи берутся из
	// /proc и /sys (nixstat.js). ветка проверяется на windows фикстурой через
	// NETBENCH_NIX_ROOT, и источник тогда подписан корнем дерева
	if (NIX.isLinux()) {
		Object.assign(info, NIX.hwInfo({}));
		return info;
	}
	if (!fs.existsSync(ps1)) return info;
	const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', timeout: 60000 });
	if (r.status !== 0 || !r.stdout) { info.ps1_error = (r.stderr || 'powershell failed').split('\n')[0]; return info; }
	const kv = {};
	for (const line of (r.stdout || '').replace(/^/, '').split(/\r?\n/)) {
		const i = line.indexOf('=');
		if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	info.source = 'powershell';
	info.cpu_model = kv.cpu_name || info.cpu_model;
	info.cpu_cores = kv.cpu_cores;
	info.cpu_threads = kv.cpu_threads;
	info.cpu_max_mhz = kv.cpu_max_mhz;
	info.l3_kb = kv.l3_kb;
	info.ram_bytes = kv.ram_bytes;
	info.os_caption = kv.os_caption;
	info.os_build = kv.os_build;
	info.gpu_names = kv.gpu_names;
	info.gpu_count = kv.gpu_count;
	info.nics = kv.nics;
	info.power_plan = kv.power_plan;
	info.machine = (kv.manuf + ' ' + kv.model).trim();
	return info;
}

// относительный индекс одного ядра: arma-сервер живёт на одном-двух потоках,
// поэтому общий core count про фпс не говорит почти ничего
function singleCoreIndex(msBudget = 120) {
	const work = (n) => {
		let a = 1, b = 1, s = 0;
		for (let i = 0; i < n; i++) { a = (a * 31 + i) % 1000003; b = (b ^ (a << 3)) % 999983; s += Math.sqrt(a + b); }
		return s;
	};
	let n = 200000, best = 0;
	const t0 = Date.now();
	for (;;) {
		const a = process.hrtime.bigint();
		work(n);
		const dt = Number(process.hrtime.bigint() - a) / 1e6;
		best = Math.max(best, n / (dt / 1000));
		if (Date.now() - t0 > msBudget) break;
		n = Math.round(n * Math.max(1.5, (100 / Math.max(dt, 0.1))));
	}
	return Math.round(best / 1e6); // млн итераций/с
}

// ---------------------------------------------------------------- network

function tcpRtt(host, port, timeout = 2000) {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		const sock = net.connect({ host, port });
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			const ms = Number(process.hrtime.bigint() - t0) / 1e6;
			sock.destroy();
			resolve(ok ? ms : null);
		};
		sock.setTimeout(timeout);
		sock.once('connect', () => finish(true));
		sock.once('timeout', () => finish(false));
		sock.once('error', () => finish(false));
	});
}

async function latencyTest(targets, samples) {
	const out = [];
	for (const t of targets) {
		const [host, portStr] = t.split(':');
		const port = +(portStr || 443);
		const ms = [];
		let lost = 0;
		for (let i = 0; i < samples; i++) {
			const r = await tcpRtt(host, port);
			if (r == null) lost++; else ms.push(r);
			await new Promise((r2) => setTimeout(r2, 60));
		}
		if (!ms.length) { out.push({ target: t, ok: false, lost, samples }); continue; }
		ms.sort((a, b) => a - b);
		let jitter = 0;
		for (let i = 1; i < ms.length; i++) jitter += Math.abs(ms[i] - ms[i - 1]);
		jitter /= Math.max(1, ms.length - 1);
		out.push({
			target: t, ok: true, min: ms[0], p50: ms[Math.floor(ms.length / 2)],
			p90: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))], max: ms[ms.length - 1],
			jitter, lost, samples,
		});
	}
	return out;
}

// переиспользуем сокет: на мелком куске (см. лесенку ниже) handshake на каждый
// запрос съедал бы треть результата
const DOWN_AGENT = new https.Agent({ keepAlive: true, maxSockets: 1 });

// секунды считаются ОТ ПЕРВОГО БАЙТА ДО ПОСЛЕДНЕГО. старый код делил байты на
// всё время запроса, включая handshake и паузы между раундами, поэтому на
// быстром канале цифра была ниже настоящей, а на медленном - наоборот
function httpGetBytes(url, seconds) {
	return new Promise((resolve, reject) => {
		const t0 = process.hrtime.bigint();
		const el = () => Number(process.hrtime.bigint() - t0) / 1e9;
		let total = 0, serr = null, settled = false;
		let hard = null;
		let tFirst = null, tLast = t0;
		// поток идёт - считаем transfer; handshake и пауза до первого байта -
		// это setup, он в скорость не входит
		const span = () => tFirst === null ? 0 : Number(tLast - tFirst) / 1e9;
		const setup = () => tFirst === null ? el() : Number(tFirst - t0) / 1e9;
		// у keep-alive ответа на node 12 (win7-сборка) 'close' не приходит вовсе:
		// без 'end' промис повис бы, а процесс молча вышел бы с кодом 0
		const finish = () => {
			if (settled) return;
			settled = true;
			if (hard) clearTimeout(hard);
			resolve({ bytes: total, seconds: span(), setup: setup(), err: serr });
		};
		const fail = (e) => { if (!settled) { settled = true; if (hard) clearTimeout(hard); reject(e); } };
		const req = https.get(url, { timeout: 8000, headers: UA, agent: DOWN_AGENT }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				// редирект: окно считает уже внутренний запрос, а наш таймер
				// обязан уйти, иначе он продержит процесс ещё 3 секунды
				if (settled) return;
				settled = true;
				if (hard) clearTimeout(hard);
				return resolve(httpGetBytes(res.headers.location, seconds));
			}
			if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
			res.on('data', (c) => {
				const now = process.hrtime.bigint();
				if (tFirst === null) tFirst = now;
				tLast = now;
				total += c.length;
				if (span() >= seconds) { res.destroy(); finish(); }
			});
			// обрыв посередине потока - это не «столько и скачали»: считаем то,
			// что пришло, но причину отдаём наверх
			res.on('error', (e) => { serr = e.message; finish(); });
			res.on('end', finish);
			res.on('close', finish);
		});
		// жёсткий потолок: поток встал после первого байта - 'data' больше не
		// придёт и сам себе цикл остановки не устроит
		hard = setTimeout(() => { req.destroy(); serr = serr || 'stream stalled'; finish(); }, Math.round((seconds + 3) * 1000));
		req.on('error', fail);
		req.on('timeout', () => { req.destroy(); fail(new Error('no data for 8 s')); });
	});
}

// 25 MB на гигабитном канале кончаются за доли секунды, поэтому окно
// добиваем несколькими последовательными запросами. крупные размеры cdn
// режет 4xx, а на части прокси они просто не отвечают: при пустом ответе
// пробуем меньший кусок, пока что-нибудь не польётся
const DOWN_SIZES = [DOWN_MAX, 10000000, 1000000];

async function downloadRounds(seconds, size) {
	const t0 = Date.now();
	let bytes = 0, rounds = 0, err = null, transfer = 0, setup = 0;
	while ((Date.now() - t0) / 1000 < seconds - 0.4) {
		// раунду отдаём столько, сколько осталось в окне, а не всё окно:
		// старый код ставил внутренний стоп по полной секунде, и раунд,
		// начатый на 8-й секунде, добивал ещё 8 - отсюда «100 MB за 9.4 с»
		// при окне в 8
		const left = Math.max(0.5, seconds - (Date.now() - t0) / 1000);
		try {
			const r = await httpGetBytes(DOWN_URL + size, left);
			if (r.bytes > 0) { bytes += r.bytes; rounds++; transfer += r.seconds; setup += r.setup; }
			if (r.bytes === 0 || r.err) { err = r.err || 'empty answer'; break; }
		} catch (e) { err = e.message; break; }
	}
	return { bytes, rounds, transfer, setup, err };
}

async function downloadTest(seconds) {
	await httpGetBytes(DOWN_URL + '262144', 2).catch(() => {});   // прогрев TLS
	const refused = [];
	let last = null;
	for (const size of DOWN_SIZES) {
		const r = await downloadRounds(seconds, size);
		last = {
			size: size, bytes: r.bytes, rounds: r.rounds,
			// делить всегда на время потока. idle = handshake + пауза до
			// первого байта: он в Mbit/s не входит, но показан, чтобы
			// «8 с окна» и «6.9 с счётчика» не выглядели подтасовкой
			seconds: Math.max(0.3, r.transfer), idle: r.setup, err: r.err
		};
		if (r.bytes > 0) break;     // цифры считаются по фактически пришедшим байтам
		refused.push(M.fmtBytes(size) + ' ' + (r.err || 'no bytes'));
	}
	last.refused = refused;
	return { ...last, mbit: (last.bytes * 8) / last.seconds / 1e6 };
}

function uploadOnce(chunk, ms = 15000) {
	return new Promise((resolve, reject) => {
		const u = new URL(UP_URL);
		let settled = false;
		// на node 12 аргумент-ошибка у req.destroy() игнорируется, а 'error' от
		// ответа вообще не слушался: промис вис и процесс выходил молча с кодом 0
		const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(chunk.length); };
		const req = https.request({
			hostname: u.hostname, path: u.pathname, method: 'POST', timeout: ms,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length, ...UA },
		}, (res) => {
			res.resume();
			res.on('end', () => done(res.statusCode < 400 ? null : new Error('HTTP ' + res.statusCode)));
			res.on('error', done);
		});
		req.on('error', done);
		req.on('timeout', () => { req.destroy(); done(new Error('timeout')); });
		req.end(chunk);
	});
}

async function uploadTest(seconds, sizeMb = 4) {
	const chunk = Buffer.allocUnsafe(sizeMb * 1e6);
	for (let i = 0; i < chunk.length; i += 4096) chunk[i] = (i * 2654435761) & 255;   // не нули, чтобы не сжималось
	const t0 = Date.now();
	let bytes = 0, rounds = 0, err = null;
	while ((Date.now() - t0) / 1000 < seconds) {
		try {
			bytes += await uploadOnce(chunk);
			rounds++;
		} catch (e) { err = e.message; break; }
	}
	const el = Math.max(0.3, (Date.now() - t0) / 1000);
	return { mbit: (bytes * 8) / el / 1e6, bytes, seconds: el, rounds, size: chunk.length, err };
}

async function dnsTest() {
	const t0 = process.hrtime.bigint();
	try { await dns.lookup('speed.cloudflare.com'); } catch (e) { return { ok: false, err: e.message }; }
	return { ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

// ---------------------------------------------------------------- report

const pad = (s, n) => String(s).padEnd(n);
const gb = (b) => (b / 1073741824).toFixed(1) + ' GB';

// ноль байт - это не «0.0 Mbit/s», а упавший замер: печатаем причину
function speedLine(label, r, thrown, detail) {
	if (!r) return pad(label, 14) + 'FAILED: ' + (thrown || 'not measured');
	if (!r.bytes) return pad(label, 14) + 'FAILED: ' + (r.err || 'no bytes moved');
	return pad(label, 14) + r.mbit.toFixed(1) + ' Mbit/s  (' + detail(r) + (r.err ? ', ' + r.err : '') + ')';
}

function printReport(hw, core, net, inp, rec, v, alerts) {
	console.log('');
	console.log('=== HARDWARE ' + '='.repeat(52));
	console.log(pad('machine', 14) + (hw.machine || 'n/a') + (hw.cpu_model ? '  |  ' + hw.cpu_model.trim() : ''));
	console.log(pad('cpu', 14) + (hw.cpu_cores || '?') + ' cores / ' + (hw.cpu_threads || '?') + ' threads, ' + (hw.cpu_max_mhz || '?') + ' MHz, L3 ' + (hw.l3_kb ? Math.round(hw.l3_kb / 1024) + ' MB' : 'n/a'));
	console.log(pad('single core', 14) + core + ' M iter/s  (relative index)');
	console.log(pad('ram', 14) + (hw.ram_bytes ? gb(hw.ram_bytes) : 'n/a') + '  (node sees ' + gb(os.totalmem()) + ')');
	console.log(pad('gpu', 14) + (hw.gpu_names || 'n/a'));
	console.log(pad('os', 14) + (hw.os_caption || hw.os_platform) + (hw.os_build ? ' build ' + hw.os_build : ''));
	console.log(pad('power plan', 14) + (hw.power_plan || 'n/a'));
	console.log(pad('nics', 14) + (hw.nics || 'n/a'));
	console.log(pad('source', 14) + hw.source + (hw.ps1_error ? '  (ps1: ' + hw.ps1_error + ')' : ''));

	if (net) {
		console.log('');
		console.log('=== LINE ' + '='.repeat(56));
		if (net.dns && net.dns.ok) console.log(pad('dns', 14) + net.dns.ms.toFixed(1) + ' ms');
		for (const l of net.latency) {
			if (!l.ok) { console.log(pad(l.target, 30) + 'no answer (' + l.lost + '/' + l.samples + ' failed)'); continue; }
			console.log(pad(l.target, 30) + 'min ' + l.min.toFixed(1) + '  p50 ' + l.p50.toFixed(1) + '  p90 ' + l.p90.toFixed(1) +
				'  max ' + l.max.toFixed(1) + ' ms  jitter ' + l.jitter.toFixed(1) + '  loss ' + (100 * l.lost / l.samples).toFixed(0) + '%');
		}
		if (net.speed_skipped) {
			console.log(pad('speed', 14) + 'not measured: ' + net.speed_skipped);
			console.log(pad('', 14) + 'drop the number to measure the line instead');
		} else {
			console.log(speedLine('download', net.download, net.download_error,
				(d) => M.fmtBytes(d.bytes) + ' in ' + d.seconds.toFixed(1) + ' s of transfer, ' +
					d.rounds + ' x ' + M.fmtBytes(d.size) +
					// idle = handshake и ожидание первого байта: их в скорость мы
					// не считаем, поэтому показываем их отдельно, а не прячем
					(d.idle >= 0.3 ? ', ' + d.idle.toFixed(1) + ' s idle' : '') +
					(d.refused && d.refused.length ? ', refused: ' + d.refused.join('; ') : ''))
			);
			console.log(speedLine('upload', net.upload, net.upload_error,
				(d) => M.fmtBytes(d.bytes) + ' in ' + d.seconds.toFixed(1) + ' s, ' + d.rounds + ' posts')
			);
		}
	}

	console.log('');
	console.log('=== MODEL INPUT ' + '='.repeat(50));
	console.log(pad('players', 14) + inp.players + (inp.playersSource ? '  (' + inp.playersSource + ')' : ''));
	console.log(pad('uplink', 14) + inp.uplink + ' Mbit/s' + (inp.uplinkSource ? '  (' + inp.uplinkSource + ')' : ''));
	console.log(pad('view dist', 14) + inp.vd + ' m');
	console.log(pad('world', 14) + M.WORLD[inp.world].label + ', ' + M.fmtBits(rec.rate) + ' per player');
	console.log(pad('priority', 14) + M.PRIO[inp.prio].label);
	console.log(pad('need', 14) + M.fmtBits(rec.need) + '   usable (70% up): ' + M.fmtBits(rec.usable));
	console.log('');
	console.log('=== basic.cfg ' + '='.repeat(51));
	for (const k of M.KEYS) {
		if (v[k.key] == null) continue;
		const human = k.unitBits ? M.fmtBits(v[k.key]) : (k.type === 'float' ? (+v[k.key].toPrecision(6)) : v[k.key]);
		console.log(pad(k.key, 24) + pad(human, 18) + (rec.why[k.key] || ''));
	}
	console.log(pad('anim reach', 24) + M.fmtM(M.animReach(v.MinErrorToSend)) + '  (zoomed ' + M.fmtM(M.animReach(v.MinErrorToSend, M.REF_ZOOM)) + ')');
	if (alerts.length) {
		console.log('');
		console.log('=== ALERTS ' + '='.repeat(52));
		for (const a of alerts) console.log('! ' + a);
	}
}

function extraAlerts(net, hw) {
	const out = [];
	if ((hw.nics || '').match(/wi-?fi|wireless|802\.11|ax\d/i)) {
		out.push('Active NIC looks wireless: a dedicated server on wi-fi will show as jitter and loss, not as a bandwidth number.');
	}
	if (!net) return out;
	const good = net.latency.filter((l) => l.ok);
	const worstLoss = Math.max(0, ...good.map((l) => l.lost / l.samples));
	const worstJitter = Math.max(0, ...good.map((l) => l.jitter));
	if (worstLoss > 0.2) out.push('Loss ' + (worstLoss * 100).toFixed(0) + '% on the path: MaxSizeNonguaranteed 256 already keeps position packets small; if it is still rough, drop maxPacketSize to 1200 and test.');
	if (worstJitter > 40) out.push('Jitter ' + worstJitter.toFixed(0) + ' ms: the line is shared or wi-fi-shaped, expect bursts the packet budget cannot smooth out.');
	// свои --target это обычно и есть игровой сервер: порты 443/53 только для общей линии
	const own = good.filter((l) => !/:443$|:53$/.test(l.target));
	for (const l of own) if (l.p50 > 100) {
		out.push('RTT to your own target ' + l.target + ' is ' + l.p50.toFixed(0) + ' ms: MinErrorToSend will not fix latency, view distance and client smoothing will.');
	}
	const down = net.download && net.download.bytes ? net.download : null;
	const up = net.upload && net.upload.bytes ? net.upload : null;
	if (!down && net.download) {
		out.push('Download probe failed (' + (net.download.err || 'no bytes') + '): the down/up comparison is skipped. basic.cfg itself is built from upload, so it stays valid.');
	} else if (down && up && down.mbit / Math.max(0.1, up.mbit) > 6) {
		out.push('Strongly asymmetric line (down ' + down.mbit.toFixed(0) + ' / up ' + up.mbit.toFixed(1) + ' Mbit/s). The server only ships on upload, so the upload number is the one that matters.');
	}
	return out;
}

// ---------------------------------------------------------------- sizing

function printSizing(rows, best, inp, a2s, cal, bound, autoApplied, localUdp) {
	console.log('');
	console.log('=== LIVE SERVERS ' + '='.repeat(46));
	if (!a2s.length) console.log('  (no --a2s given: run it against a live server to take its slot count and map)');
	for (const q of a2s) {
		if (!q.ok) {
			console.log(pad(q.target, 24) + 'no answer: ' + q.err);
			// ключи правил = то, что должен назвать следующий лог: по спецификации
			// сообщества слоты arma 3 лежат в a2s_rules, а настоящий ключ ещё не видан
			if (q.rules && q.rules.length) {
				console.log('  the rules answer carried these key/value pairs:');
				for (const p of q.rules.slice(0, 24)) console.log('    ' + p.name + ' = ' + p.value);
			}
			continue;
		}
		const shown = String(q.name || '').slice(0, 40) || String(q.mission || '').slice(0, 40) || '(no name)';
		// «players, map» - маркер, на который батник опознаёт успешный ответ
		console.log(pad(q.target, 24) + pad(shown, 42) + (q.players || 0) + '/' + (q.maxPlayers || 0) +
			' players, map ' + (q.map || q.mission || '?') + ', from ' + (q.via || 'info') + ', ' + q.rttMs + ' ms');
	}
	if (localUdp) {
		const range = localUdp.base - 1 + '-' + (localUdp.base + 4);
		if (localUdp.answered) {
			console.log('  the answer came from ' + localUdp.answered + ': the server binds that address, not loopback.');
			console.log('  pass it instead of 127.0.0.1, like: netbench_run.cmd ' + localUdp.answered + ' ' + inp.players + ' 150');
		} else if (localUdp.listeners.length) {
			console.log('  udp listeners on this machine in ' + range + ': ' +
				localUdp.listeners.map((l) => l.addrs.join('+') + ':' + l.port).join(', ') +
				' - the server is here, the query just did not answer');
			console.log('  the slot count therefore came from your argument, not from the server');
		} else {
			console.log('  nothing on this machine listens on udp ' + range + ': the server is not running here.');
			console.log('  pass its real address instead of 127.0.0.1, like: netbench_run.cmd <ip>:<game port> ' + inp.players + ' 150');
		}
	}

	console.log('');
	console.log('=== FIT MATRIX (твоя модель, uplink ' + inp.uplink + ' Mbit/s' + (/fallback/.test(inp.uplinkSource || '') ? ', LINE NOT MEASURED' : '') + ', ' + inp.players + ' slots) ' + '='.repeat(4));
	console.log(pad('scene + priority', 26) + pad('need', 14) + pad('cost/player', 14) + pad('anim reach', 13) + pad('slots cap', 10) + 'fits');
	for (const r of rows) {
		console.log(pad(r.label, 26) + pad(M.fmtBits(r.need), 14) + pad(M.fmtBits(r.rate), 14) +
			pad(M.fmtM(r.reach), 13) + pad(r.slotsCap, 10) +
			(r.fits ? 'yes' : 'no: ' + (!r.bandwidthOk ? 'need > 70% uplink' : 'under ' + M.fmtBits(S.PER_PLAYER_FLOOR) + '/player')));
	}
	console.log('');
	if (best) console.log('best that fits: ' + best.label + '  (' + M.fmtBits(best.rate) + '/player, cap ' + best.slotsCap + ' slots)');
	else console.log('nothing fits this uplink at ' + inp.players + ' slots - lower slots or take "Save traffic"');
	if (autoApplied) console.log('  -> applied to basic.cfg by --auto');
	else if (best && (best.world !== inp.world || best.prio !== inp.prio)) console.log('  -> current file uses ' + M.WORLD[inp.world].label + ', ' + M.PRIO[inp.prio].label + '; --auto would switch it');

	console.log('');
	console.log('=== CPU / RAM ' + '='.repeat(52));
	console.log('  BI does not publish players-per-core or RAM-per-player; the wiki only');
	console.log('  says a headless client takes the AI calculation off the server instance.');
	if (!cal) {
		console.log('  no calibration point yet: this box has no out\\calibration.json. the runbook');
		console.log('  writes it in step 3 when it gets the two numbers this box already holds,');
		console.log('  like: netbench_run.cmd 127.0.0.1:2402 40 150   (40 slots, unit cap 150)');
		console.log('  by hand: netbench.js --calibrate --players 40 --ai-cap 150. then other');
		console.log('  boxes get an upper bound from this one.');
	} else {
		console.log(pad('reference', 14) + cal.players + ' slots' + (cal.aiCap ? ', ffa_evo_allunitmax ' + cal.aiCap : '') +
			' at ' + cal.singleCoreMIterS + ' M iter/s, ' + cal.ramGB + ' GB RAM  (' + cal.at.slice(0, 10) + (cal.machine ? ', ' + cal.machine : '') + ')');
		if (bound) {
			if (Math.abs(bound.ratio - 1) < 0.05) {
				console.log(pad('this box', 14) + 'same single-core class as the reference, so the same ~' + cal.players + ' slots' +
					(bound.aiCap ? ' and AI cap ~' + bound.aiCap : '') + '  (index ratio ' + bound.ratio.toFixed(2) + ')');
			} else {
				console.log(pad('this box', 14) + 'not better than ~' + bound.slots + ' slots at the same scene' +
					(bound.aiCap ? ', AI cap ~' + bound.aiCap : '') + '  (linear, ratio ' + bound.ratio.toFixed(2) + ')');
			}
			if (cal.ramGB && inp.hwRamGB && inp.hwRamGB < cal.ramGB) console.log('  RAM is lower than the reference box: check the mission footprint before trusting the number.');
		}
	}
}

// ---------------------------------------------------------------- main

(async () => {
	const a = parseArgs(process.argv.slice(2));
	// язык экрана и русский дубль в файл - до первой напечатанной строки
	I.configure({ lang: a.lang, tee: a.tee });
	process.on('exit', I.done);

	// watch: весь день снимать показания и в конце выдать вывод по фактическим цифрам
	if (a.watch != null || a.report) {
		const W = require('./watch.js');
		const outDir = path.resolve(a.out);
		// одиночный прогон уже лежит в out\: его input - это то, что модель считала
		// для этой коробки (--auto выбрал heavy + smooth). суточная сводка сверяет
		// измеренное именно с ней, поэтому без этого шапка сравнивала бы с дефолтом
		// heavy + balanced и ratio выходил бы неверным
		let rep = null;
		try { rep = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')); } catch (e) {}
		const in0 = (rep && rep.input) || {};
		const inherit = (key, given, dflt) => (given ? dflt : (in0[key] != null ? in0[key] : dflt));
		const m = {
			players: inherit('players', a.playersGiven, a.players),
			vd: inherit('vd', a.vdGiven, a.vd),
			world: inherit('world', a.worldGiven, a.world),
			prio: inherit('prio', a.prioGiven, a.prio),
		};
		if (!a.worldGiven && !a.prioGiven && in0.world && in0.prio) {
			console.log('model point taken from out\\report.json: ' + in0.world + ' + ' + in0.prio + ', ' + m.players + ' slots, view ' + m.vd + ' m (--world/--prio override it)');
		}
		const rec0 = M.recommend({ players: m.players, vd: m.vd, world: m.world, prio: m.prio, uplink: a.uplink || 100 });
		const targets = a.a2s.length ? a.a2s : ['127.0.0.1:2302'];
		if (!a.a2s.length) console.log('no --a2s given: watching 127.0.0.1:2302 only (pass --a2s for every server on the box)');
		const o = {
			minutes: a.watch == null ? 1440 : a.watch, every: a.every, targets,
			out: outDir, baseValues: rec0.v,
			inp: { players: m.players, vd: m.vd, world: m.world, prio: m.prio, uplink: a.uplink || 100, uplinkSource: null },
			world: m.world, prio: m.prio, modelRate: rec0.rate, minBw: rec0.v.MinBandwidth,
			uplink: a.uplink, slots: a.playersGiven ? a.players : null,
		};
		// без --uplink линия всё равно нужна (сравнить нужду с каналом): берём
		// измерение из шага 1, если он тут уже был
		let uplinkFrom = null;
		if (o.uplink == null && rep) {
			const rp = path.join(outDir, 'report.json');
			const mbit = rep.net && rep.net.upload ? rep.net.upload.mbit : null;
			if (mbit > 0) {
				o.uplink = +mbit.toFixed(1);
				uplinkFrom = 'measured upload from step 1';
			} else if (rep.input && rep.input.uplink > 0 && !/fallback/.test(rep.input.uplinkSource || '')) {
				// шаг 1 канал не грузил: цифра пришла из его --uplink, и для
				// суточного наблюдения это всё равно его линия, а не догадка
				o.uplink = rep.input.uplink;
				uplinkFrom = 'the number the one shot run was given';
			}
			if (o.uplink != null) console.log('uplink taken from ' + rp + ': ' + o.uplink + ' Mbit/s (' + uplinkFrom + ', --uplink overrides it)');
		}
		// линия: явный флаг, иначе измерение из шага 1, иначе допущение - и
		// basic.cfg обязан сказать, какой из трёх случаев сработал
		o.inp.uplinkSource = a.uplink != null ? '--uplink'
			: (o.uplink != null ? (uplinkFrom || 'measured upload from step 1') : 'fallback: upload not measured');
		o.inp.uplink = o.uplink == null ? 100 : o.uplink;
		if (a.report) {
			const file = path.join(o.out, 'watch', 'samples.csv');
			if (!fs.existsSync(file)) { console.error('no rows yet: ' + file); process.exit(2); }
			console.log(W.summarize(W.readCsv(file), o).text);
			return;
		}
		await W.watch(o);
		return;
	}

	const hw = a.skipHw ? { source: 'skipped' } : readHw();
	const core = singleCoreIndex();

	let net = null;
	if (!a.skipNet) {
		net = { latency: await latencyTest(a.targets, a.samples), dns: await dnsTest() };
		// переданная цифра линии = про канал уже всё известно, а download и upload
		// грузуют его суммарно секунд восемнадцать: на живом сервере это лаги
		// у игроков. поэтому с --uplink скорость не мерим вообще
		if (a.uplink != null) {
			net.speed_skipped = '--uplink ' + a.uplink + ' Mbit/s given, so the channel was not loaded';
		} else {
			try { net.download = await downloadTest(a.seconds); } catch (e) { net.download_error = e.message; }
			try { net.upload = await uploadTest(a.seconds); } catch (e) { net.upload_error = e.message; }
		}
	}

	// живые сервера: число слотов и карта берутся запросом, а не угадываются
	const a2s = [];
	for (const t of a.a2s) {
		const [host, port] = t.split(':');
		// запрос не имеет права ронять весь шаг: без catch сюда долетает
		// любая ошибка парсера и в логе не остаётся ничего
		try {
			a2s.push(await a2sQuery(host, +(port || 2302)));
		} catch (e) {
			a2s.push({ ok: false, target: t, err: 'query threw: ' + e.message });
		}
	}

	// «no UDP answer» само по себе не различает «сервера на этой машине нет» и
	// «сервер здесь, но query молчит». на локальном хосте это решает netstat:
	// rpt пишет Game Port P, Steam Query P+1, wiki добавляет P+2 мастер, P+4 BE.
	// если сокет привязан к адресу карты, а не к 0.0.0.0, запрос на 127.0.0.1
	// физически никуда не приходит - повторяем его на адресе привязки
	let localUdp = null;
	if (a2s.length && a2s.every((q) => !q.ok)) {
		const [host, portStr] = String(a.a2s[0]).split(':');
		const base = +(portStr || 2302);
		const low = String(host || '').toLowerCase();
		if (/^127\./.test(low) || low === 'localhost' || low === os.hostname().toLowerCase()) {
			const ports = [];
			for (let p = base - 1; p <= base + 4; p++) ports.push(p);
			const listeners = await udpListeners(ports);
			if (listeners) {
				localUdp = { host, base, listeners, ports: listeners.map((l) => l.port) };
				for (const ip of boundIps(listeners).slice(0, 3)) {
					for (const l of listeners) {
						if (l.addrs.indexOf(ip) < 0) continue;
						if (l.port !== base && l.port !== base + 1) continue;
						const q = await a2sQuery(ip, l.port, 1500).catch(() => null);
						if (!q || !q.ok) continue;
						a2s[0] = q;
						localUdp.answered = q.target;
						break;
					}
					if (localUdp.answered) break;
				}
			}
		}
	}

	const inp = { players: a.players, vd: a.vd, world: a.world, prio: a.prio, uplink: null, uplinkSource: null };
	// нулевой замер - это не «0 Mbit/s линия», а неудавшийся тест: он не должен
	// уезжать в модель и в батник как измеренная линия
	const up = net && net.upload;
	if (a.uplink != null) {
		inp.uplink = a.uplink; inp.uplinkSource = '--uplink';
	} else if (up && up.bytes > 0 && up.mbit >= 0.1) {
		inp.uplink = +up.mbit.toFixed(1); inp.uplinkSource = 'measured upload';
	} else {
		// почему не измерилось - прямо в строке, иначе в логе остаётся только
		// «fallback» и причина теряется между шагами
		const why = a.skipNet ? 'no line test asked for (--no-net)'
			: !net ? 'hardware only run'
			: (net.upload_error || (up && (up.err || (up.bytes ? 'under 0.1 Mbit/s, too small to build on' : 'no bytes back'))) || 'no bytes back');
		inp.uplink = 100; inp.uplinkSource = 'fallback: upload not measured, ' + why;
	}

	// слотов: живой сервер сильнее аргумента. --players введён на случай, когда
	// a2s молчит, а когда запрос ответил и назвал другое число, модель берёт его.
	// аргумент при этом остаётся в --calibrate: там он и есть «что коробка держит»
	let slotNote = null;
	const live = a2s.find((x) => x.ok && x.maxPlayers > 0);
	if (live) {
		inp.players = live.maxPlayers;
		inp.playersSource = 'A2S ' + (live.via || 'info') + ' maxPlayers from ' + live.target;
		if (a.playersGiven && a.players !== live.maxPlayers) {
			slotNote = 'Your --players ' + a.players + ' is not this server: the live query on ' + live.target +
				' answers ' + live.maxPlayers + ' slots. The fit matrix and MinBandwidth use ' + live.maxPlayers +
				'; your argument still writes the calibration point. If this server is meant to hold ' +
				a.players + ', raise maxPlayers in server.cfg and restart it.';
		}
	} else if (a.playersGiven) {
		inp.playersSource = '--players';
	}
	if (!inp.playersSource) inp.playersSource = 'default (pass --players or --a2s)';

	// твоя модель по всей сетке классов сцены x приоритет, на том же uplink
	const rows = S.fitMatrix(inp.uplink, inp.players, inp.vd);
	const best = S.pickBest(rows);
	let autoApplied = false;
	if (a.auto && best && (best.world !== inp.world || best.prio !== inp.prio)) {
		inp.world = best.world; inp.prio = best.prio;
		autoApplied = true;
	}

	const rec = M.recommend(inp);
	if (slotNote) rec.alerts.push(slotNote);
	if (autoApplied) rec.alerts.push('Scene class and priority chosen by --auto: ' + best.label + ' is the most comfortable setting that still fits in ' + inp.uplink + ' Mbit/s upload.');
	const v = { ...rec.v, ...a.set };
	// ручная переопреда не должна притворяться рекомендацией модели
	for (const k of Object.keys(a.set)) {
		if (rec.why[k] == null) continue;
		rec.why[k] = 'set by --set' + (rec.v[k] == null ? '' : ' (model wanted ' + +rec.v[k].toPrecision(6) + ')');
	}
	const alerts = rec.alerts.concat(extraAlerts(net, hw));

	const outDir = path.resolve(a.out);
	fs.mkdirSync(outDir, { recursive: true });

	// калибровка: этот бокс как опорная точка; без неё оценка железа не печатается
	let cal = null, bound = null;
	if (a.calibrate) {
		if (!a.playersGiven) { console.error('--calibrate needs --players N with what this box actually holds'); process.exit(2); }
		cal = {
			at: new Date().toISOString(),
			machine: hw.machine || os.hostname(),
			cpu: hw.cpu_model || '',
			cores: +(hw.cpu_cores || 0), threads: +(hw.cpu_threads || 0),
			ramGB: hw.ram_bytes ? Math.round(+hw.ram_bytes / 1073741824) : 0,
			singleCoreMIterS: core,
			players: a.players,
			aiCap: a.aiCap,
			map: (a2s.find((q) => q.ok) || {}).map || null,
		};
		S.saveCal(outDir, cal);
	} else {
		cal = S.loadCal(outDir);
		bound = cal ? S.cpuBound(core, cal.players, cal) : null;
	}
	inp.hwRamGB = hw.ram_bytes ? Math.round(+hw.ram_bytes / 1073741824) : null;

	const cfgPath = path.join(outDir, 'basic.cfg');
	fs.writeFileSync(cfgPath, M.generateCfg(v, inp, { comments: a.comments, units: a.units }));
	const jsonPath = path.join(outDir, 'report.json');
	const sizing = {
		playersSource: inp.playersSource,
		a2s: a2s.map((q) => (q.ok
			? { target: q.target, via: q.via || 'info', players: q.players, maxPlayers: q.maxPlayers, map: q.map, mission: q.mission, rttMs: q.rttMs }
			: { target: q.target, err: q.err, rules: q.rules, playerNames: q.playerNames })),
		udpListeners: localUdp,
		fit: rows.map(({ world, prio, label, rate, need, perPlayer, reach, maxBw, slotsCap, fits }) => ({ world, prio, label, rate, need, perPlayer, reach, maxBw, slotsCap, fits })),
		best: best && best.label,
		autoApplied,
		calibration: cal,
		cpuBound: bound,
	};
	fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), hw, singleCoreMIterS: core, net, input: inp, model: rec.v, written: v, alerts, sizing }, null, 2));

	printReport(hw, core, net, inp, rec, v, alerts);
	printSizing(rows, best, inp, a2s, cal, bound, autoApplied, localUdp);
	if (a.calibrate) console.log('\ncalibration written: ' + S.calPath(outDir));
	console.log('');
	console.log('written: ' + cfgPath);
	console.log('written: ' + jsonPath);
	console.log('put basic.cfg next to the server exe and start it with -cfg=basic.cfg');
})().catch((e) => { console.error('netbench failed: ' + e.stack); process.exit(1); });

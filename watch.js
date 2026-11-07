// netbench watch: снимать показания весь день и в конце выдать вывод по фактическим цифрам
// ничего в сервер не пишется: только счётчики ос + a2s-запрос снаружи
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const M = require('./model.js');
const NIX = require('./nixstat.js');
const { a2sQuery } = require('./a2s.js');

const CSV_HEADER = ['ts', 'epoch', 'players', 'slots', 'out_bps', 'in_bps', 'kbit_per_player', 'cpu_pct_core', 'ram_mb', 'servers', 'src'];
const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);
const mbits = (bps) => (bps == null || isNaN(bps) ? '-' : (bps / 1e6).toFixed(1) + ' Mbit/s');
const q = (arr, p) => {
	if (!arr.length) return null;
	const s = arr.slice().sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function sh(cmd, args, timeout) {
	return new Promise((resolve) => {
		execFile(cmd, args, { encoding: 'utf8', timeout: timeout || 20000, windowsHide: true }, (err, out) => {
			resolve(err || !out ? null : out);
		});
	});
}

// основной источник: счётчики адаптера + процесс сервера.
// netstats.ps1 печатает ключ=значение строками - не json, потому что json там
// не соберётся на powershell 2.0 (win7 / server 2008)
async function fromPowerShell() {
	const raw = await sh('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'netstats.ps1')]);
	if (!raw) return null;
	const res = { src: null, sent: 0, recv: 0, procs: [] };
	let nic = 'none';
	for (const line of raw.split(/\r?\n/)) {
		const i = line.indexOf('=');
		if (i < 0) continue;
		const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
		if (k === 'nic') nic = v;
		else if (k === 'sent') res.sent = +v || 0;
		else if (k === 'recv') res.recv = +v || 0;
		else if (k === 'proc') {
			const f = v.split('|');
			if (f.length < 4) continue;
			res.procs.push({ name: f[0], pid: +f[1], cpu: +f[2], ws: +f[3], ports: (f[4] || '').trim() });
		}
	}
	if (!res.procs.length && nic === 'none' && !res.sent && !res.recv) return null;
	res.src = nic === 'none' ? 'proc-only' : 'adapter-stats';
	return res;
}

// запасной вариант для бокса без get-netadapter (win7/2008): netstat -e.
// строка с байтами берётся как та, где числа на порядки больше остальных:
// метки в netstat локализованы, а пакеты никогда не догоняют байты
async function fromNetstat() {
	const raw = await sh('netstat', ['-e']);
	if (!raw) return null;
	let best = null;
	for (const line of raw.split(/\r?\n/)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 3 || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[2])) continue;
		const pair = [+f[1], +f[2]];
		if (!best || pair[0] + pair[1] > best[0] + best[1]) best = pair;
	}
	if (!best) return null;
	return { src: 'netstat-e', sent: best[1], recv: best[0], procs: [] };
}

// процессы arma: серверный приоритетнее; если имени server нет - берём всё
// найденное, но источник это честно покажет
function serverProcs(procs) {
	const list = procs || [];
	const srv = list.filter((p) => /server/i.test(p.name));
	// none получает метку: процесса сервера нет в списке (сервер не запущен) или
	// списка нет вовсе (источник счётчиков не отдал процессы) - это разные случаи
	return { procs: srv, none: srv.length ? null : (list.length ? 'no-server-proc' : 'no-proc-list') };
}

async function readStats() {
	// linux: те же ключи из /proc и /sys, и тот же смысл меток источника,
	// поэтому rowOf() ниже ничего про новую ос не знает
	if (NIX.isLinux()) return NIX.netCounters({});
	const ps = await fromPowerShell();
	if (ps && ps.sent > 0) return ps;
	const ns = await fromNetstat();
	if (!ns) return ps;
	if (!ps) return ns;
	return { src: ps.src + '+netstat-e', sent: ns.sent, recv: ns.recv, procs: ps.procs };
}

async function sample(targets) {
	const st = await readStats();
	const servers = [];
	for (const t of targets) {
		const p = t.split(':');
		servers.push(await a2sQuery(p[0], +(p[1] || 2302)));
	}
	return { ts: Date.now(), st, servers };
}

function cpuSum(procs) { return procs.reduce((n, p) => n + (+p.cpu || 0), 0); }
function ramSum(procs) { return procs.reduce((n, p) => n + (+p.ws || 0), 0); }

function rowOf(cur, prev, procs, prevCpu, noProc) {
	const ok = cur.servers.filter((s) => s.ok);
	const players = ok.reduce((n, s) => n + (+s.players || 0), 0);
	const r = {
		ts: new Date(cur.ts).toISOString(), epoch: cur.ts,
		players, slots: ok.reduce((n, s) => n + (+s.maxPlayers || 0), 0),
		out_bps: null, in_bps: null, kbit_per_player: null, cpu_pct_core: null,
		// серверного процесса нет в списке = сервер в этот момент не работал
		// (рестарт, упавшая консоль). сумма всех процессов коробки - это НЕ
		// процесс сервера, поэтому строка остаётся пустой, а не с враньём
		ram_mb: noProc ? null : +(ramSum(procs) / 1048576).toFixed(0),
		servers: ok.length ? ok.map((s) => s.target.split(':').pop() + ':' + s.players + '/' + s.maxPlayers).join(' ') : 'no answer',
		src: (cur.st ? cur.st.src : 'stats failed') + (noProc ? '+' + noProc : ''),
	};
	if (!prev || !cur.st || !prev.st || players < 1) return r;
	const dt = (cur.ts - prev.ts) / 1000;
	if (dt <= 0) return r;
	// счётчики из разных источников несопоставимы (netstat считает стек целиком,
	// адаптер - одну карту): разницу берём только когда источник не сменился
	if (cur.st.src === prev.st.src) {
		const dOut = cur.st.sent - prev.st.sent, dIn = cur.st.recv - prev.st.recv;
		if (dOut >= 0) r.out_bps = Math.round(dOut * 8 / dt);
		if (dIn >= 0) r.in_bps = Math.round(dIn * 8 / dt);
		if (r.out_bps != null) r.kbit_per_player = +(r.out_bps / players / 1000).toFixed(0);
	}
	if (noProc) return r;
	const cpu = cpuSum(procs);
	if (prevCpu != null && cpu >= prevCpu) r.cpu_pct_core = +(100 * (cpu - prevCpu) / dt).toFixed(0);
	return r;
}

function fmtRow(r) {
	return pad(r.ts.slice(11, 19), 10) + pad('players ' + r.players + '/' + r.slots, 16) +
		pad('out ' + mbits(r.out_bps), 17) + pad(r.kbit_per_player + ' kbit/player', 18) +
		(r.cpu_pct_core == null ? pad('', 15) : pad('cpu ' + r.cpu_pct_core + '% core', 15)) +
		(r.ram_mb ? 'ram ' + (r.ram_mb / 1024).toFixed(1) + ' GB ' : '') + r.servers;
}

function csvLine(r) {
	return CSV_HEADER.map((k) => (r[k] == null ? '' : String(r[k]).replace(/[",\r\n]/g, ' '))).join(',');
}

function readCsv(file) {
	const rows = [];
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
		if (!line.trim()) continue;
		const f = line.split(',');
		const r = {};
		CSV_HEADER.forEach((k, i) => { r[k] = (f[i] || '').trim(); });
		for (const k of ['players', 'slots', 'out_bps', 'in_bps', 'kbit_per_player', 'cpu_pct_core', 'ram_mb']) {
			r[k] = r[k] === '' ? null : +r[k];
		}
		rows.push(r);
	}
	return rows;
}

const BUCKETS = [[1, 4], [5, 9], [10, 19], [20, 29], [30, 39], [40, 999]];

function summarize(rows, inp) {
	const out = ['=== WATCH SUMMARY ' + '='.repeat(52)];
	if (!rows.length) {
		out.push('  no samples yet');
		return { text: out.join('\n'), verdict: null };
	}
	out.push('samples       ' + rows.length + '   ' + rows[0].ts.slice(0, 19).replace('T', ' ') + '  ..  ' + rows[rows.length - 1].ts.slice(11, 19));
	out.push('sources       ' + Array.from(new Set(rows.map((r) => r.src))).join(', '));
	out.push('idle          ' + rows.filter((r) => !r.players).length + ' samples with no player on the servers');
	const noProc = rows.filter((r) => /no-server-proc|no-proc-list/.test(r.src || ''));
	if (noProc.length) out.push('no server     ' + noProc.length +
		' samples with no server process on the box (restart or a crash): cpu and ram stay empty in those rows, the adapter bytes still count');

	const good = rows.filter((r) => r.kbit_per_player != null && r.players >= 1);
	if (!good.length) {
		out.push('');
		out.push('  ни в одном сэмпле на серверах не было игрока - мерить было нечего.');
		return { text: out.join('\n'), verdict: null };
	}
	out.push('players seen  1..' + Math.max(...good.map((r) => r.players)) + '  median ' + q(good.map((r) => r.players), 0.5));
	out.push('');
	out.push(pad('players', 12) + pad('samples', 9) + pad('out median', 15) + pad('out p90', 14) + pad('kbit/player', 13) + pad('cpu % core', 12) + 'ram GB');
	for (const b of BUCKETS) {
		const lo = b[0], hi = b[1];
		const g = good.filter((r) => r.players >= lo && r.players <= hi);
		if (!g.length) continue;
		const cpu = g.map((r) => r.cpu_pct_core).filter((x) => x != null);
		const ram = g.map((r) => r.ram_mb).filter((x) => x != null);
		out.push(pad(hi > 900 ? lo + '+' : lo + '-' + hi, 12) + pad(g.length, 9) +
			pad(mbits(q(g.map((r) => r.out_bps), 0.5)), 15) + pad(mbits(q(g.map((r) => r.out_bps), 0.9)), 14) +
			pad(q(g.map((r) => r.kbit_per_player), 0.5), 13) + pad(cpu.length ? r1(q(cpu, 0.5)) : '-', 12) +
			(ram.length ? (q(ram, 0.5) / 1024).toFixed(1) : '-'));
	}

	const byHour = {};
	for (const r of good) {
		const h = r.ts.slice(0, 13);
		(byHour[h] = byHour[h] || []).push(r);
	}
	out.push('');
	out.push(pad('hour', 14) + pad('players', 9) + pad('out median', 14) + pad('out peak', 13) + 'kbit/player');
	for (const h of Object.keys(byHour).sort()) {
		const g = byHour[h];
		out.push(pad(h.slice(5, 10) + ' ' + h.slice(11) + ':00', 14) + pad(Math.max(...g.map((r) => r.players)), 9) +
			pad(mbits(q(g.map((r) => r.out_bps), 0.5)), 14) + pad(mbits(Math.max(...g.map((r) => r.out_bps))), 13) +
			q(g.map((r) => r.kbit_per_player), 0.5));
	}

	const busy = good.filter((r) => r.players >= 5);
	const pool = busy.length >= 5 ? busy : good;
	const perPlayer = q(pool.map((r) => r.kbit_per_player), 0.5);
	const peakOut = Math.max(...good.map((r) => r.out_bps));
	const slots = inp.slots || Math.max(...good.map((r) => r.slots || 0)) || inp.players || 40;
	const need = slots * perPlayer * 1000;
	// 100 Mbit/s в inp.uplink - базовая точка модели, а не канал: сравнение с
	// «его линией» печатаем только когда линия реально измерена или задана
	const lineKnown = inp.uplink > 0 && !/fallback/.test(inp.uplinkSource || '');
	const line = Math.max(lineKnown ? inp.uplink : 0, peakOut * 1.15 / 1e6);
	const modelPer = Math.round(inp.modelRate / 1000);

	out.push('');
	out.push('=== ВЫВОД ' + '='.repeat(58));
	out.push('measured      ' + perPlayer + ' kbit/s per player (median of ' + pool.length + ' samples with >= ' + (busy.length >= 5 ? 5 : 1) + ' players)');
	out.push('model said    ' + modelPer + ' kbit/s/player (' + M.WORLD[inp.world].label + ', ' + M.PRIO[inp.prio].label + ')  ->  measured is ' + (perPlayer / modelPer).toFixed(2) + 'x that');
	out.push('peak out      ' + mbits(peakOut) + ' on the wire, line ' + line.toFixed(1) + ' Mbit/s' +
		(lineKnown ? '' : '  (линию не задал --uplink: это не пропускной канал, а observed пик + 15 %)'));
	out.push('need for ' + slots + '   ' + mbits(need) + '  -> MinBandwidth = "' + M.bitsUnit(M.niceDown(need)) + '"' +
		(inp.minBw ? '  (model said "' + M.bitsUnit(inp.minBw) + '")' : ''));
	const suspicious = perPlayer < 100;
	if (suspicious) {
		out.push('');
		out.push('! меньше 100 kbit/s на игрока - на этой сети игра не главный потребитель байтов');
		out.push('  (или сервера полупустые). вывод по полосе ненадёжен, basic.cfg из него не пишем.');
	} else if (!lineKnown) {
		out.push('влезает ли в канал - не проверяю: линия не задана. для этой строки запусти');
		out.push('с --uplink <Mbit/s>, либо возьми цифру из шага 1 одиночного прогона.');
	} else if (need > line * 1e6 * 0.7) {
		out.push('! ' + slots + ' slots at the measured rate eat more than 70 % of the line: fewer slots, shorter view, or "save traffic".');
	} else {
		out.push('fits: ' + slots + ' slots at the measured rate leave ' + (100 - (need / (line * 1e6 * 0.7)) * 100).toFixed(0) + ' % of the 70 % budget spare.');
	}
	const cpuAll = good.map((r) => r.cpu_pct_core).filter((x) => x != null);
	if (cpuAll.length) {
		const per = pool.filter((r) => r.cpu_pct_core != null && r.players >= 5);
		out.push('server cpu    median ' + r1(q(cpuAll, 0.5)) + ' % of one core, p90 ' + r1(q(cpuAll, 0.9)) + ' %' +
			(per.length >= 3 ? ', ~' + r1(q(per.map((r) => r.cpu_pct_core), 0.5) / q(per.map((r) => r.players), 0.5)) + ' % core per player' : ''));
		out.push('              (процессные проценты - это факт, а не наша гипотеза про ядра)');
	}
	const ramAll = good.map((r) => r.ram_mb).filter((x) => x != null);
	if (ramAll.length) {
		out.push('server ram    median ' + (q(ramAll, 0.5) / 1024).toFixed(1) + ' GB, max ' + (Math.max(...ramAll) / 1024).toFixed(1) + ' GB');
	}
	return { text: out.join('\n'), verdict: { perPlayer, peakOut, slots, need, minBw: M.niceDown(need), line, lineKnown, suspicious } };
}

async function watch(o) {
	const dir = path.join(o.out, 'watch');
	fs.mkdirSync(dir, { recursive: true });
	const csv = path.join(dir, 'samples.csv');
	const stopFile = path.join(dir, 'STOP');
	if (!fs.existsSync(csv)) fs.writeFileSync(csv, CSV_HEADER.join(',') + '\n');
	console.log('watch: ' + o.minutes + ' min, every ' + o.every + ' s -> ' + csv);
	console.log('  stop early: create an empty file "' + stopFile + '" (summary prints either way)');

	const tEnd = Date.now() + o.minutes * 60000;
	let prev = null, prevCpu = null, n = 0;
	while (Date.now() < tEnd) {
		if (fs.existsSync(stopFile)) { console.log('STOP file seen, finishing'); try { fs.unlinkSync(stopFile); } catch (e) {} break; }
		const wait = Math.max(0, Math.min(o.every * 1000, tEnd - Date.now()));
		const cur = await sample(o.targets);
		if (cur.st && prev && prev.st) {
			const sp = serverProcs(cur.st.procs);
			const r = rowOf(cur, prev, sp.procs, prevCpu, sp.none);
			fs.appendFileSync(csv, csvLine(r) + '\n');
			n++;
			console.log(fmtRow(r));
			prevCpu = cpuSum(sp.procs);
			if (n % 20 === 0) fs.writeFileSync(path.join(dir, 'summary.txt'), summarize(readCsv(csv), o).text + '\n');
		} else if (!cur.st) {
			console.log(new Date().toISOString() + '  stats failed: neither powershell nor netstat answered');
			prevCpu = null;
		} else {
			prevCpu = cpuSum(serverProcs(cur.st.procs).procs);
		}
		prev = cur;
		if (wait <= 0) break;
		await new Promise((res) => setTimeout(res, wait));
	}

	const s = summarize(readCsv(csv), o);
	console.log('');
	console.log(s.text);
	fs.writeFileSync(path.join(dir, 'summary.txt'), s.text + '\n');
	if (s.verdict && !s.verdict.suspicious) {
		const v = Object.assign({}, o.baseValues, {
			MinBandwidth: s.verdict.minBw,
			// потолок над линией: без известной линии лучше не трогать,
			// низкий maxbandwidth сам себя зажмёт
			MaxBandwidth: s.verdict.lineKnown ? M.niceUp(s.verdict.line * 1e6) : o.baseValues.MaxBandwidth,
		});
		const cfg = path.join(dir, 'basic.cfg');
		fs.writeFileSync(cfg, M.generateCfg(v, Object.assign({}, o.inp, {
			players: s.verdict.slots, uplink: +s.verdict.line.toFixed(1),
		}), { comments: true, units: true }));
		console.log('');
		console.log('written from measured numbers: ' + cfg);
		if (!s.verdict.lineKnown) console.log('  MaxBandwidth оставлен как в одиночном прогоне: линия не задана (--uplink или report.json из шага 1).');
	}
	console.log('rows: ' + csv);
	return s;
}

module.exports = { watch, summarize, readCsv, readStats, sample, rowOf, serverProcs, CSV_HEADER };

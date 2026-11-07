'use strict';
// nixstat.js - линуксовы двойники hw.ps1 и netstats.ps1: те же ключи и те же
// метки источника, но из /proc и /sys, без powershell и без shell-утилит.
//
// opt.root подставляет тест: фикстуры собираются по документации proc(5) и
// sysfs, а не по моим догадкам (урок selftest_a2s: фикстура, повторяющая наши
// предположения, ничего не доказывает). живая коробка читает root='/'
const fs = require('fs');
const os = require('os');
const path = require('path');

// proc(5): utime/stime в /proc/<pid>/stat идут в тиках USER_HZ, и ядро держит
// его равным 100 на всех архитектурах, где вообще есть node
const USER_HZ = 100;
// statm сообщает страницы; 4096 = страница и на x86_64, и на arm64-сборках
const PAGE_BYTES = 4096;

function rd(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function ls(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function cut(s) { return s === null || s === undefined ? '' : String(s).trim(); }
function num(s) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }

// ---------------------------------------------------------------- cpuinfo

// "cpu cores" повторяется на каждом логическом потоке одного сокета, поэтому
// берётся максимум на socket, а не сумма строк (procps считает так же). когда
// строки нет (часть arm и старые ядра) - считаем уникальные пары socket+core,
// а если и их нет, физическими считаем все потоки
function parseCpuinfo(text) {
	const out = { model: '', threads: 0, cores: 0 };
	if (!text) return out;
	const perSocket = new Map();
	const coreIds = new Set();
	let socket = '0';
	for (const line of text.split('\n')) {
		const i = line.indexOf(':');
		if (i < 0) continue;
		const k = line.slice(0, i).trim();
		const v = line.slice(i + 1).trim();
		if (k === 'model name' && !out.model) out.model = v;
		else if (k === 'processor') out.threads++;
		else if (k === 'physical id') socket = v;
		else if (k === 'cpu cores') {
			const prev = perSocket.get(socket) || 0;
			if (num(v) > prev) perSocket.set(socket, num(v));
		} else if (k === 'core id') coreIds.add(socket + '/' + v);
	}
	if (perSocket.size) {
		let n = 0;
		perSocket.forEach((v) => { n += v; });
		out.cores = n;
	} else out.cores = coreIds.size || out.threads;
	if (!out.threads) out.threads = out.cores;
	return out;
}

// кэш из sysfs: index* с level=3. это размер ОДНОЙ области L3 (её держат
// сразу несколько ядер), а не всей суммы по сокету, и на коробке с двумя
// ccx-ами выглядит скромнее, чем пишет cim на windows - поэтому подпись в
// выводе не должна обещать "всего"
function parseCache(base) {
	let kb = 0;
	for (const idx of ls(base)) {
		if (cut(rd(base + '/' + idx + '/level')) !== '3') continue;
		const size = cut(rd(base + '/' + idx + '/size'));
		const n = num(size);
		// sysfs пишет "32768K" или "32M" без единицы только для нулей
		if (/m\b|mb$/i.test(size)) kb += n * 1024;
		else kb += n;
	}
	return kb;
}

function parseOsRelease(text) {
	const out = { caption: '', id: '' };
	if (!text) return out;
	let name = '';
	for (const line of text.split('\n')) {
		const m = /^(PRETTY_NAME|NAME|ID)=(.*)$/.exec(line.trim());
		if (!m) continue;
		const v = m[2].replace(/^"|"$/g, '');
		// NAME идёт первым, а показать надо PRETTY_NAME ("Ubuntu 22.04.5 LTS"
		// вместо "Ubuntu"), поэтому оба запоминаются и выбираются в конце
		if (m[1] === 'PRETTY_NAME') out.caption = v;
		if (m[1] === 'NAME' && !name) name = v;
		if (m[1] === 'ID') out.id = v;
	}
	if (!out.caption) out.caption = name;
	return out;
}

// интерфейсы: physical-адаптер всегда имеет каталог device, у виртуальных
// (lo, docker0, veth, br-*, bond) его нет. сравнение с hw.ps1: там тот же
// смысл дают NetEnabled + MACAddress + Get-NetAdapter -Physical
function listNics(root) {
	const out = [];
	const base = root + '/sys/class/net';
	for (const name of ls(base)) {
		if (name === 'lo') continue;
		const dir = base + '/' + name;
		const up = cut(rd(dir + '/operstate'));
		const carrier = cut(rd(dir + '/carrier'));
		if (up !== 'up' && carrier !== '1') continue;
		if (!isDir(dir + '/statistics')) continue;
		// speed = -1 или пусто на виртуалках и на части драйверов: ноль в
		// подписи честнее, чем "@-1000000"
		const mbps = num(cut(rd(dir + '/speed')));
		out.push({
			name, dir,
			physical: isDir(dir + '/device'),
			bps: mbps > 0 ? mbps * 1000000 : 0,
			sent: num(cut(rd(dir + '/statistics/tx_bytes'))),
			recv: num(cut(rd(dir + '/statistics/rx_bytes'))),
		});
	}
	return out;
}

// ---------------------------------------------------------------- hw

// тот же набор ключей, что отдаёт hw.ps1: readHw() в netbench.js подставляет
// его вместо powershell, когда process.platform === 'linux'
// корень дерева, откуда всё читается. на живой коробке это пустая строка, то
// есть "/". NETBENCH_NIX_ROOT подставляет фикстуру: так линуксова ветка
// прогоняется end-to-end на windows-машине до первого замера на настоящей
function rootOf(opt) {
	if (opt && typeof opt.root === 'string') return opt.root;
	return process.env.NETBENCH_NIX_ROOT || '';
}

// включена ли линуксова ветка. NETBENCH_OS=linux без фикстурного дерева НИЧЕГО
// не меняет: читать /proc на windows негде, и тишина с нулями была бы хуже,
// чем честная ветка powershell
function isLinux() {
	if (os.platform() === 'linux') return true;
	return process.env.NETBENCH_OS === 'linux' && !!process.env.NETBENCH_NIX_ROOT;
}

function hwInfo(opt) {
	const root = rootOf(opt);
	const info = { source: 'linux /proc+sysfs' + (root ? ' (root=' + root + ')' : '') };
	const cpu = parseCpuinfo(rd(root + '/proc/cpuinfo'));
	info.cpu_model = cpu.model;
	info.cpu_threads = cpu.threads;
	info.cpu_cores = cpu.cores;
	const freq = cut(rd(root + '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'));
	// в кГц; у виртуалки cpufreq нет вовсе, и тогда "?" в выводе честнее нуля
	if (freq) info.cpu_max_mhz = Math.round(num(freq) / 1000);
	info.l3_kb = parseCache(root + '/sys/devices/system/cpu/cpu0/cache');
	const memTotal = /^MemTotal:\s+(\d+)/m.exec(rd(root + '/proc/meminfo') || '');
	info.ram_bytes = memTotal ? num(memTotal[1]) * 1024 : os.totalmem();
	const rel = parseOsRelease(rd(root + '/etc/os-release'));
	info.os_caption = rel.caption;
	info.os_build = os.release();
	// gpu: на headless-сервере читать нечего и незачем (hw.ps1 берёт cim,
	// которому там отвечает драйвер), поэтому пустая строка = "не мерялось"
	info.gpu_names = '';
	info.gpu_count = 0;
	const gov = cut(rd(root + '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'));
	// план питания по-виндовому на линуксе не существует; ближайший реальный
	// аналог, который так же решает буст одного ядра, - governor
	info.power_plan = gov ? 'governor: ' + gov : '';
	const nics = listNics(root);
	// в подписи "nics" только физические: docker0 и veth с нулевой скоростью
	// вписываются в ту же колонку, по которой ниже ищется wi-fi, а линия у
	// них вообще не та. когда физических нет (bond, контейнер) - показываем
	// всё, что отдаёт статистику, ровно как их считает netCounters()
	const phys = nics.filter((n) => n.physical);
	const shown = phys.length ? phys : nics;
	info.nicList = nics;
	info.nics = shown.map((n) => n.name + '@' + (n.bps || 0)).join(' | ');
	const dmi = (f) => cut(rd(root + '/sys/class/dmi/id/' + f));
	info.machine = (dmi('sys_vendor') + ' ' + dmi('product_name')).trim();
	return info;
}

// ---------------------------------------------------------------- счётчики дня

// инodes сокетов процесса: /proc/<pid>/fd -> symlink "socket:[12345]". на
// тесте симлинки не поднимаем, поэтому разбор таблицы портов вынесен в
// чистые функции ниже и проверяется по документации отдельно
function socketInodes(pidDir) {
	const set = [];
	for (const fd of ls(pidDir + '/fd')) {
		let link = '';
		try { link = fs.readlinkSync(pidDir + '/fd/' + fd); } catch (e) { continue; }
		const m = /^socket:\[(\d+)\]$/.exec(link);
		if (m) set.push(m[1]);
	}
	return set;
}

// поля /proc/<pid>/stat после ")" (proc(5)): 1 state, 2 ppid, ... 12 utime,
// 13 stime. сами скобки могут содержать пробелы и скобки, поэтому разрываем
// по ПОСЛЕДНЕЙ ")" - иначе имя вида "arma3 (x)" сдвигает все числа
function parseProcStat(text) {
	const close = text === null ? -1 : text.lastIndexOf(') ');
	if (close < 0) return null;
	const f = text.slice(close + 2).split(' ');
	if (f.length < 14) return null;
	// comm между ПЕРВОЙ "(" и ПОСЛЕДНЕЙ ")": в нём бывают пробелы и скобки
	const open = text.indexOf('(');
	return {
		name: open < 0 || close < 0 ? '' : text.slice(open + 1, text.lastIndexOf(')')),
		utime: num(f[11]),
		stime: num(f[12]),
	};
}

// statm: 1 size, 2 resident (страниц), 3 shared, ... - resident в страницах,
// отсюда умножение на PAGE_BYTES
function parseStatm(text) {
	const f = cut(text).split(/\s+/);
	if (f.length < 2) return 0;
	return num(f[1]) * PAGE_BYTES;
}

// arma-сервер на линуксе зовется arma3server / arma3server_x64: фильтр по
// 'arma' тот же, что в netstats.ps1, чтобы serverProcs() в watch.js не пришлось
// менять. comm ядро обрезает до 15 символов, поэтому имя ищем и в comm, и в
// argv[0] из cmdline: короткое проходит по первому, длинное - по второму
function serverProcs(root) {
	const procs = [];
	for (const name of ls(root + '/proc')) {
		if (!/^\d+$/.test(name)) continue;
		const dir = root + '/proc/' + name;
		const stat = parseProcStat(rd(dir + '/stat'));
		if (!stat) continue;
		const cmdline = cut(rd(dir + '/cmdline')).replace(/\0/g, ' ');
		const pname = path.basename(cmdline.split(' ')[0] || '') || stat.name;
		if (!/arma/i.test(stat.name + ' ' + pname)) continue;
		procs.push({
			// имя = то, по чему serverProcs() в watch.js ищет слово server
			name: pname,
			pid: +name,
			cpu: +((stat.utime + stat.stime) / USER_HZ).toFixed(2),
			ws: parseStatm(rd(dir + '/statm')),
			ports: (function () {
				const inodes = socketInodes(dir);
				if (!inodes.length) return '';
				const ports = portsForInodes(udpTables(root), inodes);
				return ports.map(String).sort((a, b) => +a - +b).join(' ');
			})(),
		});
	}
	return procs;
}

function netCounters(opt) {
	const root = rootOf(opt);
	const all = listNics(root);
	let use = all.filter((n) => n.physical);
	// бокс на bond/team или в контейнере с сетью через veth: физических нет,
	// и молчать с нулями значит потерять весь день. берём всё, что отдаёт
	// статистику, и источник это подписывает
	const src = use.length ? 'nix-sysfs' : (all.length ? 'nix-sysfs-no-physical' : 'none');
	if (!use.length) use = all;
	let sent = 0, recv = 0;
	for (const n of use) { sent += n.sent; recv += n.recv; }
	return { src, sent, recv, procs: serverProcs(root) };
}

// ---------------------------------------------------------------- udp-порты

// /proc/net/udp и udp6: "sl local_address rem_address st ... uid timeout inode".
// адрес в таблице лежит в machine order (на x86 "0100007F" = 127.0.0.1), порт
// - обычный hex самого числа (22 = "0016"), поэтому его только разворачивать
// по байтам не надо
function decodeV4(hex) {
	if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
	const b = [];
	for (let i = 0; i < 8; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
	return b.reverse().join('.');
}

// 32 hex = четыре 32-битных слова в machine order. полностью нулевой адрес -
// это "::" (ловит и loopback, и любой интерфейс), ::1 - частный случай
function decodeV6(hex) {
	if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return null;
	const bytes = [];
	for (let w = 0; w < 4; w++) {
		const chunk = hex.substr(w * 8, 8);
		for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(chunk.substr(i, 2), 16));
	}
	if (bytes.every((b) => !b)) return '::';
	const groups = [];
	for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
	if (groups.slice(0, 7).every((g) => g === '0') && groups[7] === '1') return '::1';
	return groups.join(':');
}

function parseUdpTable(text) {
	const rows = [];
	if (!text) return rows;
	for (const line of text.split('\n').slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10) continue;
		const m = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(f[1]);
		if (!m) continue;
		const port = parseInt(m[2], 16);
		const addr = m[1].length === 8 ? decodeV4(m[1]) : decodeV6(m[1]);
		if (addr === null) continue;
		// state 07 = несоединённый (связан и ждёт), 01 = соединённый с кем-то.
	 // get-netudpendpoint отдаёт оба, и для диагноза «порт занят» обо нужны
		if (f[3] !== '07' && f[3] !== '01') continue;
		rows.push({ addr, port, inode: f[9], state: f[3] });
	}
	return rows;
}

function udpTables(root) {
	return [].concat(
		parseUdpTable(rd(root + '/proc/net/udp')),
		parseUdpTable(rd(root + '/proc/net/udp6'))
	);
}

// те же [{port, addrs}], что отдаёт ветка netstat в a2s.js
function listenPorts(opt) {
	const root = rootOf(opt);
	const t4 = rd(root + '/proc/net/udp'), t6 = rd(root + '/proc/net/udp6');
	// null = таблиц не прочитал вовсе, и это НЕ «портов нет»: та же
	// договорённость, что у ветки netstat
	if (t4 === null && t6 === null) return null;
	const rows = [].concat(parseUdpTable(t4), parseUdpTable(t6));
	const byPort = new Map();
	for (const r of rows) {
		if (!byPort.has(r.port)) byPort.set(r.port, []);
		const list = byPort.get(r.port);
		if (list.indexOf(r.addr) < 0) list.push(r.addr);
	}
	const out = [];
	byPort.forEach((addrs, port) => out.push({ port, addrs }));
	return out.sort((a, b) => a.port - b.port);
}

function portsForInodes(rows, inodes) {
	const want = new Set(inodes.map(String));
	const out = [];
	for (const r of rows) {
		if (want.has(r.inode) && out.indexOf(r.port) < 0) out.push(r.port);
	}
	return out;
}

module.exports = {
	hwInfo, netCounters, listenPorts, portsForInodes, udpTables, rootOf, isLinux,
	parseCpuinfo, parseCache, parseOsRelease, parseProcStat, parseStatm,
	parseUdpTable, decodeV4, decodeV6, listNics, serverProcs,
	USER_HZ, PAGE_BYTES,
};

'use strict';
// selftest_nix.js - проверки nixstat.js по ДОКУМЕНТИРОВАННЫМ форматам proc(5)
// и sysfs, а не по тому, что мне кажется. фикстура = настоящее дерево файлов в
// tmp, поэтому читаются те же readFileSync, что и на живой коробке; образцы
// строк считываются руками здесь и подписаны ожидаемым числом.
//
// урок selftest_a2s: фикстура, повторяющая наши допущения, ничего не
// доказывает. поэтому ловушки вшиты в сами образцы - "cpu cores" повторяется
// на каждом потоке, comm содержит ")" и пробел, а адреса лежат в machine order
const fs = require('fs');
const os = require('os');
const path = require('path');
const nix = require('./nixstat.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
	if (cond) { pass++; console.log('ok   ' + name); }
	else { fail++; console.log('FAIL ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))); }
}
function eq(name, got, want) {
	ok(name + ' = ' + JSON.stringify(want), got === want, { got: got, want: want });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netbench-nix-'));
function put(rel, text) {
	const p = path.join(root, rel.split('/').join(path.sep));
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
	return p;
}
function mkdir(rel) {
	fs.mkdirSync(path.join(root, rel.split('/').join(path.sep)), { recursive: true });
}

// ---------------------------------------------------------------- cpuinfo
// 1 сокет, 8 ядер, 16 потоков (SMT). "cpu cores: 8" повторяется на КАЖДОМ из
// 16 блоков - сумма строк дала бы 128
let cpuinfo = '';
for (let i = 0; i < 16; i++) {
	cpuinfo += 'processor\t: ' + i + '\n' +
		'model name\t: AMD Ryzen 7 9800X3D 8-Core Processor\n' +
		'physical id\t: 0\n' +
		'siblings\t: 16\n' +
		'cpu cores\t: 8\n' +
		'apicid\t\t: ' + i + '\n' +
		'core id\t\t: ' + (i % 8) + '\n\n';
}
const cpu = nix.parseCpuinfo(cpuinfo);
eq('threads (smt)', cpu.threads, 16);
eq('cores, максимум на socket а не сумма строк', cpu.cores, 8);
eq('model name', cpu.model, 'AMD Ryzen 7 9800X3D 8-Core Processor');

// два сокета по 4 ядра: 8 ядер, 16 потоков - сумму надо считать ПО СОКЕТАМ
let two = '';
for (let s = 0; s < 2; s++) {
	for (let i = 0; i < 8; i++) {
		two += 'processor\t: ' + (s * 8 + i) + '\nphysical id\t: ' + s +
			'\ncpu cores\t: 4\ncore id\t\t: ' + (i % 4) + '\n\n';
	}
}
eq('cores, два сокета по 4', nix.parseCpuinfo(two).cores, 8);

// часть arm и старые ядра: ни "cpu cores", ни "physical id" нет - тогда
// считаются уникальные core id, а без них потоки = ядра
let noCores = '';
for (let i = 0; i < 4; i++) noCores += 'processor\t: ' + i + '\nmodel name\t: ARMv8 Processor rev 1\n\n';
eq('cores без строки cpu cores = потоки', nix.parseCpuinfo(noCores).cores, 4);
let coreIds = '';
for (let i = 0; i < 6; i++) coreIds += 'processor\t: ' + i + '\ncore id\t\t: ' + (i % 3) + '\n\n';
eq('cores по уникальным core id', nix.parseCpuinfo(coreIds).cores, 3);

// ---------------------------------------------------------------- sysfs
// size пишется "32768K", у части ядер "64M"; level различает кэши, и в L3
// обязан попасть только index с level=3
mkdir('sys/devices/system/cpu/cpu0/cache/index0');
put('sys/devices/system/cpu/cpu0/cache/index0/level', '1\n');
put('sys/devices/system/cpu/cpu0/cache/index0/size', '32K\n');
mkdir('sys/devices/system/cpu/cpu0/cache/index2');
put('sys/devices/system/cpu/cpu0/cache/index2/level', '2\n');
put('sys/devices/system/cpu/cpu0/cache/index2/size', '1024K\n');
mkdir('sys/devices/system/cpu/cpu0/cache/index3');
put('sys/devices/system/cpu/cpu0/cache/index3/level', '3\n');
put('sys/devices/system/cpu/cpu0/cache/index3/size', '32768K\n');
eq('L3 только level=3, без l1/l2', nix.parseCache(path.join(root, 'sys/devices/system/cpu/cpu0/cache')), 32768);
eq('M в size переводится в Kb', nix.parseCache(mkCache('64M')), 65536);

function mkCache(size) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nixcache-'));
	mkdirAt(d, 'index3', '3', size);
	return d;
}
function mkdirAt(dir, idx, level, size) {
	const p = path.join(dir, idx);
	fs.mkdirSync(p, { recursive: true });
	fs.writeFileSync(path.join(p, 'level'), level + '\n');
	fs.writeFileSync(path.join(p, 'size'), size + '\n');
}

// ---------------------------------------------------------------- /etc/os-release
eq('PRETTY_NAME кавычек не несёт',
	nix.parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nPRETTY_NAME="Ubuntu 22.04.5 LTS"\n').caption,
	'Ubuntu 22.04.5 LTS');
eq('без PRETTY_NAME берётся NAME', nix.parseOsRelease('NAME="Debian GNU/Linux"\n').caption, 'Debian GNU/Linux');

// ---------------------------------------------------------------- /proc/<pid>/stat
// proc(5) после comm: state ppid pgrp session tty_nr tpgid flags minflt
// cminflt majflt cmajflt utime stime. в образце utime=500 stime=100 тиков при
// USER_HZ=100 = ровно 6 секунд процессорного времени
const statLine = '4211 (arma3server_x64) S 1 4211 4211 0 -1 4194688 1000 0 0 0 500 100 200 40 20 0 40 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 6 0 0 0 0 0\n';
const st = nix.parseProcStat(statLine);
eq('comm из stat', st.name, 'arma3server_x64');
eq('utime - поле 14, то есть f[11]', st.utime, 500);
eq('stime - поле 15, то есть f[12]', st.stime, 100);

// ловушка: comm с ")" и пробелом внутри сдвигает всё, если рвать по первой ")"
const tricky = '4255 (arma3 (x) server) S 1 4255 4255 0 -1 4194688 1 0 0 0 300 50 0 0 20 0 40 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 17 6 0 0\n';
const tr = nix.parseProcStat(tricky);
eq('comm со скобкой внутри', tr.name, 'arma3 (x) server');
eq('utime не съехал из-за скобки', tr.utime, 300);
eq('stime не съехал', tr.stime, 50);

// statm: поле 2 = resident в СТРАНИЦАХ
eq('statm resident x PAGE', nix.parseStatm('1234567 250000 1000 0 0 0 0\n'), 250000 * nix.PAGE_BYTES);

// ---------------------------------------------------------------- /proc/net/udp
// proc(5): local_address = 8 hex адреса в machine order + ':' + 4 hex порта.
// 0x08FE = 2302, 0x08FF = 2303 (порт игры и порт запроса bi), 0100007F = 127.0.0.1
const UDP = '   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n' +
	'1124: 0100007F:08FE 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 40001 2 0 0\n' +
	'1125: 00000000:08FF 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 40002 2 0 0\n' +
	'1126: 4401A8C0:0903 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 40003 2 0 0\n' +
	'1127: 00000000:1770 00000000:0000 06 00000000:00000000 00:00000000 00000000     0        0 40004 2 0 0\n';
const rows = nix.parseUdpTable(UDP);
eq('0100007F разворачивается в 127.0.0.1', rows[0].addr, '127.0.0.1');
eq('0x08FE = порт игры 2302', rows[0].port, 2302);
eq('00000000 = 0.0.0.0', rows[1].addr, '0.0.0.0');
eq('0x08FF = query порт 2303', rows[1].port, 2303);
// 4401A8C0 в machine order = C0 A8 01 44 = 192.168.1.68 - bind на адрес карты,
// ровно тот случай, когда запрос на 127.0.0.1 никуда не приходит
eq('C0 A8 01 44 = адрес сетевой карты', nix.decodeV4('4401A8C0'), '192.168.1.68');
eq('соединённый udp (st=01) тоже считается связанным', rows[2].port, 2307);
eq('TIME-WAIT-подобный st=06 в диагноз не идёт', rows.length, 3);
eq('inode берётся из 10-го поля', rows[1].inode, '40002');

// udp6: четыре 32-битных слова в machine order; :: = нули, ::1 = 01000000 в
// последнем слове
const UDP6 = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
	'  0: 00000000000000000000000000000000:08FE 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 50001 2\n' +
	'  1: 00000000000000000000000001000000:08FF 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 50002 2\n';
const r6 = nix.parseUdpTable(UDP6);
eq('всё ноль = ::', r6[0].addr, '::');
eq('01000000 в последнем слове = ::1', r6[1].addr, '::1');
eq('порт в udp6 читается так же', r6[1].port, 2303);

// порты процесса по inode сокетов: 40002 = 2303, 50002 = 2303 тоже (v6)
eq('порты по inode', JSON.stringify(nix.portsForInodes(rows.concat(r6), ['40002', '50002'])), '[2303]');
eq('чужой inode не даёт порт', JSON.stringify(nix.portsForInodes(rows, ['99999'])), '[]');

// [{port, addrs}] - форма, которую уже умеет печатать a2s.js
eq('listenPorts группирует адреса одного порта',
	JSON.stringify(nix.listenPorts({ root: rootOfUdp(
		UDP + '1128: 00000000:08FE 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 40005 2 0 0\n'
	) })),
	'[{"port":2302,"addrs":["127.0.0.1","0.0.0.0"]},{"port":2303,"addrs":["0.0.0.0"]},{"port":2307,"addrs":["192.168.1.68"]}]');

function rootOfUdp(text) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nixudp-'));
	fs.mkdirSync(path.join(d, 'proc', 'net'), { recursive: true });
	fs.writeFileSync(path.join(d, 'proc', 'net', 'udp'), text);
	return d;
}

// ---------------------------------------------------------------- живое дерево
put('proc/cpuinfo', cpuinfo);
put('proc/meminfo', 'MemTotal:       32799204 kB\nMemFree:         1000000 kB\n');
put('sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', '5150000\n');
put('sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'performance\n');
put('etc/os-release', 'PRETTY_NAME="Ubuntu 22.04.5 LTS"\nID=ubuntu\n');

mkdir('sys/class/net/eth0/device');
put('sys/class/net/eth0/operstate', 'up\n');
put('sys/class/net/eth0/carrier', '1\n');
put('sys/class/net/eth0/speed', '1000\n');
put('sys/class/net/eth0/statistics/tx_bytes', '5000000\n');
put('sys/class/net/eth0/statistics/rx_bytes', '9000000\n');
mkdir('sys/class/net/lo');
put('sys/class/net/lo/statistics/tx_bytes', '777\n');
// виртуальный мост: статистика есть, каталога device нет - в physical-набор
// не входит, но остаётся запасным вариантом
mkdir('sys/class/net/docker0');
put('sys/class/net/docker0/operstate', 'up\n');
put('sys/class/net/docker0/speed', '-1\n');
put('sys/class/net/docker0/statistics/tx_bytes', '111\n');
put('sys/class/net/docker0/statistics/rx_bytes', '222\n');

put('proc/4211/stat', statLine);
put('proc/4211/statm', '1234567 250000 1000 0 0 0 0\n');
put('proc/4211/cmdline', '/home/arma/arma3server_x64\0-cfg=server.cfg\0');
put('proc/99/stat', '99 (node) S 1 99 99 0 -1 4194688 1 0 0 0 10 5 0 0 20 0 30 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 17 2 0 0\n');
put('proc/99/statm', '100 200 300 0 0 0 0\n');
put('proc/99/cmdline', '/usr/bin/node\0');
// длинное имя: comm обрезан ядром, но argv[0] всё ещё читается
put('proc/4255/stat', tricky);
put('proc/4255/statm', '1 1000 1 0 0 0 0\n');
put('proc/4255/cmdline', '/srv/arma/arma3server_x64\0-port=2302\0');

const hw = nix.hwInfo({ root: root });
eq('hw: потоки', +hw.cpu_threads, 16);
eq('hw: ядра', +hw.cpu_cores, 8);
eq('hw: модель', hw.cpu_model, 'AMD Ryzen 7 9800X3D 8-Core Processor');
eq('hw: cpufreq кГц -> МГц', +hw.cpu_max_mhz, 5150);
eq('hw: MemTotal kB -> байты', +hw.ram_bytes, 32799204 * 1024);
eq('hw: os-release', hw.os_caption, 'Ubuntu 22.04.5 LTS');
eq('hw: план питания = governor, а не выдумка', hw.power_plan, 'governor: performance');
eq('hw: nics только physical, формат name@bps', hw.nics, 'eth0@1000000000');
eq('hw: l3', +hw.l3_kb, 32768);
eq('hw: gpu на headless не врать', hw.gpu_names, '');

const cnt = nix.netCounters({ root: root });
eq('stats: источник = адаптерные счётчики', cnt.src, 'nix-sysfs');
eq('stats: sent = tx_bytes физического', cnt.sent, 5000000);
eq('stats: recv = rx_bytes физического', cnt.recv, 9000000);
eq('stats: чужие процессы не попадают', cnt.procs.length, 2);
eq('stats: имя = basename argv0, слово server есть', cnt.procs[0].name, 'arma3server_x64');
eq('stats: cpu = тики/USER_HZ', cnt.procs[0].cpu, 6);
eq('stats: ram = resident x PAGE', cnt.procs[0].ws, 250000 * nix.PAGE_BYTES);
eq('stats: pid', cnt.procs[1].pid, 4255);

// box без физических (bond / контейнер): счётчики берутся со всех, и источник
// это подписывает - иначе watch молчал бы весь день с нулями
mkdir('sys2/sys/class/net/docker0');
put('sys2/sys/class/net/docker0/operstate', 'up\n');
put('sys2/sys/class/net/docker0/statistics/tx_bytes', '40\n');
put('sys2/sys/class/net/docker0/statistics/rx_bytes', '60\n');
const c2 = nix.netCounters({ root: path.join(root, 'sys2') });
eq('stats: нет physical - берётся виртуальное и подписывается', c2.src, 'nix-sysfs-no-physical');
eq('stats: байты виртуального интерфейса не теряются', c2.sent + c2.recv, 100);

// пустая коробка: ни one, ни nil, а ровно то же «none», что печатает ps1
const c3 = nix.netCounters({ root: path.join(root, 'nowhere') });
eq('stats: ничего нет = proc-only, не крах', c3.src, 'none');
eq('stats: null не возвращается никогда', c3.sent, 0);

// ---------------------------------------------------------------- итог
console.log('');
console.log(fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL PASS (' + pass + ' проверок)');
// rmSync нет в node 12 (win7-рантайм тоже прогоняет этот тест), поэтому
// убираем то, что умеет рантайм
try {
	if (fs.rmSync) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	else fs.rmdirSync(root, { recursive: true });
} catch (e) {}
if (fail) process.exit(1);

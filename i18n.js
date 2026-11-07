// netbench: старые консоли (win7 / 2008, conhost + oem codepage) не рисуют
// utf-8: русские подписи там превращаются в мусор. этот модуль по флагу
// --lang en подменяет в ЭКРАННОМ выводе те самые подписи английскими, а в
// файл (--tee) пишет строки как есть, то есть по-русски.
// исходные строки в коде остаются русскими - файлы и summary.txt не меняются
'use strict';

const fs = require('fs');

let lang = 'ru';
let teeFd = null;
let realLog = console.log.bind(console);

// пары «кусок в русской строке -> английская подпись». порядок важен: сначала
// более длинные, чтобы короткая замена не съела половину длинной
const PAIRS = [
	['твоя модель', 'your model'],
	['=== ВЫВОД', '=== VERDICT'],
	['ни в одном сэмпле на серверах не было игрока - мерить было нечего.',
		'  no sample had a player on any server: there was nothing to measure.'],
	['! меньше 100 kbit/s на игрока - на этой сети игра не главный потребитель байтов',
		'! under 100 kbit/s per player: on this network the game is not the main user of bytes'],
	['(или сервера полупустые). вывод по полосе ненадёжен, basic.cfg из него не пишем.',
		'(or the servers were nearly empty). the bandwidth verdict is not reliable, no basic.cfg from it.'],
	['(линию не задал --uplink: это не пропускной канал, а observed пик + 15 %)',
		'(the line was not set with --uplink: this is not the channel, it is the measured peak + 15 %)'],
	['влезает ли в канал - не проверяю: линия не задана. для этой строки запусти',
		'not checking whether it fits the channel: the line is unknown. for this line run it'],
	['с --uplink <Mbit/s>, либо возьми цифру из шага 1 одиночного прогона.',
		'with --uplink <Mbit/s>, or take the number from step 1 of the one shot run.'],
	['(процессные проценты - это факт, а не наша гипотеза про ядра)',
		'(process percents are a fact, not our guess about cores)'],
	['MaxBandwidth оставлен как в одиночном прогоне: линия не задана (--uplink или report.json из шага 1).',
		'MaxBandwidth left as in the one shot run: the line is unknown (--uplink or report.json from step 1).'],
];

const CYRILLIC = /[Ѐ-ӿ]/;

// имена машины (версия ос, план питания, сетевая карта) приходят с его коробки
// по-русски: перевести их нельзя, но и рисовать старая консоль их не умеет,
// поэтому на экран идёт латиница, а в файл - оригинал
const TR = {
	'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
	'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
	'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
	'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
	'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

const CYRILLIC_ALL = new RegExp(CYRILLIC.source, 'g');

function toAscii(line) {
	return String(line).replace(CYRILLIC_ALL, (ch) => {
		const low = ch.toLowerCase();
		const t = TR[low] != null ? TR[low] : '?';
		return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
	});
}

function toEnglish(line) {
	let s = line;
	for (const [ru, en] of PAIRS) {
		if (s.indexOf(ru) < 0) continue;
		s = s.split(ru).join(en);
	}
	return s;
}

let leftovers = [];
let transliterated = 0;
const names = new Set();

function print(text) {
	if (teeFd != null) fs.writeSync(teeFd, text + '\n');
	if (lang !== 'en') return realLog(text);
	// сводка приходит одним console.log с переносами внутри: разбираем по
	// строкам, иначе untranslated покажет только первую строку блока
	for (const line of String(text).split('\n')) {
		const tr = toEnglish(line);
		const en = toAscii(tr);
		if (en !== tr) {
			transliterated++;
			// подпись = текст до колонки с двумя пробелами (отчёты выровнены),
			// больше шести имён не копить: watch-строки идут часами
			const cut = tr.search(/\s{2,}/);
			if (names.size < 6) names.add((cut > 0 ? tr.slice(0, cut) : tr).trim().slice(0, 24));
		}
		// what is still not ascii = our gap, not the user's machine: say so
		// once at the end instead of letting the console draw it as garbage
		if (/[^\x00-\x7f]/.test(en)) leftovers.push(en);
		realLog(en);
	}
}

function configure(opts) {
	lang = opts.lang === 'en' ? 'en' : 'ru';
	leftovers = [];
	transliterated = 0;
	names.clear();
	if (opts.tee) teeFd = fs.openSync(opts.tee, 'a');
	console.log = (...args) => print(args.join(' '));
	if (lang === 'en' && teeFd == null) {
		// без --tee экран и файл расшлись бы: файл остался бы английским
		console.error('note: --lang en without --tee: the written log will be english too');
	}
}

function done() {
	if (transliterated) {
		// какие именно подписи транслитерированы - называть по факту, а не
		// примером из трёх имён: на его 2008 это были gpu и power plan
		const who = Array.from(names).join(', ') || 'machine names';
		console.error('netbench: ' + transliterated + ' line(s) show what windows itself writes in russian (' + who + '): '
			+ 'printed here in latin letters, the original spelling is in the log and in out\\report.json');
	}
	if (leftovers.length) {
		console.error('netbench: ' + leftovers.length + ' line(s) this console cannot draw at all, '
			+ 'first one: ' + leftovers[0].slice(0, 70));
	}
	if (teeFd != null) { try { fs.closeSync(teeFd); } catch (e) {} teeFd = null; }
}

module.exports = { configure, done, toEnglish, toAscii, lang: () => lang };

// временный самопровер: udp-эхо с ответами a2s, парсер против них. раскладка
// пакетов берётся НЕ из нашей головы, а из актуальной спецификации: info
// отвечает 0x49, challenge - 0x41, за os идут visibility и vac и только потом
// номер сборки, а запрос info обязан нести текст "Source Engine Query"
'use strict';
const dgram = require('dgram');
const { a2sQuery } = require('./a2s.js');

let fails = 0;
function check(label, cond, got) {
	if (cond) { console.log('ok   ' + label); return; }
	fails++;
	console.log('FAIL ' + label + ' -> ' + JSON.stringify(got));
}

// 4 байта challenge. старший бит стоит в последнем байте: ровно тот случай,
// на котором старый код падал с RangeError, потому что пересобирал challenge числом
const CH = Buffer.from([0x11, 0x22, 0x33, 0x88]);
const TEXT = Buffer.from('Source Engine Query');

function challPacket(byte) {
	return Buffer.concat([Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, byte]), CH]);
}

// opts.src = актуальная раскладка (ответ 0x49, за os идут visibility и vac, и
// только потом версия); иначе старый half-life ответ 0x6D, где версия стоит
// сразу за os. opts.noVersion = обрвать пакет до строки версии
function infoPacket(opts) {
	const o = opts || {};
	const p = [0xFF, 0xFF, 0xFF, 0xFF, o.src === false ? 0x6D : 0x49, 0x11];
	const str = (s) => { for (const c of s) p.push(c.charCodeAt(0)); p.push(0); };
	str('KPblM Test Server');
	str('Altis');
	str('evovanila.Altis');
	str('Arma3');
	p.push(0x36, 0xC3);                       // appId = 0xC336 = 49974
	p.push(17, 40, 3);                        // players, max players, bots
	p.push((o.dedicated || 'd').charCodeAt(0), 'w'.charCodeAt(0));
	if (o.src !== false) p.push(0x00, 0x01);  // visibility, vac
	if (!o.noVersion) str('2.14.156832');
	return Buffer.from(p);
}

// ответ правил: счётчик пар и сами пары строка-в-строку
function rulesPacket(pairs) {
	const p = [0xFF, 0xFF, 0xFF, 0xFF, 0x45, pairs.length & 0xFF, (pairs.length >> 8) & 0xFF];
	for (const [k, v] of pairs) {
		for (const c of k) p.push(c.charCodeAt(0));
		p.push(0);
		for (const c of v) p.push(c.charCodeAt(0));
		p.push(0);
	}
	return Buffer.from(p);
}

function playersPacket(names) {
	const p = [0xFF, 0xFF, 0xFF, 0xFF, 0x44, names.length];
	for (const n of names) {
		p.push(p.length);                     // индекс
		for (const c of n) p.push(c.charCodeAt(0));
		p.push(0, 0, 0, 0, 0, 0, 0, 0);       // score int32 + time float32
	}
	return Buffer.from(p);
}

// spec: { chalByte, echo, info, rules, players }
function serve(port, spec) {
	const srv = dgram.createSocket('udp4');
	// bad = запросы не по спецификации. живой сервер на такие молчит, поэтому
	// проверка текста идёт до всего остального
	srv.stats = { bad: [], asked: 0 };
	srv.on('message', (msg, rinfo) => {
		const cmd = msg[4];
		if ([0x54, 0x55, 0x56].indexOf(cmd) < 0) return;
		srv.stats.asked++;
		const asked = cmd === 0x54 ? 'info' : cmd === 0x55 ? 'players' : 'rules';
		const body = spec[asked];
		let off = 5;
		if (cmd === 0x54) {
			// без текста "Source Engine Query" запрос вообще не считается
			// запросом info - и это ровно то, что ломало разговор с сервером
			if (msg.slice(5, 5 + TEXT.length).compare(TEXT) !== 0 || msg[5 + TEXT.length] !== 0) {
				srv.stats.bad.push('info request without the query text');
				return;
			}
			off = 5 + TEXT.length + 1;
		}
		const echoed = msg.length >= off + 4 && Buffer.compare(msg.slice(off, off + 4), CH) === 0;
		// настоящий сервер сначала всегда просит challenge, даже на то, чего
		// он потом не отдаст, - поэтому проверка эха идёт до проверки тела
		if (spec.echo && !echoed) { srv.send(challPacket(spec.chalByte), rinfo.port, rinfo.address); return; }
		if (!body) return;
		srv.send(body, rinfo.port, rinfo.address);
	});
	return new Promise((res) => srv.bind(port, '127.0.0.1', () => res(srv)));
}

// тесты идут только когда файл запустили напрямую: прогон делает его сам,
// а чужому скрипту нужны builders, чтобы поднять сервер по этой же раскладке
if (require.main !== module) module.exports = { infoPacket, rulesPacket, playersPacket, serve, challPacket, TEXT };
else (async () => {
	// 1. актуальный ответ 0x49 + challenge 0x41, старший бит challenge взведён
	{
		const srv = await serve(27099, { echo: true, chalByte: 0x41, info: infoPacket({ src: true }) });
		const r = await a2sQuery('127.0.0.1', 27099);
		check('0x49 info, 0x41 challenge with the high bit set',
			r.ok && r.via === 'info' && r.maxPlayers === 40 && r.players === 17 && r.bots === 3 &&
			r.appId === 49974 && r.version === '2.14.156832' && r.name === 'KPblM Test Server', r);
		// эхо-сервер молчит на запрос без текста, поэтому допрос с текстом
		// означает, что текст в запросе действительно был
		check('the info request carried the query text', srv.stats.bad.length === 0 && srv.stats.asked >= 2, srv.stats);
		srv.close();
	}
	// 2. старый half-life ответ: версия идёт сразу за os, без двух байт запаса
	{
		const srv = await serve(27098, { echo: true, chalByte: 0x67, info: infoPacket({ src: false }) });
		const r = await a2sQuery('127.0.0.1', 27098);
		check('legacy 0x6D info', r.ok && r.via === 'info' && r.maxPlayers === 40 && r.version === '2.14.156832', r);
		srv.close();
	}
	// 3. info молчит, правила несут слоты дробью, игрок - кто в игре
	{
		const srv = await serve(27096, {
			echo: true, chalByte: 0x41,
			rules: rulesPacket([['#world', 'Altis'], ['#slots', '12/40'], ['#mission', 'EVO FFA RED']]),
			players: playersPacket(['B0BKrAruS', 'Anonrh', '[WD]SEM'])
		});
		const r = await a2sQuery('127.0.0.1', 27096);
		check('rules carry the slots', r.ok && r.via === 'rules' && r.maxPlayers === 40 && r.players === 3 && r.map === 'Altis' && r.mission === 'EVO FFA RED', r);
		srv.close();
	}
	// 4. правила отвечают, но ключ не похож на слоты: не выдумываем, а складываем
	//    пары в результат, чтобы их назвал настоящий лог
	{
		const srv = await serve(27095, {
			echo: true, chalByte: 0x41,
			rules: rulesPacket([['someKey', '7'], ['anotherKey', 'x']])
		});
		const r = await a2sQuery('127.0.0.1', 27095);
		check('unknown rule keys are dumped, not guessed', !r.ok && /rules/.test(r.err) && r.rules && r.rules.length === 2, r);
		srv.close();
	}
	// 5. сервер, который молчит совсем: ok:false, а не исключение
	{
		const srv = await serve(27094, {});
		const r = await a2sQuery('127.0.0.1', 27094, 400);
		check('silent server', !r.ok && /no UDP answer/.test(r.err) && /player and rules silent/.test(r.err), r);
		srv.close();
	}
	// 6. challenge пришёл, но после повтора пусто: диагноз обязан это различать
	{
		const srv = await serve(27093, { echo: true, chalByte: 0x41 });
		const r = await a2sQuery('127.0.0.1', 27093, 400);
		check('challenge then silence', !r.ok && /challenge/.test(r.err), r);
		srv.close();
	}
	// 7. счётчики на месте, а поля за ними не читаются: число всё равно отдаём,
	//    но с пометкой, что прочиталось подозрительно
	{
		const srv = await serve(27097, { echo: true, chalByte: 0x41, info: infoPacket({ src: true, dedicated: 'Z', noVersion: true }) });
		const r = await a2sQuery('127.0.0.1', 27097);
		check('implausible fields still deliver the slot count',
			r.ok && r.via === 'info?' && r.maxPlayers === 40 && /suspect/.test(JSON.stringify(r)), r);
		srv.close();
	}
	console.log(fails ? 'FAILS: ' + fails : 'ALL PASS');
	process.exit(fails ? 1 : 0);
})();

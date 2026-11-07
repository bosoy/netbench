// порт движковой модели из генератора basic.cfg - константы и формулы один в один
'use strict';

const ANIM_E = 100;          // an animation/state change adds ~100 to the error score
const REF = 20;              // reference radius (m)
const REF_ZOOM = 500;        // reference radius in zoomed views
const WORST_FPS = 20;        // plan packet budgets for a loaded server

const animReach = (mets, ref = REF) => (mets > 0 ? ref * Math.sqrt(ANIM_E / mets) : Infinity);

const WORLD = {
	quiet: { rate: 128e3, label: 'Quiet' },
	busy: { rate: 256e3, label: 'Busy' },
	heavy: { rate: 384e3, label: 'Heavy' },
};

const PRIO = {
	smooth: { rate: 1.5, reach: 2.0, metsMin: 0.001, metsMax: 0.003, near: 0.01, label: 'Smooth' },
	balanced: { rate: 1.0, reach: 1.25, metsMin: 0.001, metsMax: 0.01, near: 0.01, label: 'Balanced' },
	save: { rate: 0.7, reach: 1.0, metsMin: 0.002, metsMax: 0.02, near: 0.02, label: 'Save traffic' },
};

function niceDown(v) {
	const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 7.5, 8, 9];
	const e = 10 ** Math.floor(Math.log10(v));
	let best = e;
	for (const s of steps) if (s * e <= v + 1e-9) best = s * e;
	return Math.round(best);
}

function niceUp(v) {
	const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 7.5, 8, 9, 10];
	const e = 10 ** Math.floor(Math.log10(v));
	for (const s of steps) if (s * e >= v - 1e-9) return Math.round(s * e);
	return Math.round(10 * e);
}

function niceNear(v) {
	const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
	const e = 10 ** Math.floor(Math.log10(v));
	let best = e, bd = Infinity;
	for (const s of steps) { const d = Math.abs(Math.log(s * e / v)); if (d < bd) { bd = d; best = s * e; } }
	return +best.toPrecision(3);
}

const pow2ceil = (v) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

const fmtNum = (v, d = 0) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBits = (b) => (b >= 1e9 ? fmtNum(b / 1e9, 2) + ' Gbit/s' : b >= 1e6 ? fmtNum(b / 1e6, 1) + ' Mbit/s' : fmtNum(b / 1e3, 0) + ' kbit/s');
const fmtBytes = (b) => (b >= 1e6 ? fmtNum(b / 1e6, 2) + ' MB' : b >= 1e3 ? fmtNum(b / 1e3, 1) + ' kB' : fmtNum(b) + ' B');
const fmtM = (m) => (!isFinite(m) ? 'everywhere' : m > 15360 ? 'whole map' : m >= 1000 ? fmtNum(m / 1000, 1) + ' km' : fmtNum(m) + ' m');

function bitsUnit(v) {
	v = Math.round(v);
	if (v % 1e9 === 0) return `${v / 1e9}Gbit/s`;
	if (v % 1e6 === 0) return `${v / 1e6}Mbit/s`;
	if (v % 1e3 === 0) return `${v / 1e3}kbit/s`;
	return `${v}bit/s`;
}

function recommend(inp) {
	const w = WORLD[inp.world], p = PRIO[inp.prio];
	const P = inp.players, U = inp.uplink * 1e6;
	const rate = w.rate * p.rate;
	const need = P * rate;
	const usable = U * 0.7;
	const minBw = niceDown(Math.max(131072, Math.min(need, usable)));
	const maxBw = Math.max(minBw, niceUp(U));   // потолок над линией, см. формулировку BI
	const peak = Math.min(maxBw / P, 10e6);
	const msg = Math.min(1024, Math.max(128, pow2ceil((2 * peak) / 8 / WORST_FPS / 256)));
	const reach = Math.max(500, inp.vd * p.reach);
	const mets = niceNear(Math.min(p.metsMax, Math.max(p.metsMin, ANIM_E * (REF / reach) ** 2)));
	const v = {
		MaxMsgSend: msg,
		MinBandwidth: minBw,
		MaxBandwidth: maxBw,
		MinErrorToSend: mets,
		MinErrorToSendNear: p.near,
		MaxSizeGuaranteed: 512,
		MaxSizeNonguaranteed: 256,
		maxPacketSize: null,
		MaxCustomFileSize: 0,
	};
	const assumed = /fallback/.test(inp.uplinkSource || '');
	const why = {
		MaxMsgSend: `Enough packets for ${fmtBits(peak)} per player at ${WORST_FPS} server FPS, x2 headroom.`,
		MinBandwidth: need <= usable
			? `${P} players x ${fmtBits(rate)} (${w.label}, ${p.label}).`
			: `Capped at 70 % of your upload. ${P} players x ${fmtBits(rate)} would need ${fmtBits(need)}.`,
		MaxBandwidth: assumed
			? `Placeholder: the line was never measured, ${fmtBits(U)} is the built-in assumption, not your tariff. Re-run without --uplink so the upload gets measured, or pass the tariff.`
			: `Just above your ${fmtBits(U)} line: BI defines this key as the bandwidth the server will never have, so under the line it would clamp itself. Planning still uses 70 % (${fmtBits(usable)}).`,
		MinErrorToSend: `Animations reach about ${fmtM(animReach(mets))}, matching your ${fmtM(inp.vd)} view distance (${p.label}).`,
		MinErrorToSendNear: inp.prio === 'save' ? 'Save traffic: fewer tiny updates close by.' : 'BI default.',
		MaxSizeGuaranteed: 'BI default. Only raise it if the server is the bottleneck; big packets get lost whole on a bad client line.',
		MaxSizeNonguaranteed: 'BI default. BI: raising it buys bandwidth but adds position lag; over 1300 bytes they warn of negative effects.',
		maxPacketSize: 'Not written: no sockets block means the engine default (1400). Set it only if a router forces smaller packets.',
		MaxCustomFileSize: '0 = never kick for custom face/sound. BI default 1024 bytes does kick those players.',
	};
	const alerts = [];
	if (assumed) alerts.push(`Uplink was NOT measured: ${fmtBits(U)} is the built-in assumption, so every slots cap and MaxBandwidth below inherits it. Re-run with the line test (no --uplink) or pass your tariff.`);
	if (need > usable) alerts.push(`Upload is tight: ${P} players need about ${fmtBits(need / 0.7)}. Try "save" priority or fewer slots.`);
	if (maxBw / P < 256e3) alerts.push(`Only ${fmtBits(maxBw / P)} per player at peak. Busy towns will lag.`);
	return { v, why, alerts, peak, need, usable, rate };
}

const KEYS = [
	{ key: 'MaxMsgSend', type: 'int', note: 'per player per frame' },
	{ key: 'MinBandwidth', type: 'int', unitBits: true, note: 'bit/s total, floor' },
	{ key: 'MaxBandwidth', type: 'int', unitBits: true, note: 'bit/s total, ceiling' },
	{ key: 'MinErrorToSend', type: 'float', note: 'higher = less far traffic' },
	{ key: 'MinErrorToSendNear', type: 'float', note: 'floor at any distance' },
	{ key: 'MaxSizeGuaranteed', type: 'int', note: 'bytes, reliable' },
	{ key: 'MaxSizeNonguaranteed', type: 'int', note: 'bytes, positions' },
	{ key: 'maxPacketSize', cls: 'sockets', type: 'int', note: 'bytes, UDP packet' },
	{ key: 'MaxCustomFileSize', type: 'int', note: 'bytes, face/sound limit' },
];

function cfgVal(k, v, units) {
	if (k.unitBits && units) return `"${bitsUnit(v)}"`;
	if (k.type === 'int') return String(Math.round(v));
	let s = String(+v.toPrecision(6));
	if (!/[.e]/.test(s)) s += '.0';
	return s;
}

// эмиттер тот же, что в генераторе: выравнивание в 32 колонки и class sockets отдельным блоком
function generateCfg(v, inp, { comments = true, units = true, extraTop = '', extraSockets = '' } = {}) {
	const line = (k) => {
		const s = `${k.key} = ${cfgVal(k, v[k.key], units)};`;
		return comments ? s.padEnd(32) + '// ' + k.note : s;
	};
	const out = [];
	const assumedLine = /fallback/.test(inp.uplinkSource || '');
	if (comments) {
		out.push(`// basic.cfg: ${inp.players} players, ${inp.uplink} Mbit/s upload${assumedLine ? ' (LINE NOT MEASURED: assumed, not your tariff)' : ''}, ${WORLD[inp.world].label}, ${PRIO[inp.prio].label}`);
		out.push('// Start the server with -cfg=basic.cfg (read once at start).');
		out.push('');
	}
	for (const k of KEYS) if (!k.cls && v[k.key] != null) out.push(line(k));
	if (extraTop) out.push('', extraTop);
	const sock = KEYS.filter((k) => k.cls === 'sockets' && v[k.key] != null);
	if (sock.length || extraSockets) {
		out.push('', 'class sockets', '{');
		for (const k of sock) out.push('\t' + line(k));
		if (extraSockets) for (const l of extraSockets.split(/\r?\n/)) out.push('\t' + l.trim());
		out.push('};');
	}
	return out.join('\n') + '\n';
}

module.exports = {
	ANIM_E, REF, REF_ZOOM, WORST_FPS, WORLD, PRIO, KEYS,
	animReach, niceDown, niceUp, niceNear, pow2ceil, recommend, generateCfg,
	bitsUnit, fmtNum, fmtBits, fmtBytes, fmtM,
};

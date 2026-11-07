// sizing - сколько слотов держит линия и (после калибровки) железо
// сетевая часть считается формулами из model.js, то есть твоим генератором;
// часть про железо - наша экстраполяция, она подписана как экстраполяция
'use strict';

const fs = require('fs');
const path = require('path');
const M = require('./model.js');

const WORLD_RANK = { heavy: 3, busy: 2, quiet: 1 };
const PRIO_RANK = { smooth: 3, balanced: 2, save: 1 };
const PER_PLAYER_FLOOR = 256e3;   // тот же порог, что у алерта генератора: "busy towns will lag"

// матрица соответствия: 3 класса сцены x 3 приоритета, каждой клеткой считаем
// ровно ту же recommend(), что и для файла настроек
function fitMatrix(uplinkMbit, players, vd = 3000) {
	const rows = [];
	for (const world of Object.keys(M.WORLD)) {
		for (const prio of Object.keys(M.PRIO)) {
			const inp = { players, vd, world, prio, uplink: uplinkMbit };
			const rec = M.recommend(inp);
			const v = rec.v;
			const perPlayer = Math.min(rec.peak, 10e6);
			const bwSlots = Math.floor((uplinkMbit * 1e6 * 0.7) / rec.rate);
			const floorSlots = Math.floor((uplinkMbit * 1e6 * 0.9) / PER_PLAYER_FLOOR);
			rows.push({
				world, prio,
				label: M.WORLD[world].label + ' + ' + M.PRIO[prio].label,
				rate: rec.rate,
				need: rec.need,
				usable: rec.usable,
				bandwidthOk: rec.need <= rec.usable,
				floorOk: rec.v.MaxBandwidth / players >= PER_PLAYER_FLOOR,
				fits: rec.need <= rec.usable && rec.v.MaxBandwidth / players >= PER_PLAYER_FLOOR,
				perPlayer,
				mets: v.MinErrorToSend,
				reach: M.animReach(v.MinErrorToSend),
				maxBw: rec.v.MaxBandwidth,
				bwSlots,
				floorSlots,
				slotsCap: Math.min(bwSlots, floorSlots),
				comfort: WORLD_RANK[world] + PRIO_RANK[prio],
			});
		}
	}
	return rows;
}

// самое комфортное соответствие: сначала по сумме рангов, при равенстве -
// большую дальность анимаций считаем лучше
function pickBest(rows) {
	const ok = rows.filter((r) => r.fits);
	if (!ok.length) return null;
	return ok.sort((a, b) => (b.comfort - a.comfort) || (b.reach - a.reach))[0];
}

const CAL_FILE = 'calibration.json';

function calPath(dir) {
	return path.join(dir, CAL_FILE);
}

function loadCal(dir) {
	try {
		const j = JSON.parse(fs.readFileSync(calPath(dir), 'utf8'));
		return j && j.singleCoreMIterS ? j : null;
	} catch (e) { return null; }
}

function saveCal(dir, obj) {
	fs.writeFileSync(calPath(dir), JSON.stringify(obj, null, 2));
	return calPath(dir);
}

// линейная экстраполяция от единственной известной точки: «не лучше чем»,
// потому что нагрузка сервера растёт по числу юнитов быстрее, чем линейно
function cpuBound(core, players, cal) {
	if (!cal || !cal.players || !cal.singleCoreMIterS) return null;
	const ratio = core / cal.singleCoreMIterS;
	return {
		ratio,
		slots: Math.floor(players * ratio),
		aiCap: cal.aiCap ? Math.floor(cal.aiCap * ratio) : null,
		ref: cal,
	};
}

module.exports = { fitMatrix, pickBest, loadCal, saveCal, calPath, cpuBound, PER_PLAYER_FLOOR };

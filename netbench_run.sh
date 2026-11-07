#!/bin/sh
# netbench runbook - три шага, весь вывод в netbench.log рядом с этим файлом.
#
# это тот же прогон, что netbench_run.cmd, только под линукс: ядро, модель и
# подписи отчёта не тронуты, поэтому и логи с двух осей сравниваются строка в
# строку.
#
# чем этот файл отличается от bat-ника:
#   node берётся из дистрибутива (в архиве лежат только оконные рантаймы)
#   про язык экрана решает локаль, а не версия системы
#   показ файла - обычный cat: терминал с utf-8 читает его сам, без powershell
#
# usage: netbench_run.sh [uplink_mbit] [a2s_ip:port] [cal_players] [cal_ai_cap]
#   без uplink линия меряется; тест загрузки держит её секунд восемь, и в этот
#   момент игроки на живом сервере получат лаги
#   с числом uplink тест скорости не запускается вовсе: можно прогонять при
#   людях, сервер только ответит на браузерный запрос
#   без cal_players шаг 3 пропускается
#   адрес в первом слове тоже понимается (в нём есть двоеточие, в числе его
#   нет), так что замер можно запускать с сервером:
#     sh netbench_run.sh 127.0.0.1:2402 40 150
#   с замером:          sh netbench_run.sh
#   холостой прогон:    sh netbench_run.sh 200 127.0.0.1:2302 50 150
#
# .sh не пересохраняют из notepad: он вернёт переносы в crlf, и ядро откажется
# читать такую первую строку. если правка всё же нужна - редактор с lf.
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="$DIR/out"
LOG="$DIR/netbench.log"
TMPD=${TMPDIR:-/tmp}
TMPLOG="$TMPD/netbench_step.$$"
TMPERR="$TMPD/netbench_step_err.$$"

UPLINK=${1:-}
A2S=${2:-}
CALPLAYERS=${3:-}
CALAICAP=${4:-}

# первый аргумент с двоеточием = адрес сервера, а не uplink: список сдвигается
# влево. без этого "netbench_run.sh 127.0.0.1:2402 40 150" доезжает до node как
# --uplink 127.0.0.1:2402, и вся матрица подбора печатает nan
case "${UPLINK}" in
	*:*)
		A2S=${UPLINK}
		CALPLAYERS=${2:-}
		CALAICAP=${3:-}
		UPLINK=""
		;;
esac

[ -n "$A2S" ] || A2S="127.0.0.1:2302"
cd "$DIR" || exit 1

say() {
	printf '%s\n' "$1" >> "$LOG"
	printf '%s\n' "$1"
}

# рантайм и язык экрана - от picknode.sh; он печатает ровно два присваивания.
# код возврата проверяется ДО eval: пустая строка eval-ится успешно, и тогда
# провал picknode превратился бы в "unbound variable" ниже, а не в сообщение
PICK=$(sh "$DIR/picknode.sh") || {
	say "netbench: no working node on this box, see the message above"
	exit 1
}
eval "$PICK"
NODE=$NETBENCH_NODE

LEGACY=""
[ "$NETBENCH_SCREEN" = "legacy" ] && LEGACY=1
[ "${NETBENCH_LEGACY:-}" = "1" ] && LEGACY=1
[ "${NETBENCH_LEGACY:-}" = "0" ] && LEGACY=""
NETBENCH_LANG=""
NETBENCH_TEE=""
if [ -n "$LEGACY" ]; then
	NETBENCH_LANG=en
	NETBENCH_TEE=$LOG
	export NETBENCH_LANG NETBENCH_TEE
	echo "console: this locale cannot draw utf-8, screen in english, log in russian"
fi

# шаг: stdout + stderr, которые до этого сливались в один файл. на экране с
# utf-8 node сам печатает русские подписи, поэтому их только дописывают в лог;
# в legacy русский копиат уже лёг в лог через tee, и на экран выводится
# английская копия, а stderr мимо tee попадает в лог руками
show() {
	if [ -n "$LEGACY" ]; then
		cat "$1"
	else
		cat "$1" >> "$LOG"
		cat "$1"
	fi
	if [ -f "$2" ]; then
		cat "$2" >> "$LOG"
		cat "$2"
	fi
}

# голый ip без порта: ретрай ниже добавляет +1, поэтому порт должен быть явен
case "$A2S" in
	*:*) ;;
	*) A2S="$A2S:2302" ;;
esac
HOST=${A2S%%:*}
PORT=${A2S##*:}
PORT2=$((PORT + 1))

# bi считает порт стим-запроса как game+1, поэтому игровой порт молчит by
# design, а сервер отвечает портом рядом. каждый шаг спрашивает оба
A2SFLAGS="--a2s $HOST:$PORT --a2s $HOST:$PORT2"

# пустой uplink = флаг не передаётся вовсе, и тогда netbench меряет линию сам
UPFLAG=""
[ -n "$UPLINK" ] && UPFLAG="--uplink $UPLINK"

printf '%s\n' "============= netbench run =============" > "$LOG"
"$NODE" -p "new Date().toISOString()" >> "$LOG" 2>&1
if ! "$NODE" -v >> "$LOG" 2>&1; then
	say "netbench: the node picked above stopped working, install a newer nodejs"
	exit 1
fi

# ---------------- 1. линия + живой сервер ----------------
# мёртвый a2s не должен оставлять модель на встроенных 40: третий аргумент -
# его собственное число слотов, поэтому шаг 1 и 1b берут его оттуда
PLAYERFLAG=""
[ -n "$CALPLAYERS" ] && PLAYERFLAG="--players $CALPLAYERS"
say "args: uplink=$UPLINK a2s=$A2S cal_players=$CALPLAYERS cal_ai_cap=$CALAICAP"
say "---- 1. line + live server on $HOST:$PORT and $HOST:$PORT2 ----"
if [ -z "$UPFLAG" ]; then
	say "note: the upload test saturates the line for ~8 seconds"
else
	say "note: the line is not measured at all, your $UPLINK Mbit/s is used"
fi
"$NODE" netbench.js $PLAYERFLAG $UPFLAG $A2SFLAGS --auto --out "$OUT" > "$TMPLOG" 2> "$TMPERR"
show "$TMPLOG" "$TMPERR"

# измеренный uplink передаётся шагам 1b и 3, чтобы они не печатали допущение.
# передавать разрешено только настоящее измерение: собрать строку из fallback
# линии означало бы выдать нашу же догадку в 100 Mbit/s за его тариф
if [ -z "$UPFLAG" ]; then
	MEASURED=$(awk '/^uplink/ && /measured upload/ {print $2; exit}' "$TMPLOG")
	if [ -n "$MEASURED" ]; then
		UPFLAG="--uplink $MEASURED"
		say "note: measured upload $MEASURED Mbit/s reused in steps 1b and 3"
	else
		say "note: step 1 did not measure the upload, so the line below is the built-in assumption, not your tariff"
	fi
fi

# ни один порт не ответил в шаге 1: спросить ещё раз, когда линия уже свободна,
# - тест загрузки только что держал её и udp-таймаут там не доказательство
# молчаливого сервера
if ! grep -q "players, map" "$TMPLOG"; then
	if [ -n "$UPFLAG" ]; then
		say "---- 1b. retry on $HOST:$PORT and $HOST:$PORT2 (the line is already known, no second speed test) ----"
		NETFLAG="--no-net"
	else
		say "---- 1b. retry on $HOST:$PORT and $HOST:$PORT2 ----"
		NETFLAG=""
	fi
	"$NODE" netbench.js $NETFLAG $PLAYERFLAG $UPFLAG $A2SFLAGS --auto --out "$OUT" > "$TMPLOG" 2> "$TMPERR"
	show "$TMPLOG" "$TMPERR"
	if grep -q "players, map" "$TMPLOG"; then
		say "the retry answered: the server does reply, the first pass just did not get it"
	elif [ -n "$PLAYERFLAG" ]; then
		say "neither $PORT nor $PORT2 answered: slots taken from your 3rd argument ($CALPLAYERS), not from the server"
	else
		say "neither $PORT nor $PORT2 answered: the udp listeners line above says whether a server runs on this machine at all"
	fi
fi

# ---------------- 2. basic.cfg как он записан ----------------
say "---- 2. basic.cfg written by step 1 ----"
if [ -f "$OUT/basic.cfg" ]; then
	if [ -n "$LEGACY" ]; then
		say "note: the russian comments below can draw as garbage in this locale, the file itself is fine"
	fi
	if [ -n "$LEGACY" ]; then
		cat "$OUT/basic.cfg"
	else
		cat "$OUT/basic.cfg" >> "$LOG"
		cat "$OUT/basic.cfg"
	fi
else
	say "basic.cfg missing in $OUT"
fi

# ---------------- 3. калибровка железа ----------------
# --a2s здесь тоже: этот шаг последний пишет basic.cfg, поэтому без живого
# числа слотов он молча перепишет файл на угаданном аргументе
say "---- 3. calibration ----"
if [ -z "$CALPLAYERS" ]; then
	say "skipped: pass cal_players and cal_ai_cap as the 3rd and 4th argument"
elif [ -z "$CALAICAP" ]; then
	"$NODE" netbench.js --no-net --auto $UPFLAG $A2SFLAGS --players "$CALPLAYERS" --calibrate --out "$OUT" > "$TMPLOG" 2> "$TMPERR"
	show "$TMPLOG" "$TMPERR"
else
	"$NODE" netbench.js --no-net --auto $UPFLAG $A2SFLAGS --players "$CALPLAYERS" --ai-cap "$CALAICAP" --calibrate --out "$OUT" > "$TMPLOG" 2> "$TMPERR"
	show "$TMPLOG" "$TMPERR"
fi

printf '%s\n' "============= end =============" >> "$LOG"
say "send back: netbench.log, out/report.json, out/basic.cfg"
say "the log file is utf-8"
rm -f "$TMPLOG" "$TMPERR"
exit 0

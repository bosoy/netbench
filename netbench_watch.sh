#!/bin/sh
# netbench watch - снимать живые числа весь день и в конце напечатать вывод
# ничего не пишется в сервер: только счётчики ос + a2s-запрос снаружи
#
# это тот же sampler, что netbench_watch.cmd: тот же csv, та же сводка, те же
# подписи, поэтому суточный лог с линукса и с windows сравниваются построчно.
#
# usage: netbench_watch.sh [minutes] [every_sec] [ip:port ...]
#   sh netbench_watch.sh                  24 ч, каждые 30 с, 2302+2303 и 2402+2403
#   sh netbench_watch.sh 720              12 ч
#   sh netbench_watch.sh 720 60           12 ч, каждые 60 с
#   sh netbench_watch.sh 1440 30 127.0.0.1:2402
#   sh netbench_watch.sh 127.0.0.1:2302
#                                         только адреса: 24 ч и 30 с остаются
#                                         дефолтом. каждый адрес спрашивается и
#                                         портом выше, поэтому неважно, назвал
#                                         он игровой порт или портовый
#   sh netbench_watch.sh report           вывод из уже собранных строк
# весь день без терминала:
#   nohup sh netbench_watch.sh > watch.out 2>&1 &
# ранний останов: создать пустой файл out/watch/STOP - сводка всё равно
# напечатается. ctrl-c убьёт сэмплер, строки на диске останутся, потом
# "report"
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="$DIR/out"
LOG="$DIR/netbench_watch.log"
TMPD=${TMPDIR:-/tmp}
TMPERR="$TMPD/netbench_watch_err.$$"
cd "$DIR" || exit 1

say() {
	printf '%s\n' "$1" >> "$LOG"
	printf '%s\n' "$1"
}

# код возврата проверяется ДО eval: пустая строка eval-ится успешно, и провал
# picknode иначе вылез бы ниже как "unbound variable" вместо сообщения
PICK=$(sh "$DIR/picknode.sh") || exit 1
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

# адреса начиная с первого слота: у адреса есть двоеточие, у числа минут его
# нет. без этого сдвига адрес доехал бы до сэмплера как время прогона
ADDR_FIRST=""
case "${1:-}" in *:*) ADDR_FIRST=1 ;; esac

MODE=${1:-}
EVERY=${2:-}
if [ -n "$ADDR_FIRST" ]; then
	MODE=1440
	EVERY=30
fi
[ -n "$MODE" ] || MODE=1440
[ -n "$EVERY" ] || EVERY=30

# bi считает порт стим-запроса как game+1, и сам игровой порт на запрос не
# отвечает никогда, поэтому одиночный 127.0.0.1:2302 записывает молчание весь
# день на машине, где сервер живёт портом рядом. каждый названный адрес
# поэтому спрашивается и портом выше. сэмплер суммирует игроков со всех
# ответивших адресов, так что сервер может попасть в список только один раз:
# сосед сверху пропускается, если его уже назвали, и если назвали соседа снизу
# (значит этот адрес и есть чей-то портовый)
# первый проход записывает то, что дали, второй собирает флаги
GIVEN=" "
noteaddr() {
	[ -n "${1:-}" ] || return 0
	WH=${1%%:*}
	WP=${1##*:}
	if [ "$WH" = "$1" ] || [ -z "$WP" ]; then
		echo "skipped \"$1\": expected host:port with a numeric port, like 127.0.0.1:2402"
		return 0
	fi
	case "$WH" in
		"" | *[!0-9A-Za-z._-]*)
			echo "skipped \"$1\": expected host:port with a numeric port, like 127.0.0.1:2402"
			return 0 ;;
	esac
	case "$WP" in
		*[!0-9]*)
			echo "skipped \"$1\": expected host:port with a numeric port, like 127.0.0.1:2402"
			return 0 ;;
	esac
	GIVEN="$GIVEN$1 "
	return 0
}

if [ -n "$ADDR_FIRST" ]; then
	for a in "$@"; do noteaddr "$a"; done
elif [ "$#" -gt 2 ]; then
	shift 2
	for a in "$@"; do noteaddr "$a"; done
fi
if [ "$GIVEN" = " " ]; then
	noteaddr 127.0.0.1:2302
	noteaddr 127.0.0.1:2402
fi

A2SFLAGS=""
addaddr() {
	AD=$1
	WH=${AD%%:*}
	WP=${AD##*:}
	A2SFLAGS="$A2SFLAGS --a2s $AD"
	UP=$((WP + 1))
	DOWN=$((WP - 1))
	case "$GIVEN" in *" $WH:$UP "*) return 0 ;; esac
	case "$GIVEN" in *" $WH:$DOWN "*) return 0 ;; esac
	[ "$UP" -le 65535 ] || return 0
	A2SFLAGS="$A2SFLAGS --a2s $WH:$UP"
	return 0
}
for a in $GIVEN; do addaddr "$a"; done

if [ "$MODE" = "report" ]; then
	if [ -n "$LEGACY" ]; then
		"$NODE" netbench.js --report $A2SFLAGS --out "$OUT" 2> "$TMPERR"
	else
		"$NODE" netbench.js --report $A2SFLAGS --out "$OUT" 2> "$TMPERR" | tee -a "$LOG"
	fi
else
	case "$MODE" in
		'' | *[!0-9]*)
			echo "first argument is the run time in minutes, a number like 1440 or 720,"
			echo "or the word report. addresses go after the interval:"
			echo "  sh netbench_watch.sh 1440 30 127.0.0.1:2302 127.0.0.1:2402"
			echo "  sh netbench_watch.sh 127.0.0.1:2302 127.0.0.1:2402"
			rm -f "$TMPERR"
			exit 2
			;;
	esac
	case "$EVERY" in
		'' | *[!0-9]*)
			echo "second argument is the sampling interval in seconds, a plain number"
			echo "  sh netbench_watch.sh 1440 30 127.0.0.1:2302"
			rm -f "$TMPERR"
			exit 2
			;;
	esac

	say "watching for $MODE minutes, one row every $EVERY s"
	say "rows:   $OUT/watch/samples.csv"
	say "log:    $LOG"
	if [ -n "$LEGACY" ]; then
		# экран получает английские строки живьём, русский копиат пишет сам tee
		# внутри node, а stderr мимо него дописывается в лог руками
		say "note: this locale cannot draw utf-8, the live rows below are english"
		"$NODE" netbench.js --watch "$MODE" --every "$EVERY" $A2SFLAGS --out "$OUT" 2> "$TMPERR"
	else
		say "live rows are kept here too: $LOG"
		say "summary after the time is up, or run: sh netbench_watch.sh report"
		"$NODE" netbench.js --watch "$MODE" --every "$EVERY" $A2SFLAGS --out "$OUT" 2>&1 | tee -a "$LOG"
	fi
fi

# ошибки мимо tee не проходят, поэтому их показывают и пишут за один раз
if [ -f "$TMPERR" ] && [ -s "$TMPERR" ]; then
	cat "$TMPERR" >> "$LOG"
	cat "$TMPERR"
fi
rm -f "$TMPERR"
exit 0

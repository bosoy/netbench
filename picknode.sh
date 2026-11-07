#!/bin/sh
# netbench: найти рантайм и решить, что этот терминал умеет рисовать.
# этот файл НЕ источник: его запускают и eval-ят две строки, которые он
# печатает, поэтому ему не нужен bash, а его сообщения не смешиваются с
# присваиваниями.
#
# под линукс в архиве нет своего node: оконные node12/node24 работают только
# в windows, здесь берётся тот node, который стоит в репозитории дистрибутива.
# проверка одна: он вообще запускается и не старше 12-й ветки (watch.js и
# a2s.js пользуются методом, которого в 10 нет).
#
# вторая вещь, которую решает этот файл - язык экрана. в windows за это
# отвечала версия системы, здесь всё проще: если локаль не utf-8 (server
# install с LANG=C, cron без окружения), терминал не нарисует кириллицу, и
# тогда экран получает английские подписи, а файлы - русские. ровно та же
# логика, что в picknode.cmd. NETBENCH_MODERN=1 / =0 перебивает проверку руками.
#
# всё ниже только читает: ничего не пишется ни в сервер, ни в систему.
set -u

NODE=""
for c in node nodejs; do
	if command -v "$c" >/dev/null 2>&1 && "$c" -v >/dev/null 2>&1; then
		NODE="$c"
		break
	fi
done

if [ -z "$NODE" ]; then
	echo "netbench: node not found in PATH" >&2
	echo "  install it from the distro repository and run again:" >&2
	echo "    debian / ubuntu:   apt install nodejs" >&2
	echo "    fedora / rhel:     dnf install nodejs" >&2
	echo "    arch:              pacman -S nodejs-linux" >&2
	exit 1
fi

# process.versions.node работает на любой ветке, включая ту, что не дотянет
# до остального скрипта, - поэтому версионная проверка идёт отдельно от запуска
MAJ=$("$NODE" -p 'String(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if ! expr "$MAJ" : '[0-9][0-9]*$' >/dev/null; then MAJ=0; fi
if [ "$MAJ" -lt 12 ]; then
	echo "netbench: node $MAJ is too old, the sampler needs 12 or newer" >&2
	echo "  this box reports $("$NODE" -v 2>/dev/null)" >&2
	echo "  install a newer nodejs package, then run again" >&2
	exit 1
fi

SCREEN=legacy
CHARMAP=$(locale charmap 2>/dev/null || echo "")
case "${LC_ALL:-${LANG:-}}" in
	*UTF-8* | *utf8* | *UTF8*) CHARMAP="UTF-8" ;;
esac
case "$CHARMAP" in
	*UTF-8* | *utf8*) SCREEN=modern ;;
esac
if [ "${NETBENCH_MODERN:-}" = "1" ]; then SCREEN=modern; fi
if [ "${NETBENCH_MODERN:-}" = "0" ]; then SCREEN=legacy; fi

# вывод только эти две строки: вызывающий их eval-ит
printf "NETBENCH_NODE='%s'\n" "$NODE"
printf "NETBENCH_SCREEN='%s'\n" "$SCREEN"

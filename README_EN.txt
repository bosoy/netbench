netbench - measure the machine and the line, then write basic.cfg for an Arma 3 dedicated server
(english twin of README.txt)

WHAT IT DOES
  1. reads the hardware: cpu model, cores, a single-core index, ram, network
     cards, power plan
  2. measures the line: rtt, jitter, packet loss, download, upload
  3. writes out\basic.cfg with values derived from those two measurements
  4. watch mode: records a running server all day and rebuilds basic.cfg from
     the traffic it actually produced instead of from the model

YOU NEED
  - 64 bit windows, win7 / server 2008 through win11 / server 2025, or linux
  - nothing else on windows: no installer, no modules, no package manager, and
    no node to install either. see ARCHIVES AND RUNTIME below
  - on linux, only node from the distribution repository. see LINUX below

ARCHIVES AND RUNTIME
  netbench_all.zip is the one to take: it carries BOTH runtimes inside,
  node12 (the last node that starts on win7 / vista / 2008 / 8 / 8.1) and
  node24 (win10 and newer), and picknode.cmd decides which one runs by reading
  the version string and then actually starting the binary. picking an archive
  for your windows version is not part of using this tool.
  if neither folder is there, it still works: node.exe next to the scripts,
  then netbench\node\node.exe, then the node from PATH, so folders laid out by
  the older archives keep running.
  64 bit only. on a 32 bit system the script says so instead of failing quiet.
  the same code is checked on both runtimes (node --check on every file and
  selftest_a2s.js), so the two paths cannot drift apart.

LINUX
  same js, same labels, same csv. nothing was rewritten for linux except where
  the numbers come from: the model, the A2S parser and the report are shared, so
  a day log from linux and a day log from windows compare row by row. instead of
  powershell and netstat everything is read from /proc and /sys (nixstat.js):
    hardware    /proc/cpuinfo (model, cores, threads - "cpu cores" repeats per
                logical thread and is never summed), /sys/.../cpufreq,
                cache/index*, /proc/meminfo, /etc/os-release, /sys/class/dmi/id
    line / day  /sys/class/net/<if>/statistics of the physical cards only
                (lo, docker0, veth, bond are not summed; a box with nothing
                physical falls back to all of them and the src column says so),
                plus /proc/<pid>/stat and statm of the server process
    ports       /proc/net/udp and /proc/net/udp6, the same table netstat -ano
                prints on windows, including a socket bound to a card address
  the process is matched on "arma" in comm AND in argv[0] of cmdline: the kernel
  cuts comm at 15 characters, so a full arma3server_x64 path would not fit and
  the filter alone would miss it. cpu is utime+stime in ticks, ram is the
  resident set - the same two quantities as on windows, so "server ram" in the
  summary means the same thing on both systems.
  the port list of the process stays empty when the server runs as another user:
  /proc/<pid>/fd is not readable without being that user (or ptrace). cpu and
  ram are unaffected.
  run it the same way, with the .sh files:
    sh netbench_run.sh 200 127.0.0.1:2302 50 150
    sh netbench_run.sh 127.0.0.1:2402 40 150    address first, then the line is
                                                measured by the tool itself
    sh netbench_watch.sh                        24 h, one row every 30 s
    sh netbench_watch.sh 1440 30 127.0.0.1:2302
    sh netbench_watch.sh report                 verdict from the rows on disk
  the whole day without keeping a terminal open:
    nohup sh netbench_watch.sh > watch.out 2>&1 &
  the arguments mean exactly what they mean in the .cmd files: an address may
  come first (it has a colon, a minute count does not), every address you name
  is also asked one port up, and a word where a number belongs stops the run
  with the command line to fix instead of printing a table of nan.
  do not re-save a .sh from an editor that writes crlf: the kernel then refuses
  the first line ("bad interpreter"). keep lf, or run it as "sh file.sh".
  no node is packed for linux: the node12 / node24 files in the archive are
  windows binaries. picknode.sh looks for node in PATH (node, then nodejs),
  checks that it is version 12 or newer, and when it is missing prints the
  package name for your distribution.
  on linux the console language follows the locale, not a windows version: with
  LANG=C (a bare server install, cron, su) the terminal cannot draw utf-8, so
  the screen gets english labels and the russian text goes into the log. the run
  starts with "console: this locale cannot draw utf-8" when that happened.
  overrule it in the same window with NETBENCH_LEGACY=1 / =0, or with
  NETBENCH_MODERN=1 / =0, which is the same switch under another name.
  everything else in this file applies unchanged; only the paths differ,
  out/watch instead of out\watch.

ONE SHOT RUN
  netbench_run.cmd 200 127.0.0.1:2302 50 150
    1) uplink in Mbit/s. if you skip it, the script measures the line itself.
       the upload test loads the channel for about 8 seconds (download another
       8): players on a live server will lag during those seconds. WITH the
       number there is no speed test at all, so the safe form while people are
       playing is the one that starts with the number
    2) ip:port of the running server. the real slot count is taken from it
       (A2S_INFO, the same query the server browser uses). the game port and
       the game port +1 are both asked in every step, because BI answers the
       query on +1 and the game port itself stays silent by design. when both
       are silent and the address is local, the report also says whether
       anything on this machine listens on udp at all in the BI port range
       (game port -1 .. +4): no listener means the server runs on another box
       and you must pass its real address.
       if the listener is bound to a network card address instead of 0.0.0.0,
       the query is repeated on that address - a server bound that way never
       hears 127.0.0.1, and the report names the address that answered
    3) how many slots this box already holds - a calibration point for the
       hardware estimate. the model takes its slot count from the live server;
       your number here is what it falls back to when the query stays silent,
       and when the two disagree the log prints both and says which one it used
    4) the unit cap set on this box - the other half of that calibration point
  without calibration:   netbench_run.cmd 200 127.0.0.1:2302
  with the line measure: netbench_run.cmd
  the server address may also come first, then the line is measured by the
  script itself: netbench_run.cmd 127.0.0.1:2402 40 150
  a number in the first slot is always the uplink, an address always has the
  colon; a word where a number belongs stops the run with the command line to
  fix instead of printing a table of nan.
  if the upload test fails (no route to the test host, the line does not
  answer) the tool does not pass an assumption off as your line: the uplink
  row says why nothing was measured, and the fit matrix and basic.cfg are
  marked "LINE NOT MEASURED" - the 100 Mbit/s there is the built-in
  assumption, not your tariff. give the tariff yourself
  (netbench_run.cmd 200 127.0.0.1:2402) and the markers go away and the
  fits/does-not-fit line is computed from your number.

RESULTS OF THE ONE SHOT RUN
  out\basic.cfg      ready file: put it next to the server exe and start the
                     server with -cfg=basic.cfg
  out\report.json    every number, plus the reason for every single key
  netbench.log       the whole run, utf-8

ALL DAY MEASUREMENT (watch mode)
  netbench_watch.cmd 1440 30 127.0.0.1:2302 127.0.0.1:2402
    minutes, seconds between rows, then one address per server on the box.
    plain "netbench_watch.cmd" means 24 hours, every 30 seconds, ports 2302
    and 2402 on localhost.
    every address is also asked one port up, because BI numbers the steam
    query port as game+1 and the game port never answers a query. naming the
    game port or the query port therefore reaches the same running server. a
    port already in the list, or the port above another address you named, is
    not added again: the player count is the sum over the list, and one server
    in it twice would halve the kbit per player.
    "netbench_watch.cmd report" rebuilds the summary from the rows that are
    already on disk.
  nothing gets installed and nothing gets written into the server: it reads
  windows counters (bytes on the network card, cpu time and ram of the server
  process) and asks the server for its player count with a browser query.
  leave the window open. to stop early, create an empty file out\watch\STOP.
  ctrl+c only kills the recorder, the rows already collected stay usable.
  the line it compares against comes from --uplink, or from out\report.json of
  a previous one shot run; with neither, the "fits / does not fit" line is
  skipped and MinBandwidth is still reported. the same report.json also gives
  the model point (scene class, priority, view distance), so the summary
  compares the day against what --auto actually chose for this box instead of
  against the built-in defaults. --world, --prio, --vd and --players next to
  node override it. the slot count, though, comes from the live answers of the
  day: change maxPlayers in server.cfg mid run and the summary follows.
  win7 and server 2008 work too: there the byte counters come from netstat -e
  (the adapter cmdlets do not exist before win8), cpu and ram are read the
  ordinary way, and the src column says proc-only+netstat-e. win8 and 8.1
  already have the adapter cmdlets, so they behave like a newer box. no
  separate archive is needed for any of them, see ARCHIVES AND RUNTIME below.
  cpu and ram are counted over the server process only (its name has to contain
  "server"). in a row where no such process existed - the server was restarting
  or had crashed - cpu and ram stay empty and only the adapter bytes are
  recorded, because the sum of every process on the box is not the server. the
  summary counts those rows in its own "no server" line.

CONSOLE AND OUTPUT LANGUAGE
  the files are russian on every box: netbench.log, out\watch\summary.txt and
  the comments inside basic.cfg. on win10 and newer the console shows the same
  russian text. on win7 / vista / 2008 / 8 / 8.1 that console cannot draw
  utf-8, so there the labels print in english and the russian line goes into
  the log instead -
  you see "console: old windows console detected, screen in english, log in
  russian" at the start when that happened. nothing to switch on by hand; if
  the windows version probe is fooled by a localised system, set
  NETBENCH_LEGACY=1 (english screen) or NETBENCH_LEGACY=0 in the same window.
  one version probe decides both the screen and the runtime, and it lives in
  picknode.cmd so the two can never disagree. to overrule the runtime choice
  itself, set NETBENCH_MODERN=1 (use the current node) or NETBENCH_MODERN=0
  (use the node that still starts on win7 and 8.1).
  names that come FROM the machine (windows edition, power plan, network card)
  cannot be translated, so on the old console they are shown in latin letters,
  for example "Maykrosoft Windows 11 IoT Korporativnaya". The log and
  report.json keep the original spelling, and the run ends with a line saying
  how many such names were re-spelled.

WHICH ARCHIVE
  netbench_all.zip       one for every os: win7 / 2008 / 8 / 8.1, win10 /
                         server 2019+ (2025 included) and linux. both windows
                         runtimes, the .cmd wrappers and the .sh wrappers are
                         inside; on linux node comes from the distribution
  netbench_win7.zip      win7 / 2008 / 2012. node 12.22.12 x64 is inside, the
                         last build that still starts on win7 - nothing to add
                         (windows only)
  netbench_portable.zip  win10 and newer. node v24 is inside, it will not
                         start on win7 (windows only)
  netbench.zip           scripts only: node from PATH or from netbench\node\

WHERE TO SEE THE RESULT
  console window         one row per interval
  out\watch\summary.txt  the verdict. it is rewritten every 20 rows, so it is
                         worth reading about 10 minutes after the start - you
                         do not have to wait for the end of the day
  out\watch\samples.csv  every row, opens in Excel
  netbench_watch.log     full log of the recording, utf-8
  out\watch\basic.cfg    basic.cfg built from the measured numbers. written at
                         the end, and only if the numbers are usable

WHAT THE SUMMARY TELLS YOU
  kbit/s per player grouped by player count (1-4, 5-9, 10-19, 20-29, 30-39,
  40+) and by hour of day, median and p90, not just an average over 24 hours;
  measured against what the model predicted; peak traffic on the wire; cpu
  percent of one core and ram of the server process; MinBandwidth and
  MaxBandwidth recomputed from the measurement.
  If the per player figure comes out under 100 kbit/s, the game is not the
  main user of that network card (or the servers were nearly empty): the
  summary says so and does not write basic.cfg from those rows.

SEND BACK TO THE AUTHOR
  netbench.log, out\report.json, out\basic.cfg
  for an all day run also out\watch\samples.csv and out\watch\summary.txt

CHECK THE QUERY PARSER WITHOUT A SERVER
  node selftest_a2s.js

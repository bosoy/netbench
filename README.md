# netbench

**TEST BUILD, feedback wanted** — English version. Full text (Russian + English) is in the repo.

netbench is a small tool for Arma 3 dedicated server admins. What it does:
1. reads the machine: cpu, cores, single-core speed, ram, network card, power plan
2. measures the line: ping, jitter, packet loss, download, upload
3. writes basic.cfg from those measurements, with a comment saying why each value is what it is
4. watch mode: records a running server for a day and rebuilds basic.cfg from the traffic it actually produced — real kbit/s per player, not a guess

Nothing gets installed, nothing gets written into the server. Unzip and run.

Still language: files are always russian. On the old console node prints english labels but the russian copy goes into the log.

## Requirements

- 64 bit windows, win7 / server 2008 through win11 / server 2025
- linux deb, rpm, arch. arch.
- node from your distro, version 12 or newer. for windows everything is inside the archive
- nothing else: no installer, no modules, no package manager

## Windows (bat file)

```
netbench_run.cmd [uplink] [ip:port] [slots] [unit_cap]
netbench_watch.cmd 1440 30 [ip:port]
```

## Linux (shell)

```
sh netbench_run.sh [uplink] [ip:port] [slots] [unit_cap]
sh netbench_watch.sh 1440 30 [ip:port]
```

For background: `nohup sh netbench_watch.sh > watch.out 2>&1 &`

One crate for every OS: **netbench_all.zip** (46 MB). Node 12 + node 24. For windows 7/2008/2012 and win10/2025, one crate for every OS, one crate for all of them. Windows 7/2008/2012 → `netbench_win7.zip` (node 12). Win10/2025 → `netbench_portable.zip` (node 24).

## Where to see the result

- `out\basic.cfg` — ready settings file, start the server with `-cfg=basic.cfg`
- `out\report.json` — every number plus the reason for every key
- `out\watch\summary.txt` — the verdict, rewritten every 20 rows — worth reading 10 minutes after start, no need to wait for the end of the day
- `out\watch\samples.csv` — every row, opens in Excel
- `netbench.log` — full log, utf-8

## Send back to the author

- `netbench.log`, `out\report.json`, `out\basic.cfg`
- for a day run also `out\watch\samples.csv` and `out\watch\summary.txt`
- and two lines from you: how many slots and what uplink your plan gives. That is the point of the check - measuring the model on machines other than mine.

## Known limits

- The speed test loads the line for about 8 seconds up and 8 down. Players on a live server will feel it. Pass your uplink as the first number and the speed test is skipped entirely
- The hardware estimate is an extrapolation from one reference box, not an official norm. Bohemia does not publish slots-per-core or ram-per-player
- basic.cfg only touches the network stream. It does not fix server FPS
- watch mode cannot see server FPS or desync - that is in the server rpt
- If the per player figure comes out under 100 kbit/s, the game is not the main user of that network card, or the servers were nearly empty: the summary says so and does not write basic.cfg from those rows

## Verify the archive

```
sha256sum netbench_all.zip
e7d6076cffe0ed8bed1630a8395fa70c7a2fdd666e198c55261816844af66267
```

hash inside README.txt — if not matched, the archive is not the one we signed.

## Check the query parser without a server

```
node selftest_a2s.js
node selftest_nix.js
```

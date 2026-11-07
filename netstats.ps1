# netbench watch: cumulative NIC byte counters + arma server process stats.
# ascii only, key=value lines on stdout.
# kept powershell 2.0 compatible (win7 / server 2008): no [pscustomobject],
# no convertto-json, and the win8+ net adapter cmdlets are optional
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$sent = 0
$recv = 0
$nic = 'none'
$adapters = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { $_.Name })
if ($adapters.Count -gt 0) {
	foreach ($s in (Get-NetAdapterStatistics)) {
		if ($adapters -notcontains $s.Name) { continue }
		$sent += $s.SentBytes
		$recv += $s.ReceivedBytes
	}
	$nic = 'adapter-stats'
}
Write-Output ('nic=' + $nic)
Write-Output ('sent=' + $sent)
Write-Output ('recv=' + $recv)

foreach ($p in (Get-Process | Where-Object { $_.ProcessName -match 'arma' })) {
	$ports = ''
	foreach ($e in (Get-NetUDPEndpoint -OwningProcess $p.Id)) { $ports = $ports + ' ' + $e.LocalPort }
	Write-Output ('proc=' + $p.ProcessName + '|' + $p.Id + '|' + [math]::Round($p.CPU, 2) + '|' + $p.WorkingSet64 + '|' + $ports.Trim())
}

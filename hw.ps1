# hardware scan, ascii only, key=value lines on stdout
# run as: powershell -NoProfile -ExecutionPolicy Bypass -File hw.ps1

$ErrorActionPreference = 'SilentlyContinue'

# node читает stdout как utf8, а консоль рус/windows-а по умолчанию в oem codepage
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Get-Prop($obj, $names) {
    foreach ($n in $names) {
        $p = $obj.PSObject.Properties[$n]
        if ($p -ne $null -and $p.Value -ne $null) { return $p.Value }
    }
    return $null
}

# Win32_Processor / Win32_ComputerSystem / Win32_VideoController / Win32_PhysicalMemory
# CIM first (Win8+), WMI fallback for the older box
function Get-Inst($class) {
    $r = @(Get-CimInstance -ClassName $class)
    if ($r.Count -eq 0) { $r = @(Get-WmiObject -Class $class) }
    return $r
}

function Out-Line($k, $v) {
    if ($v -eq $null) { $v = '' }
    Write-Output ($k + '=' + $v)
}

$cpu = @(Get-Inst 'Win32_Processor')
if ($cpu.Count -gt 0) {
    Out-Line 'cpu_name'       ('' + (Get-Prop $cpu[0] @('Name'))).Trim()
    Out-Line 'cpu_sockets'    $cpu.Count
    $lc = 0; $pc = 0
    foreach ($c in $cpu) { $lc += [int](Get-Prop $c @('NumberOfLogicalProcessors', 'LogicalProcessors')); $pc += [int](Get-Prop $c @('NumberOfCores', 'Cores')) }
    Out-Line 'cpu_threads'    $lc
    Out-Line 'cpu_cores'      $pc
    Out-Line 'cpu_max_mhz'    (Get-Prop $cpu[0] @('MaxClockSpeed', 'CurrentClockSpeed'))
    Out-Line 'l2_kb'          (Get-Prop $cpu[0] @('L2CacheSize'))
    Out-Line 'l3_kb'          (Get-Prop $cpu[0] @('L3CacheSize'))
}

$cs = @(Get-Inst 'Win32_ComputerSystem')
if ($cs.Count -gt 0) {
    Out-Line 'manuf'     ('' + (Get-Prop $cs[0] @('Manufacturer'))).Trim()
    Out-Line 'model'     ('' + (Get-Prop $cs[0] @('Model'))).Trim()
    Out-Line 'ram_bytes' (Get-Prop $cs[0] @('TotalPhysicalMemory'))
}

$mem = @(Get-Inst 'Win32_OperatingSystem')
if ($mem.Count -gt 0) {
    Out-Line 'os_build'   (Get-Prop $mem[0] @('BuildNumber'))
    Out-Line 'os_caption' ('' + (Get-Prop $mem[0] @('Caption'))).Trim()
    Out-Line 'ram_free'   (Get-Prop $mem[0] @('FreePhysicalMemory'))
}

$gpu = @(Get-Inst 'Win32_VideoController')
$names = @()
foreach ($g in $gpu) { $names += ('' + (Get-Prop $g @('Name'))).Trim() }
Out-Line 'gpu_count' $gpu.Count
Out-Line 'gpu_names' ($names -join ' | ')

$phy = @(Get-Inst 'Win32_PhysicalMemory')
Out-Line 'ram_sticks' $phy.Count

$disk = @(Get-Inst 'Win32_DiskDrive')
Out-Line 'disk_count' $disk.Count

# is the C: drive an ssd? trim the leading \\.\ from DeviceID when joining partitions
foreach ($d in $disk) {
    $did = '' + (Get-Prop $d @('DeviceID'))
    $part = @(Get-Inst 'Win32_DiskPartition') | Where-Object { ('' + $_.DiskIndex) -eq ('' + (Get-Prop $d @('Index'))) }
    if ($part.Count -gt 0) {
        $lt = '' + (Get-Prop $d @('MediaType'))
        Out-Line ('disk_' + (Get-Prop $d @('Index')) + '_media') $lt
        break
    }
}

$nic = @(Get-Inst 'MSFT_NetAdapterStatistics 2>$null')
$nic = @(Get-Inst 'Win32_NetworkAdapter')
$up = @()
foreach ($n in $nic) {
    if ([int](Get-Prop $n @('NetEnabled')) -eq 1 -and (Get-Prop $n @('MACAddress')) -ne $null) {
        $sp = Get-Prop $n @('Speed')
        $up += (('' + (Get-Prop $n @('Name'))).Trim() + '@' + $sp)
    }
}
Out-Line 'nics' ($up -join ' | ')

# power plan: the server box on a balanced plan loses single-core boost
# вывод powercfg: "<подпись>: <guid>  (<имя схемы>)" - берём имя в скобках
$plan = (powercfg -getactivescheme)
if ($plan -ne $null) {
    $s = ('' + $plan)
    if ($s -match '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\s*\((.*?)\)') {
        Out-Line 'power_plan' $matches[1].Trim()
    } else {
        Out-Line 'power_plan' $s.Trim()
    }
}

Out-Line 'done' '1'

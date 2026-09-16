# Runs a private Postgres cluster for this project (trust auth, localhost only) using an
# existing PostgreSQL install. Set PG_BIN / PG_LOCAL_PORT to override the defaults.
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\Program Files\PostgreSQL\18\bin' }
$port = if ($env:PG_LOCAL_PORT) { $env:PG_LOCAL_PORT } else { '5433' }
$data = Join-Path $root '.pgdata'
$pgctl = Join-Path $bin 'pg_ctl.exe'
$psql = Join-Path $bin 'psql.exe'

function Invoke-PgCtl([string]$arguments) {
  # Redirect to files: pg_ctl's child postmaster otherwise inherits the console pipe and the call never returns.
  $out = Join-Path $env:TEMP 'prospect-room-pgctl.out'
  $err = Join-Path $env:TEMP 'prospect-room-pgctl.err'
  $p = Start-Process -FilePath $pgctl -ArgumentList $arguments -NoNewWindow -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle # without touching the handle first, Windows PowerShell reports a null ExitCode
  $p.WaitForExit()
  Get-Content $out, $err -ErrorAction SilentlyContinue | Where-Object { $_ } | ForEach-Object { Write-Host $_ }
  return $p.ExitCode
}

switch ($Action) {
  'start' {
    if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
      & (Join-Path $bin 'initdb.exe') -D $data -U postgres --auth=trust -E UTF8 --no-locale | Out-Host
    }
    $code = Invoke-PgCtl "status -D `"$data`""
    if ($code -ne 0) {
      $code = Invoke-PgCtl "start -D `"$data`" -o `"-p $port -c listen_addresses=localhost`" -l `"$data\server.log`" -w -t 60"
      if ($code -ne 0) { throw "pg_ctl start failed (exit $code); see $data\server.log" }
    }
    foreach ($db in 'prospect_room', 'prospect_room_test') {
      $exists = & $psql -h localhost -p $port -U postgres -w -tAc "select 1 from pg_database where datname = '$db'"
      if (-not $exists) { & $psql -h localhost -p $port -U postgres -w -c "create database $db" | Out-Host }
    }
    Write-Host "Postgres ready: postgres://postgres@localhost:$port/prospect_room"
  }
  'stop' { exit (Invoke-PgCtl "stop -D `"$data`" -m fast") }
  'status' { exit (Invoke-PgCtl "status -D `"$data`"") }
}

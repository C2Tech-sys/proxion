<#
.SYNOPSIS
    Marks every node_modules directory in this repo as Dropbox-ignored.

.DESCRIPTION
    Dropbox on Windows honors the `com.dropbox.ignored` alternate data stream on a
    directory to skip syncing it. node_modules directories are large, churn
    constantly, and should never be synced. Run this after `pnpm install` (and any
    time a new workspace's node_modules appears).
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$targets = @(
    (Join-Path $repoRoot 'node_modules'),
    (Join-Path $repoRoot 'apps/web/node_modules'),
    (Join-Path $repoRoot 'apps/server/node_modules'),
    (Join-Path $repoRoot 'packages/pve-api/node_modules')
)

foreach ($dir in $targets) {
    if (Test-Path -LiteralPath $dir) {
        Set-Content -Path $dir -Stream com.dropbox.ignored -Value 1
        Write-Host "Dropbox-ignored: $dir"
    } else {
        Write-Host "Skipped (not found): $dir"
    }
}

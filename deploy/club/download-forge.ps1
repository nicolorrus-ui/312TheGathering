# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$base = (Get-Content -Raw (Join-Path $root 'apps/server/internal/runtimepkg/manifest.json') | ConvertFrom-Json).forge
$source = (Get-Content -Raw (Join-Path $root 'third_party/forge-runtime/overlay-base.json') | ConvertFrom-Json).source
$directory = Join-Path $PSScriptRoot 'forge-archives'
New-Item -ItemType Directory -Path $directory -Force | Out-Null

function Test-PinnedArchive($path, $asset) {
    return ((Test-Path -LiteralPath $path -PathType Leaf) -and
        ((Get-Item -LiteralPath $path).Length -eq $asset.size) -and
        ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $asset.sha256))
}

foreach ($asset in @($base, $source)) {
    $label = Split-Path -Leaf $asset.url
    $target = Join-Path $directory ($asset.sha256 + '.tar.gz')
    $partial = $target + '.part'
    if (Test-PinnedArchive $target $asset) {
        Write-Host "Verified cached $label"
        continue
    }
    $verified = Test-PinnedArchive $partial $asset
    for ($attempt = 1; $attempt -le 4 -and -not $verified; $attempt++) {
        if ((Test-Path -LiteralPath $partial) -and ((Get-Item -LiteralPath $partial).Length -ge $asset.size)) {
            Remove-Item -LiteralPath $partial
        }
        Write-Host "Downloading $label (attempt $attempt/4)"
        & curl.exe --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --speed-limit 1024 --speed-time 45 --continue-at - --output $partial $asset.url
        $status = $LASTEXITCODE
        $verified = Test-PinnedArchive $partial $asset
        if ($verified) { break }
        if ($status -eq 33 -and (Test-Path -LiteralPath $partial)) {
            # A response without range support needs a fresh download.
            Remove-Item -LiteralPath $partial
        }
        if ($attempt -lt 4) { Start-Sleep -Seconds $attempt }
    }
    if (-not $verified) {
        throw "Could not verify $label. Run this script again to retry the download."
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
    Write-Host "Verified $label"
}

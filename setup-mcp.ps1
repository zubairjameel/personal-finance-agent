#!/usr/bin/env pwsh
# setup-mcp.ps1
# Downloads the CockroachDB MCP Server binary for Windows (amd64).
# Run once after cloning: .\setup-mcp.ps1

$version = "0.1.0"
$url = "https://github.com/cockroachdb/cockroachdb-mcp-server/releases/download/v$version/cockroachdb-mcp-server_${version}_windows_amd64.zip"
$zip = "cockroachdb-mcp-server.zip"
$binDir = "bin"

Write-Host "Downloading cockroachdb-mcp-server v$version for Windows..."
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "Extracting..."
Expand-Archive -Path $zip -DestinationPath $binDir -Force
Remove-Item $zip

$exe = Join-Path $binDir "cockroachdb-mcp-server.exe"
if (Test-Path $exe) {
    $v = & $exe -version 2>&1
    Write-Host "OK: $v (at $exe)"
} else {
    Write-Error "Binary not found after extraction."
    exit 1
}

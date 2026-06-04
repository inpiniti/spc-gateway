param(
  [switch]$Fix
)

$ErrorActionPreference = 'SilentlyContinue'

function Invoke-Check {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  & $Action | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] $Name" -ForegroundColor Green
    return $true
  }

  Write-Host "[FAIL] $Name" -ForegroundColor Red
  return $false
}

Write-Host "== SPC Kubernetes Doctor ==" -ForegroundColor Cyan

$dockerOk = Invoke-Check -Name 'Docker engine reachable' -Action { docker version }
$k8sOk = Invoke-Check -Name 'Kubernetes API reachable' -Action { kubectl get --raw=/readyz }
$helmOk = Invoke-Check -Name 'Helm installed' -Action { helm version }

if (-not $dockerOk -or -not $k8sOk) {
  Write-Host "" 
  Write-Host "Diagnosis: Docker backend is down, so Kubernetes API is down too." -ForegroundColor Yellow

  if ($Fix) {
    Write-Host "Auto-fix: launch Docker Desktop app" -ForegroundColor Yellow
    $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exe) {
      Start-Process $exe
      Write-Host "Docker Desktop launch requested" -ForegroundColor Yellow
    } else {
      Write-Host "Docker Desktop executable not found: $exe" -ForegroundColor Red
    }

    Write-Host "Try service start with elevation (UAC may appear)" -ForegroundColor Yellow
    Start-Process PowerShell -Verb RunAs -ArgumentList '-NoProfile -Command "Start-Service com.docker.service"'

    Write-Host "" 
    Write-Host "Recheck after 30-90 seconds" -ForegroundColor Cyan
    Write-Host "  kubectl get nodes"
    Write-Host "  kubectl get pods -A"
  }
}

if (-not $helmOk) {
  Write-Host "" 
  Write-Host "Helm not installed. Install with:" -ForegroundColor Yellow
  Write-Host "  winget install --id Helm.Helm -e"
}

Write-Host "" 
Write-Host "Lens checklist" -ForegroundColor Cyan
Write-Host "  1) kubeconfig context: docker-desktop"
Write-Host "  2) kubectl get nodes must succeed"
Write-Host "  3) Lens namespace filter"

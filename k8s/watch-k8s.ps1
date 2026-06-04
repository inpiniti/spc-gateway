param(
  [int]$IntervalSec = 20
)

$dockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$startedOnce = $false

function Test-DockerEngine {
  docker version | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Test-K8sApi {
  kubectl get --raw=/readyz | Out-Null
  return ($LASTEXITCODE -eq 0)
}

Write-Host "Watching Docker/Kubernetes. Press Ctrl+C to stop." -ForegroundColor Cyan

while ($true) {
  $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $dockerOk = Test-DockerEngine
  $k8sOk = Test-K8sApi

  if ($dockerOk -and $k8sOk) {
    Write-Host "[$now] OK Docker + K8s" -ForegroundColor Green
    $startedOnce = $false
  } else {
    Write-Host "[$now] DOWN Docker=$dockerOk K8s=$k8sOk" -ForegroundColor Yellow

    if (-not $startedOnce -and (Test-Path $dockerExe)) {
      Start-Process $dockerExe
      $startedOnce = $true
      Write-Host "[$now] Recovery: Docker Desktop launch requested" -ForegroundColor Yellow
    }
  }

  Start-Sleep -Seconds $IntervalSec
}

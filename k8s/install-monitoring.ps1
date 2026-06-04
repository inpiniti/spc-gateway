$ErrorActionPreference = 'Stop'

Write-Host "== Install kube-prometheus-stack ==" -ForegroundColor Cyan

$valuesFile = Join-Path $PSScriptRoot 'kube-prometheus-values.yaml'
if (-not (Test-Path $valuesFile)) {
  throw "values file missing: $valuesFile"
}

kubectl get --raw=/readyz | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Kubernetes API unreachable. Run k8s-doctor.ps1 -Fix first.'
}

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts | Out-Null
helm repo update | Out-Null

helm upgrade --install spc-monitor prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace --values $valuesFile

Write-Host "" 
Write-Host "Check status" -ForegroundColor Green
Write-Host "  kubectl get pods -n monitoring"
Write-Host "  kubectl get svc -n monitoring"
Write-Host "" 
Write-Host "Access" -ForegroundColor Green
Write-Host "  Grafana   http://localhost:32300"
Write-Host "  Prometheus http://localhost:32090"
Write-Host "  ID/PW admin / admin1234"

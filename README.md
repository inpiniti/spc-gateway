# spc-gateway

SPC IoT 장비를 위한 IECP 프로토콜 기반 TCP 게이트웨이.

## 실행

```bash
node index.js
```

## 포트

| 포트 | 용도 |
|------|------|
| 5070 | TCP (IECP 장비 연결) |
| 3001 | HTTP API |

## HTTP API

- `GET /api/devices` — 연결된 장비 목록 + 최신 상태
- `GET /api/history?deviceId=SPC0001` — 수신 이력 (최근 100건)
- `POST /api/clear` — 데이터 초기화

## 데이터

수신 데이터는 `db.json`에 누적 저장.

## Kubernetes 점검 및 모니터링

Docker Desktop Kubernetes 환경에서 클러스터가 내려갔는지 점검하고 복구/설치하는 스크립트.

1) 진단

PowerShell에서 프로젝트 루트 기준:

	powershell -ExecutionPolicy Bypass -File .\k8s\k8s-doctor.ps1

2) 자동 복구 시도 (Docker Desktop 실행 + 서비스 시작 요청)

	powershell -ExecutionPolicy Bypass -File .\k8s\k8s-doctor.ps1 -Fix

3) kube-prometheus-stack 설치

	powershell -ExecutionPolicy Bypass -File .\k8s\install-monitoring.ps1

4) 지속 감시 (다운 시 Docker Desktop 자동 실행 요청)

	powershell -ExecutionPolicy Bypass -File .\k8s\watch-k8s.ps1 -IntervalSec 20

접속 URL

- Grafana: http://localhost:32300
- Prometheus: http://localhost:32090
- Grafana 계정: admin / admin1234

# spc-gateway

SPC IoT 장비를 위한 IECP 프로토콜 기반 TCP 게이트웨이.
장비(TCP/IECP) ↔ spc-api(HTTP/JSON) 사이를 중계한다.

## 실행

```bash
node index.js
```

환경변수는 `.env.example` 참고. (이 프로젝트는 dotenv 를 쓰지 않으므로 OS 환경변수/도커로 주입)

## 포트

| 포트 | 용도 |
|------|------|
| 5070 | TCP (IECP 장비 연결) |
| 3001 | HTTP API (로컬 조회/디버그) |

## 책임 분담 (데이터 흐름)

| IECP | 처리 |
|------|------|
| **700** 정주기 | Gateway 가 `device_data` 에 **직접 INSERT** (API 미경유, v8 컬럼 매핑) |
| **701** 알람 | `POST /api/v1/gateway/alarms` 로 **API 경유** (KST→ISO 변환 후) |
| 접속/해제 | `POST /api/v1/gateway/device-status` (online/offline) |
| **300/501/502/503/800** 제어 | API 명령 큐를 **polling** → 장비 dial-in 시 전송 → 결과 `PATCH /commands/:id/result` 보고 |
| **503** 응답 | 1460B(365개) 분할 재조립 후 `POST /api/v1/gateway/annual-pressure` |

- 모든 API 호출에는 `X-Gateway-Key` 헤더가 붙는다 (`GATEWAY_KEY`).
- 14자리 KST(YYYYMMDDHHmmss) ↔ ISO 8601 양방향 변환은 Gateway 책임 (`kst.js`).

## 모듈

| 파일 | 역할 |
|------|------|
| `index.js` | TCP 서버 + 명령 polling 루프 + HTTP |
| `frames.js` | IECP 프레임 파싱/빌드 (300/501/502/503/800/ACK) |
| `apiClient.js` | spc-api 호출 (X-Gateway-Key) |
| `kst.js` | KST ↔ ISO 변환 |
| `schema.sql` | PostgreSQL 스키마 (v8 정렬, 부팅 시 적용) |

## HTTP API (로컬 디버그)

- `GET /api/devices` — 연결된 장비 목록 + 최신 상태(db.json)
- `GET /api/history?deviceId=SE60001` — 수신 이력 (최근 100건)
- `GET /api/sessions` — 현재 TCP 접속/대기명령 장비 목록
- `POST /api/devices/:deviceId/control` — 디버그용 직접 제어(접속 중일 때만)
- `POST /api/clear` — db.json 초기화

## 데이터

700/701 수신 캐시는 `db.json`에 누적(로컬 조회용). 영속 저장은 PostgreSQL/spc-api.

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

// ── spc-api 호출 클라이언트 ───────────────────────────────────────────────────
// Gateway 가 API 서버(/api/v1/gateway/*)를 호출할 때 사용. 모든 요청에
// X-Gateway-Key 헤더를 붙인다. (일반 사용자 JWT 와 분리된 게이트웨이 전용 인증)
const http = require('http');
const https = require('https');
const { URL } = require('url');

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api/v1';
const GATEWAY_KEY = process.env.GATEWAY_KEY || 'gw_secret_key_change_me';
const GATEWAY_ID = process.env.GATEWAY_ID || 'gw-local-01';

function request(method, path, body, query) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE_URL.replace(/\/$/, '') + path);
    if (query) {
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      });
    }
    const payload = body == null ? null : JSON.stringify(body);
    const headers = { 'X-Gateway-Key': GATEWAY_KEY };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ status: res.statusCode, data: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 대기 명령 polling (pending → sent). 반환: 명령 배열
async function pollCommands(limit = 10) {
  const r = await request('GET', '/gateway/commands/poll', null, { gatewayId: GATEWAY_ID, limit, wait: 0 });
  if (r.status === 200 && r.data && r.data.success) return r.data.data || [];
  throw new Error(`poll 실패 status=${r.status} ${JSON.stringify(r.data)}`);
}

// 명령 실행 결과 보고 (sent → acked/failed)
function reportResult(commandId, { status, resultCode, resultMessage, respondedAt }) {
  return request('PATCH', `/gateway/commands/${commandId}/result`, {
    status, resultCode, resultMessage, respondedAt: respondedAt || new Date().toISOString(),
  });
}

// 알람(701) 수신 보고
function postAlarm({ deviceId, alarmDatetime, alarmType, alarmCode, branchId }) {
  return request('POST', '/gateway/alarms', { deviceId, alarmDatetime, alarmType, alarmCode, branchId });
}

// 장비 접속/해제 상태 보고
function postDeviceStatus({ deviceId, status, ip, timestamp }) {
  return request('POST', '/gateway/device-status', {
    deviceId, status, gatewayId: GATEWAY_ID, ip, timestamp: timestamp || new Date().toISOString(),
  });
}

// 연간 압력 업로드 수신(503 응답, 365개) 보고
function postAnnualPressure({ deviceId, year, pressures }) {
  return request('POST', '/gateway/annual-pressure', { deviceId, year, pressures });
}

module.exports = {
  API_BASE_URL, GATEWAY_KEY, GATEWAY_ID,
  request, pollCommands, reportResult, postAlarm, postDeviceStatus, postAnnualPressure,
};

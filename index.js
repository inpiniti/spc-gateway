const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const api = require('./apiClient');
const { kstToIso } = require('./kst');
const {
  parseFrame, buildControlFrame, buildJsonCommandFrame,
  buildAnnualDownloadFrame, buildAnnualRequestFrame, decodeAnnualPressures, buildAck,
} = require('./frames');

const TCP_PORT = parseInt(process.env.TCP_PORT || '5070', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3001', 10);
const DB_PATH = path.join(__dirname, 'db.json');
const CSV_DIR = path.join(__dirname, 'csv');
const CSV_ENABLED = process.env.CSV_ENABLED === 'true';

// 명령 큐 polling 주기 / 결과 응답 대기 한계
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const POLL_LIMIT = parseInt(process.env.POLL_LIMIT || '10', 10);
const RESULT_TIMEOUT_MS = parseInt(process.env.RESULT_TIMEOUT_MS || '30000', 10);

// 700 정주기 데이터는 설계상 Gateway 가 DB 에 직접 INSERT (API 미경유)
const PG_ENABLED = process.env.PG_ENABLED !== 'false';
const pgPool = PG_ENABLED
  ? new Pool({
      host: process.env.PGHOST || '127.0.0.1',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'spcdb',
      user: process.env.PGUSER || 'spc',
      password: process.env.PGPASSWORD || '1234',
    })
  : null;
let pgReady = false;

if (CSV_ENABLED && !fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR, { recursive: true });

function logInfo(message) { console.log(`[GW] ${message}`); }
function logFrame(direction, deviceId, functionCode, pageId, message, extra = '') {
  const prefix = `[${direction}] ${deviceId || '-'} FC=${functionCode || '-'} PG=${pageId || '-'} ${message}`;
  console.log(extra ? `${prefix} ${extra}` : prefix);
}
function logRaw(label, buf) {
  const hex = buf.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
  console.log(`[GW] ${label} raw=${buf.toString('utf8')} hex=${hex}`);
}

// ── 로컬 db.json (HTTP 조회용 캐시) ───────────────────────────────────────────
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { devices: {}, history: [], alarms: [], commands: [] }; }
}
function saveDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// ── CSV (옵션) ────────────────────────────────────────────────────────────────
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}
function appendToCsv(filename, headers, data) {
  if (!CSV_ENABLED) return;
  const filepath = path.join(CSV_DIR, filename);
  if (!fs.existsSync(filepath)) fs.writeFileSync(filepath, headers.map(escapeCsv).join(',') + '\n');
  fs.appendFileSync(filepath, headers.map((h) => escapeCsv(data[h])).join(',') + '\n');
}

async function initPostgres() {
  if (!pgPool) { logInfo('PostgreSQL 저장 비활성화 (PG_ENABLED=false)'); return; }
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pgPool.query(schemaSql);
    pgReady = true;
    logInfo('PostgreSQL 스키마 적용 완료 (schema.sql)');
  } catch (err) {
    pgReady = false;
    console.error('[PG] 초기화 실패:', err.message);
  }
}

// ── 700 정주기 데이터 → device_data 직접 INSERT (v8 컬럼 매핑) ─────────────────
async function saveDeviceDataToPostgres(row) {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO device_data (
         device_id, device_type, status_datetime, received_at,
         pressure, temperature, battery_voltage, rssi,
         operation_status, operation_mode, calc_pressure, prev_pressure,
         init_pressure, set_pressure, control_action,
         remain_minutes, remain_seconds, motor_position, status_code, status, raw_payload
       ) VALUES (
         $1,$2,$3,$4, $5,$6,$7,$8, $9,$10,$11,$12, $13,$14,$15, $16,$17,$18,$19,$20,$21
       )`,
      [
        row.device_id, row.device_type, row.status_datetime, row.received_at,
        row.pressure, row.temperature, row.battery_voltage, row.rssi,
        row.operation_status, row.operation_mode, row.calc_pressure, row.prev_pressure,
        row.init_pressure, row.set_pressure, row.control_action,
        row.remain_minutes, row.remain_seconds, row.motor_position,
        row.status_code, row.status, row.raw_payload,
      ],
    );
  } catch (err) {
    console.error('[PG] device_data 저장 실패:', err.message);
  }
}

// IECP 700 페이로드 → v8 device_data row 매핑
function mapPage700ToDeviceData(deviceId, payload, receivedAtIso) {
  return {
    device_id: deviceId,
    device_type: 'governor',                         // 700 전체 페이지 = 정압기
    status_datetime: payload.statusDatetime || null,  // KST 14자리 원본 보존
    received_at: receivedAtIso,
    pressure: payload.PTcur,
    temperature: payload.temperature ?? null,
    battery_voltage: payload.batteryVoltage ?? null,
    rssi: payload.rssi ?? null,
    operation_status: payload.operationStatus,
    operation_mode: payload.operationMode ?? null,
    calc_pressure: payload.PEcur,
    prev_pressure: payload.PTb ?? null,
    init_pressure: payload.Pcon_init ?? null,
    set_pressure: payload.Pcon,
    control_action: payload.moterAction ?? null,
    remain_minutes: payload.remainTimeMinutes ?? null,
    remain_seconds: payload.remainTimeSeconds ?? null,
    motor_position: payload.motorPosition ?? null,
    status_code: payload.statusCode ?? null,
    status: payload.status || 'normal',
    raw_payload: JSON.stringify(payload),
  };
}

// ── 명령 큐 상태 ──────────────────────────────────────────────────────────────
const sessions = new Map();          // deviceId → socket
const pendingByDevice = new Map();   // deviceId → [command] (장비 미접속 시 대기)
const awaitingByTx = new Map();      // transactionId(str) → { commandId, deviceId, functionCode, timer }
const annual503 = new Map();         // deviceId → { commandId, year, frags: Map<seq,Buffer>, size }

function queueForDevice(deviceId, cmd) {
  if (!pendingByDevice.has(deviceId)) pendingByDevice.set(deviceId, []);
  pendingByDevice.get(deviceId).push(cmd);
}

function buildCommandFrame(cmd) {
  const common = { deviceId: cmd.deviceId, transactionId: cmd.transactionId, payload: cmd.payload };
  switch (cmd.functionCode) {
    case '300': return buildControlFrame(common);
    case '501':
    case '800': return buildJsonCommandFrame({ ...common, functionCode: cmd.functionCode });
    case '502': return buildAnnualDownloadFrame({ deviceId: cmd.deviceId, transactionId: cmd.transactionId, pressures: (cmd.payload && cmd.payload.pressures) || [] });
    case '503': return buildAnnualRequestFrame(common);
    default:    return buildJsonCommandFrame({ ...common, functionCode: cmd.functionCode });
  }
}

// 명령을 장비 소켓으로 전송하고 결과 추적을 등록한다.
function sendCommand(cmd, socket) {
  const did = cmd.deviceId;
  try {
    const frame = buildCommandFrame(cmd);
    socket.write(frame);
    logFrame('TX', did, cmd.functionCode, '00', '명령 전송', `cmdId=${cmd.commandId} tx=${cmd.transactionId}`);
    logRaw('TX command frame', frame);

    if (cmd.functionCode === '503') {
      // 503 은 장비가 1460B 응답을 보내면 그때 결과 보고. 응답 대기 상태만 등록.
      annual503.set(did, { commandId: cmd.commandId, year: (cmd.payload && cmd.payload.year) || new Date().getFullYear(), frags: new Map(), size: 1 });
      return;
    }

    // 그 외: 장비 응답(같은 tx) 수신 시 결과 보고. 미응답 시 전송완료로 fallback.
    const txKey = String(cmd.transactionId);
    const timer = setTimeout(() => {
      if (awaitingByTx.has(txKey)) {
        awaitingByTx.delete(txKey);
        void api.reportResult(cmd.commandId, { status: 'acked', resultCode: 200, resultMessage: 'delivered (no device response)' })
          .catch((e) => console.error('[API] result 보고 실패:', e.message));
      }
    }, RESULT_TIMEOUT_MS);
    awaitingByTx.set(txKey, { commandId: cmd.commandId, deviceId: did, functionCode: cmd.functionCode, timer });
  } catch (e) {
    console.error('[GW] 명령 전송 실패:', e.message);
    void api.reportResult(cmd.commandId, { status: 'failed', resultCode: 500, resultMessage: e.message })
      .catch((err) => console.error('[API] result 보고 실패:', err.message));
  }
}

// 장비 접속 시 대기 명령 flush
function flushPending(deviceId, socket) {
  const list = pendingByDevice.get(deviceId);
  if (!list || list.length === 0) return;
  pendingByDevice.set(deviceId, []);
  logFrame('GW', deviceId, '-', '-', '대기 명령 flush', `count=${list.length}`);
  for (const cmd of list) sendCommand(cmd, socket);
}

// ── 명령 polling 루프 ─────────────────────────────────────────────────────────
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const commands = await api.pollCommands(POLL_LIMIT);
    for (const cmd of commands) {
      const did = String(cmd.deviceId || '').trim();
      const socket = sessions.get(did);
      const norm = { ...cmd, deviceId: did };
      if (socket) sendCommand(norm, socket);
      else { queueForDevice(did, norm); logFrame('GW', did, cmd.functionCode, '-', '명령 대기(장비 미접속)', `cmdId=${cmd.commandId}`); }
    }
  } catch (e) {
    // API 미기동 등은 조용히 재시도 (소음 방지)
    if (!/ECONNREFUSED/.test(e.message)) console.error('[API] poll 오류:', e.message);
  } finally {
    polling = false;
  }
}

// 장비 응답 프레임으로 명령 결과 해소
function resolveCommandResult(frame) {
  const txKey = frame.transactionId;
  const awaiting = awaitingByTx.get(txKey);
  if (!awaiting) return false;
  clearTimeout(awaiting.timer);
  awaitingByTx.delete(txKey);
  let code = parseInt(frame.data.slice(0, 3).toString(), 10);
  if (Number.isNaN(code)) code = 200;
  const ok = code >= 200 && code < 300;
  void api.reportResult(awaiting.commandId, {
    status: ok ? 'acked' : 'failed', resultCode: code, resultMessage: ok ? 'ok' : 'device error',
  }).catch((e) => console.error('[API] result 보고 실패:', e.message));
  logFrame('GW', frame.deviceId, frame.functionCode, frame.pageId, '명령 결과 보고', `cmdId=${awaiting.commandId} code=${code}`);
  return true;
}

// 503 응답(분할 가능) 재조립 → 완료 시 API 로 연간압력 업로드
async function handle503Response(frame) {
  const did = frame.deviceId;
  const ctx = annual503.get(did);
  if (!ctx) { logFrame('RX', did, '503', frame.pageId, '503 응답 수신했으나 요청 컨텍스트 없음'); return; }
  ctx.size = frame.transactionSize || 1;
  ctx.frags.set(frame.transactionSeq || 1, Buffer.from(frame.data));
  logFrame('RX', did, '503', frame.pageId, '연간압력 조각 수신', `seq=${frame.transactionSeq}/${ctx.size}`);
  if (ctx.frags.size < ctx.size) return; // 더 받을 조각 있음

  // 모든 조각 수신 → seq 순서로 결합
  const ordered = [];
  for (let i = 1; i <= ctx.size; i++) ordered.push(ctx.frags.get(i) || Buffer.alloc(0));
  const pressures = decodeAnnualPressures(Buffer.concat(ordered));
  annual503.delete(did);

  try {
    await api.postAnnualPressure({ deviceId: did, year: ctx.year, pressures });
    await api.reportResult(ctx.commandId, { status: 'acked', resultCode: 200, resultMessage: `uploaded ${pressures.length}` });
    logFrame('GW', did, '503', frame.pageId, '연간압력 업로드 완료', `count=${pressures.length}`);
  } catch (e) {
    await api.reportResult(ctx.commandId, { status: 'failed', resultCode: 500, resultMessage: e.message }).catch(() => {});
    console.error('[API] 연간압력 업로드 실패:', e.message);
  }
}

// ── TCP 서버 ──────────────────────────────────────────────────────────────────
const tcpServer = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let deviceId = null;
  const remoteIp = socket.remoteAddress;
  console.log(`[TCP] 새 연결 ${remoteIp}:${socket.remotePort}`);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const start = buffer.indexOf(0x40);
      if (start === -1) { buffer = Buffer.alloc(0); break; }
      if (start > 0) buffer = buffer.slice(start);
      const end = buffer.indexOf(0x21, 1);
      if (end === -1) break;
      const frameBuf = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);

      try {
        const frame = parseFrame(frameBuf);
        const firstFrameForSession = !deviceId;
        deviceId = frame.deviceId;
        sessions.set(deviceId, socket);

        logFrame('RX', deviceId, frame.functionCode, frame.pageId, '프레임 수신',
          `tx=${frame.transactionId} reqType=${frame.requestType} addr=${frame.addressType} csum=${frame.checksumOk}`);
        logRaw('RX frame', frameBuf);

        // 장비 dial-in: 첫 프레임에서 접속 상태 보고 + 대기 명령 flush
        if (firstFrameForSession) {
          void api.postDeviceStatus({ deviceId, status: 'online', ip: remoteIp })
            .catch((e) => console.error('[API] device-status(online) 실패:', e.message));
          flushPending(deviceId, socket);
        }

        // 이전에 보낸 명령에 대한 장비 응답이면 결과 보고 후 종료
        if (frame.requestType === '3' && resolveCommandResult(frame)) {
          continue;
        }

        let payload = null;
        if (frame.addressType === 'J' && frame.dataLength > 0) {
          try { payload = JSON.parse(frame.data.toString('utf8')); }
          catch (e) { console.warn('JSON parse error:', e.message); }
        }

        const db = loadDb();

        if (frame.functionCode === '700' && payload) {
          const receivedAt = new Date().toISOString();
          db.history.push({ deviceId, ...payload, receivedAt });
          if (db.history.length > 2000) db.history = db.history.slice(-2000);
          if (!db.devices[deviceId]) db.devices[deviceId] = { device_id: deviceId, created_at: receivedAt };
          Object.assign(db.devices[deviceId], { ...payload, connected: true, last_status_datetime: receivedAt });
          saveDb(db);

          const row = mapPage700ToDeviceData(deviceId, payload, receivedAt);
          appendToCsv('device_data.csv', Object.keys(row), row);
          void saveDeviceDataToPostgres(row);
          logFrame('RX', deviceId, '700', frame.pageId, 'Page700 저장완료',
            `pressure=${row.pressure} op=${row.operation_status} ${pgReady ? 'pg-on' : 'pg-off'}`);

        } else if (frame.functionCode === '701' && payload) {
          const receivedAt = new Date().toISOString();
          db.alarms = db.alarms || [];
          db.alarms.push({ deviceId, ...payload, receivedAt });
          if (db.alarms.length > 5000) db.alarms = db.alarms.slice(-5000);
          saveDb(db);

          // 701 알람은 API 경유 (DB 직접 INSERT 아님) — KST→ISO 변환 후 전달
          void api.postAlarm({
            deviceId,
            alarmDatetime: kstToIso(payload.alarmDatetime) || new Date().toISOString(),
            alarmType: payload.alarmType,
            alarmCode: payload.alarmCode,
            branchId: payload.branchId,
          }).then((r) => logFrame('GW', deviceId, '701', frame.pageId, '알람 API 전달', `status=${r.status}`))
            .catch((e) => console.error('[API] 알람 전달 실패:', e.message));

        } else if (frame.functionCode === '503') {
          void handle503Response(frame);
        } else if (frame.functionCode === '103') {
          logFrame('RX', deviceId, frame.functionCode, frame.pageId, 'Ping');
        } else {
          logFrame('RX', deviceId, frame.functionCode, frame.pageId, '기타 프레임', `csum=${frame.checksumOk}`);
        }

        // 장비가 응답을 요구(requestType=1)하면 ACK
        if (frame.requestType === '1') {
          socket.write(buildAck(frameBuf, 200));
          logFrame('TX', deviceId, frame.functionCode, frame.pageId, 'ACK 송신');
        }
      } catch (e) {
        console.error('[TCP] 파싱 오류:', e.message);
      }
    }
  });

  socket.on('close', () => {
    if (deviceId) {
      sessions.delete(deviceId);
      logFrame('TCP', deviceId, '-', '-', '연결 종료');
      void api.postDeviceStatus({ deviceId, status: 'offline', ip: remoteIp })
        .catch((e) => console.error('[API] device-status(offline) 실패:', e.message));
      const db = loadDb();
      if (db.devices[deviceId]) { db.devices[deviceId].connected = false; saveDb(db); }
    }
  });

  socket.on('error', (e) => console.error('[TCP] 소켓 오류:', e.message));
});

tcpServer.listen(TCP_PORT, () => logInfo(`TCP Gateway listening on :${TCP_PORT}`));

// ── HTTP API (로컬 조회/디버그) ───────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end('{}'); return; }

  const url = new URL(req.url, 'http://localhost');
  const db = loadDb();

  if (url.pathname === '/api/history' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    const list = deviceId ? db.history.filter((h) => h.deviceId === deviceId) : db.history;
    res.end(JSON.stringify(list.slice(-100)));
  } else if (url.pathname === '/api/devices' && req.method === 'GET') {
    res.end(JSON.stringify(db.devices));
  } else if (url.pathname === '/api/sessions' && req.method === 'GET') {
    res.end(JSON.stringify({ connected: [...sessions.keys()], pending: [...pendingByDevice.keys()] }));
  } else if (url.pathname.match(/^\/api\/devices\/([^/]+)\/control$/) && req.method === 'POST') {
    // 디버그용 직접 제어: 장비가 접속 중일 때 즉시 300 전송 (정식 경로는 API 명령 큐)
    const did = url.pathname.match(/^\/api\/devices\/([^/]+)\/control$/)[1];
    const body = await parseBody(req);
    const operation = body.operation;
    if (!operation || !['1', '2'].includes(operation)) {
      res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid operation' })); return;
    }
    const socket = sessions.get(did);
    if (!socket) { res.statusCode = 404; res.end(JSON.stringify({ error: 'device not connected' })); return; }
    sendCommand({ commandId: 0, deviceId: did, functionCode: '300', transactionId: Math.floor(Math.random() * 10000), payload: { requestType: '00', operation } }, socket);
    res.end(JSON.stringify({ ok: true, message: `제어 전송(디버그): operation=${operation}` }));
  } else if (url.pathname === '/api/clear' && req.method === 'POST') {
    saveDb({ devices: {}, history: [], alarms: [], commands: [] });
    res.end('{"ok":true}');
  } else {
    res.statusCode = 404; res.end('{"error":"not found"}');
  }
});

initPostgres().finally(() => {
  httpServer.listen(HTTP_PORT, () => logInfo(`HTTP API listening on :${HTTP_PORT}`));
  setInterval(pollOnce, POLL_INTERVAL_MS);
  logInfo(`명령 큐 polling 시작 (interval=${POLL_INTERVAL_MS}ms, API=${api.API_BASE_URL})`);
});

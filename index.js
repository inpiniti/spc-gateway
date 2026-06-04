const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const TCP_PORT = parseInt(process.env.TCP_PORT || '5070', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3001', 10);
const DB_PATH = path.join(__dirname, 'db.json');
const CSV_DIR = path.join(__dirname, 'csv');
const CSV_ENABLED = process.env.CSV_ENABLED === 'true';

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

// CSV는 기본 비활성화, 필요 시에만 활성화
if (CSV_ENABLED && !fs.existsSync(CSV_DIR))
  fs.mkdirSync(CSV_DIR, { recursive: true });

function logInfo(message) {
  console.log(`[GW] ${message}`);
}

function logFrame(
  direction,
  deviceId,
  functionCode,
  pageId,
  message,
  extra = '',
) {
  const prefix = `[${direction}] ${deviceId || '-'} FC=${functionCode || '-'} PG=${pageId || '-'} ${message}`;
  console.log(extra ? `${prefix} ${extra}` : prefix);
}

function logRaw(label, buf) {
  const hex =
    buf
      .toString('hex')
      .match(/.{1,2}/g)
      ?.join(' ') || '';
  console.log(`[GW] ${label} raw=${buf.toString('utf8')} hex=${hex}`);
}

// ── DB ──────────────────────────────────────────────────────────────────────
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { devices: {}, history: [], alarms: [], commands: [] };
  }
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── CSV 저장 함수 ───────────────────────────────────────────────────────────
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function appendToCsv(filename, headers, data) {
  if (!CSV_ENABLED) return;

  const filepath = path.join(CSV_DIR, filename);
  const fileExists = fs.existsSync(filepath);

  if (!fileExists) {
    const headerRow = headers.map(escapeCsv).join(',') + '\n';
    fs.writeFileSync(filepath, headerRow);
  }

  const dataRow = headers.map((h) => escapeCsv(data[h])).join(',') + '\n';
  fs.appendFileSync(filepath, dataRow);
}

async function initPostgres() {
  if (!pgPool) {
    logInfo('PostgreSQL 저장 비활성화 (PG_ENABLED=false)');
    return;
  }

  try {
    // 전체 스키마는 schema.sql 한 파일에서 관리 (재실행 안전).
    const schemaSql = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf8',
    );
    await pgPool.query(schemaSql);

    pgReady = true;
    logInfo('PostgreSQL 스키마 적용 완료 (schema.sql)');
  } catch (err) {
    pgReady = false;
    console.error('[PG] 초기화 실패:', err.message);
  }
}

// Page 700 수신 시 device 마스터 upsert (deviceId = siteKey(2)+type(1)+deviceKey(4))
async function upsertDevice(deviceId, payload, receivedAt) {
  if (!pgReady || !pgPool) return;
  const siteKey = deviceId.slice(0, 2);
  const type = deviceId.slice(2, 3);
  const deviceKey = deviceId.slice(3, 7);
  try {
    logFrame(
      'PG',
      deviceId,
      '700',
      '00',
      'device upsert 시작',
      `siteKey=${siteKey} type=${type} key=${deviceKey}`,
    );
    await pgPool.query(
      `INSERT INTO device (
         device_id, site_key, type, device_key, connected,
         last_status_datetime, last_pt_cur, last_p_con, last_pe_cur,
         last_operation_status, last_operation, last_status_code, updated_at
       ) VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (device_id) DO UPDATE SET
         connected = true,
         last_status_datetime = EXCLUDED.last_status_datetime,
         last_pt_cur = EXCLUDED.last_pt_cur,
         last_p_con = EXCLUDED.last_p_con,
         last_pe_cur = EXCLUDED.last_pe_cur,
         last_operation_status = EXCLUDED.last_operation_status,
         last_operation = EXCLUDED.last_operation,
         last_status_code = EXCLUDED.last_status_code,
         updated_at = now()`,
      [
        deviceId,
        siteKey,
        type,
        deviceKey,
        receivedAt,
        payload.PTcur,
        payload.Pcon,
        payload.PEcur,
        payload.operationStatus,
        payload.operation,
        payload.statusCode,
      ],
    );
  } catch (err) {
    console.error('[PG] device upsert 실패:', err.message);
  }
}

async function setDeviceDisconnected(deviceId) {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query(
      'UPDATE device SET connected = false, updated_at = now() WHERE device_id = $1',
      [deviceId],
    );
    logFrame('PG', deviceId, '-', '-', 'device disconnected');
  } catch (err) {
    console.error('[PG] device disconnect 갱신 실패:', err.message);
  }
}

async function saveDataToPostgres(row) {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO device_data (
        device_id, status_datetime, received_at, pt_cur, pt_b, pt_b_datetime,
        p_con, p_con_datetime, p_con_init, pe_cur,
        operation_status, operation, remain_time_minutes, remain_time_seconds,
        status_code, data_cycle, data_cycle_unit, network_cycle, network_cycle_unit,
        moter_up, moter_down, moter_action, operation_mode
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, $19,
        $20, $21, $22, $23
      )`,
      [
        row.device_id,
        row.status_datetime,
        row.received_at,
        row.pt_cur,
        row.pt_b,
        row.pt_b_datetime,
        row.p_con,
        row.p_con_datetime,
        row.p_con_init,
        row.pe_cur,
        row.operation_status,
        row.operation,
        row.remain_time_minutes,
        row.remain_time_seconds,
        row.status_code,
        row.data_cycle,
        row.data_cycle_unit,
        row.network_cycle,
        row.network_cycle_unit,
        row.moter_up,
        row.moter_down,
        row.moter_action,
        row.operation_mode,
      ],
    );
  } catch (err) {
    console.error('[PG] device_data 저장 실패:', err.message);
  }
}

async function saveAlarmToPostgres(row) {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO device_alarm (device_id, alarm_datetime, alarm_type, alarm_code, received_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        row.device_id,
        row.alarm_datetime,
        row.alarm_type,
        row.alarm_code,
        row.received_at,
      ],
    );
  } catch (err) {
    console.error('[PG] device_alarm 저장 실패:', err.message);
  }
}

async function saveCommandToPostgres(row) {
  if (!pgReady || !pgPool) return;
  try {
    await pgPool.query(
      `INSERT INTO device_command (device_id, function_code, operation, sent_at, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        row.device_id,
        row.function_code,
        row.operation,
        row.sent_at,
        row.status,
      ],
    );
  } catch (err) {
    console.error('[PG] device_command 저장 실패:', err.message);
  }
}

// ── IECP 체크섬 ──────────────────────────────────────────────────────────────
function calcChecksum(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i];
  return ('0000' + (sum % 10000)).slice(-4);
}

// ── 프레임 파싱 ──────────────────────────────────────────────────────────────
function parseFrame(buf) {
  if (buf[0] !== 0x40) throw new Error('Bad STX');
  if (buf[buf.length - 1] !== 0x21) throw new Error('Bad ETX');

  const requestType = buf.slice(8, 9).toString();
  const serviceId = buf.slice(10, 14).toString();
  const deviceId = buf.slice(14, 22).toString().trimEnd();
  const functionCode = buf.slice(22, 25).toString();
  const pageId = buf.slice(25, 27).toString();
  const addressType = buf.slice(27, 28).toString();
  const dataLength = parseInt(buf.slice(31, 34).toString(), 10);

  const data = buf.slice(34, 34 + dataLength);
  const checksumPos = 34 + dataLength;
  const checksum = buf.slice(checksumPos, checksumPos + 4).toString();
  const expected = calcChecksum(buf, 10, checksumPos);

  return {
    requestType,
    serviceId,
    deviceId,
    functionCode,
    pageId,
    addressType,
    dataLength,
    data,
    checksumOk: checksum === expected,
    rawBuf: buf,
  };
}

// ── IECP 프레임 빌드 (Page 300 제어 명령) ──────────────────────────────────────
let txCounter = 0;
function buildControlFrame({ deviceId, operation }) {
  const requestType = '1'; // Request for response
  const data = Buffer.from('00' + operation, 'utf8'); // requestType(2) + operation(1)
  const dataLength = data.length;
  const txId = (++txCounter % 10000).toString().padStart(4, '0');

  const buf = Buffer.alloc(39 + dataLength);
  let pos = 0;

  buf.write('@', pos++);
  buf.write('T', pos++);
  buf.write(txId, pos);
  pos += 4;
  buf.write('1', pos++); // transactionSize
  buf.write('1', pos++); // transactionSeq
  buf.write(requestType, pos++);
  buf.write('D', pos++); // destination=Device
  buf.write('0000', pos);
  pos += 4; // serviceId
  buf.write(deviceId.slice(0, 7).padEnd(7, ' ') + ' ', pos);
  pos += 8; // deviceId
  buf.write('300', pos);
  pos += 3; // functionCode=300 (제어)
  buf.write('00', pos);
  pos += 2; // pageId=00
  buf.write('J', pos++); // addressType=J
  buf.write('000', pos);
  pos += 3; // address
  buf.write(dataLength.toString().padStart(3, '0'), pos);
  pos += 3;

  data.copy(buf, pos);
  pos += dataLength;

  buf.write(calcChecksum(buf, 10, pos), pos);
  pos += 4;
  buf.write('!', pos);

  logFrame(
    'TX',
    deviceId,
    '300',
    '00',
    'control frame 생성',
    `operation=${operation}`,
  );

  return buf;
}

// ── ACK 응답 빌드 ─────────────────────────────────────────────────────────────
function buildAck(rawBuf, code = 200, message = 'ok') {
  const protocolId = rawBuf.slice(1, 2).toString();
  const transactionId = rawBuf.slice(2, 6).toString();
  const serviceId = rawBuf.slice(10, 14).toString();
  const deviceId = rawBuf.slice(14, 22).toString();
  const functionCode = rawBuf.slice(22, 25).toString();
  const pageId = rawBuf.slice(25, 27).toString();
  const addressType = rawBuf.slice(27, 28).toString();
  const address = rawBuf.slice(28, 31).toString();

  const msg = Buffer.from(message.slice(0, 20).padEnd(20, ' '));
  const msgLen = msg.length;
  // dataLen in response = code(3) + msgLenField(3) + msg
  const totalDataLen = 3 + 3 + msgLen;

  const buf = Buffer.alloc(34 + totalDataLen + 4 + 1);
  let pos = 0;

  buf.write('@', pos++);
  buf.write(protocolId, pos++);
  buf.write(transactionId, pos);
  pos += 4;
  buf.write('1', pos++);
  buf.write('1', pos++);
  buf.write('3', pos++); // requestType = Response
  buf.write('D', pos++); // destination = Device
  buf.write(serviceId, pos);
  pos += 4;
  buf.write(deviceId, pos);
  pos += 8;
  buf.write(functionCode, pos);
  pos += 3;
  buf.write(pageId, pos);
  pos += 2;
  buf.write(addressType, pos++);
  buf.write(address, pos);
  pos += 3;
  buf.write(totalDataLen.toString().padStart(3, '0'), pos);
  pos += 3;

  buf.write(code.toString().padStart(3, '0'), pos);
  pos += 3;
  buf.write(msgLen.toString().padStart(3, '0'), pos);
  pos += 3;
  msg.copy(buf, pos);
  pos += msgLen;

  buf.write(calcChecksum(buf, 10, pos), pos);
  pos += 4;
  buf.write('!', pos);

  logFrame(
    'TX',
    deviceId.trim(),
    functionCode,
    pageId,
    'ACK 송신',
    `code=${code} message=${message}`,
  );

  return buf;
}

// ── TCP 서버 ──────────────────────────────────────────────────────────────────
const sessions = new Map(); // deviceId → socket

const tcpServer = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let deviceId = null;

  console.log(`[TCP] 새 연결 ${socket.remoteAddress}:${socket.remotePort}`);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const start = buffer.indexOf(0x40); // '@'
      if (start === -1) {
        buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) buffer = buffer.slice(start);

      const end = buffer.indexOf(0x21, 1); // '!'
      if (end === -1) break;

      const frameBuf = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);

      try {
        const frame = parseFrame(frameBuf);
        deviceId = frame.deviceId;
        sessions.set(deviceId, socket);

        logFrame(
          'RX',
          deviceId,
          frame.functionCode,
          frame.pageId,
          '프레임 수신',
          `requestType=${frame.requestType} addrType=${frame.addressType} checksumOk=${frame.checksumOk}`,
        );
        logRaw('RX frame', frameBuf);

        const db = loadDb();

        // JSON 페이로드 파싱 (addressType=J)
        let payload = null;
        if (frame.addressType === 'J' && frame.dataLength > 0) {
          try {
            payload = JSON.parse(frame.data.toString('utf8'));
          } catch (e) {
            console.warn('JSON parse error:', e.message);
          }
        }

        if (payload) {
          console.log(
            `[GW] payload ${deviceId} ${frame.functionCode}/${frame.pageId} ${JSON.stringify(payload)}`,
          );
        }

        const tag = `[${deviceId}] FC=${frame.functionCode}`;

        if (frame.functionCode === '700' && payload) {
          const receivedAt = new Date().toISOString();
          const record = { deviceId, ...payload, receivedAt };
          db.history.push(record);
          if (db.history.length > 2000) db.history = db.history.slice(-2000);

          // Device 마스터 갱신
          if (!db.devices[deviceId])
            db.devices[deviceId] = {
              device_id: deviceId,
              created_at: receivedAt,
            };
          Object.assign(db.devices[deviceId], {
            ...payload,
            connected: true,
            last_status_datetime: receivedAt,
            last_pt_cur: payload.PTcur,
            last_p_con: payload.Pcon,
            last_pe_cur: payload.PEcur,
            last_operation_status: payload.operationStatus,
            last_operation: payload.operation,
            last_status_code: payload.statusCode,
          });
          saveDb(db);

          // CSV / PG 저장 (Page 700 전체 필드)
          const csvData = {
            device_id: deviceId,
            status_datetime: payload.statusDatetime,
            received_at: receivedAt,
            pt_cur: payload.PTcur,
            pt_b: payload.PTb,
            pt_b_datetime: payload.PTb_datetime,
            p_con: payload.Pcon,
            p_con_datetime: payload.Pcon_datetime,
            p_con_init: payload.Pcon_init,
            pe_cur: payload.PEcur,
            operation_status: payload.operationStatus,
            operation: payload.operation,
            remain_time_minutes: payload.remainTimeMinutes,
            remain_time_seconds: payload.remainTimeSeconds,
            status_code: payload.statusCode,
            data_cycle: payload.dataCycle,
            data_cycle_unit: payload.dataCycleUnit,
            network_cycle: payload.networkCycle,
            network_cycle_unit: payload.networkCycleUnit,
            moter_up: payload.moterUp,
            moter_down: payload.moterDown,
            moter_action: payload.moterAction,
            operation_mode: payload.operationMode,
          };
          const csvHeaders = Object.keys(csvData);
          appendToCsv('device_data.csv', csvHeaders, csvData);
          void saveDataToPostgres(csvData);
          void upsertDevice(deviceId, payload, receivedAt);

          const pgState = pgReady ? 'pg-on' : 'pg-off';
          logFrame(
            'RX',
            deviceId,
            frame.functionCode,
            frame.pageId,
            'Page700 저장완료',
            `PTcur=${payload.PTcur} Op=${payload.operation} ${pgState}`,
          );
        } else if (frame.functionCode === '701' && payload) {
          const receivedAt = new Date().toISOString();
          if (!db.devices[deviceId])
            db.devices[deviceId] = { device_id: deviceId };
          db.devices[deviceId].lastAlarm = { ...payload, receivedAt };
          db.alarms = db.alarms || [];
          db.alarms.push({ deviceId, ...payload, receivedAt });
          if (db.alarms.length > 5000) db.alarms = db.alarms.slice(-5000);
          saveDb(db);

          // CSV 저장
          const csvData = {
            device_id: deviceId,
            alarm_datetime: payload.alarmDatetime,
            alarm_type: payload.alarmType,
            alarm_code: payload.alarmCode,
            received_at: receivedAt,
          };
          appendToCsv('device_alarm.csv', Object.keys(csvData), csvData);
          void saveAlarmToPostgres(csvData);

          const pgState = pgReady ? 'pg-on' : 'pg-off';
          logFrame(
            'RX',
            deviceId,
            frame.functionCode,
            frame.pageId,
            'Page701 알람 저장완료',
            `type=${payload.alarmType} code=${payload.alarmCode} ${pgState}`,
          );
        } else if (frame.functionCode === '103') {
          logFrame('RX', deviceId, frame.functionCode, frame.pageId, 'Ping');
        } else {
          logFrame(
            'RX',
            deviceId,
            frame.functionCode,
            frame.pageId,
            '기타 프레임',
            `checksumOk=${frame.checksumOk}`,
          );
        }

        // requestType=1 이면 ACK
        if (frame.requestType === '1') {
          logFrame(
            'TX',
            deviceId,
            frame.functionCode,
            frame.pageId,
            'ACK 전송 예정',
            `requestType=${frame.requestType}`,
          );
          socket.write(buildAck(frameBuf, 200));
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
      const db = loadDb();
      if (db.devices[deviceId]) {
        db.devices[deviceId].connected = false;
        saveDb(db);
      }
      void setDeviceDisconnected(deviceId);
    }
  });

  socket.on('error', (e) => console.error('[TCP] 소켓 오류:', e.message));
});

tcpServer.listen(TCP_PORT, () => {
  logInfo(`TCP Gateway listening on :${TCP_PORT}`);
});

// ── HTTP API ─────────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.end('{}');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const db = loadDb();

  if (url.pathname === '/api/history' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    const list = deviceId
      ? db.history.filter((h) => h.deviceId === deviceId)
      : db.history;
    res.end(JSON.stringify(list.slice(-100)));
  } else if (url.pathname === '/api/devices' && req.method === 'GET') {
    res.end(JSON.stringify(db.devices));
  } else if (
    url.pathname.match(/^\/api\/devices\/([^/]+)\/control$/) &&
    req.method === 'POST'
  ) {
    const deviceId = url.pathname.match(
      /^\/api\/devices\/([^/]+)\/control$/,
    )[1];
    const body = await parseBody(req);
    const operation = body.operation; // '1': 운전, '2': 정지

    logFrame(
      'HTTP',
      deviceId,
      '300',
      '00',
      '제어 요청 수신',
      `operation=${operation}`,
    );

    if (!operation || !['1', '2'].includes(operation)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'invalid operation' }));
      return;
    }

    const socket = sessions.get(deviceId);
    if (!socket) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'device not connected' }));
      return;
    }

    try {
      const frame = buildControlFrame({ deviceId, operation });
      socket.write(frame);
      logRaw('TX control frame', frame);

      // 명령 로그 저장
      const commandData = {
        device_id: deviceId,
        function_code: '300',
        operation,
        sent_at: new Date().toISOString(),
        status: 'sent',
      };
      db.commands = db.commands || [];
      db.commands.push(commandData);
      if (db.commands.length > 1000) db.commands = db.commands.slice(-1000);
      saveDb(db);

      // CSV 저장
      appendToCsv(
        'device_command.csv',
        ['device_id', 'function_code', 'operation', 'sent_at', 'status'],
        commandData,
      );
      void saveCommandToPostgres(commandData);

      res.end(
        JSON.stringify({
          ok: true,
          message: `제어 명령 전송: operation=${operation}`,
        }),
      );
      logFrame(
        'HTTP',
        deviceId,
        '300',
        '00',
        '제어 명령 전송 완료',
        `operation=${operation}`,
      );
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (url.pathname === '/api/clear' && req.method === 'POST') {
    saveDb({ devices: {}, history: [], alarms: [], commands: [] });
    res.end('{"ok":true}');
  } else {
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  }
});

initPostgres().finally(() => {
  httpServer.listen(HTTP_PORT, () => {
    logInfo(`HTTP API listening on :${HTTP_PORT}`);
  });
});

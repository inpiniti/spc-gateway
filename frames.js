// ── IECP 프레임 빌드/파싱 ─────────────────────────────────────────────────────
// 프레임 레이아웃 (오프셋):
//  0   STX '@'
//  1   protocolId 'T'
//  2-5 transactionId(4)
//  6   transactionSize(1)
//  7   transactionSeq(1)
//  8   requestType(1)   1=요청(응답요구) / 3=응답
//  9   destination(1)   D=Device / S=Server
//  10-13 serviceId(4)
//  14-21 deviceId(8)    siteKey(2)+type(1)+deviceKey(4)+reserved(1=공백)
//  22-24 functionCode(3)
//  25-26 pageId(2)
//  27  addressType(1)   J=JSON / B=Binary
//  28-30 address(3)
//  31-33 dataLength(3)
//  34..  data
//  +4  checksum(4)      [10, dataEnd) 합 % 10000
//  +1  ETX '!'

function calcChecksum(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i];
  return ('0000' + (sum % 10000)).slice(-4);
}

function parseFrame(buf) {
  if (buf[0] !== 0x40) throw new Error('Bad STX');
  if (buf[buf.length - 1] !== 0x21) throw new Error('Bad ETX');

  const transactionId = buf.slice(2, 6).toString();
  const transactionSize = parseInt(buf.slice(6, 7).toString(), 10) || 1;
  const transactionSeq = parseInt(buf.slice(7, 8).toString(), 10) || 1;
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
    transactionId, transactionSize, transactionSeq,
    requestType, serviceId, deviceId, functionCode, pageId, addressType,
    dataLength, data, checksumOk: checksum === expected, rawBuf: buf,
  };
}

// 범용 프레임 빌더. dataBuf 는 Buffer.
function buildFrame({ deviceId, functionCode, pageId = '00', addressType = 'J',
                      requestType = '1', transactionId, transactionSize = '1',
                      transactionSeq = '1', dataBuf }) {
  const data = dataBuf || Buffer.alloc(0);
  const dataLength = data.length;
  const txId = (transactionId == null ? '0' : String(transactionId)).padStart(4, '0').slice(-4);

  const buf = Buffer.alloc(39 + dataLength);
  let pos = 0;
  buf.write('@', pos++);
  buf.write('T', pos++);
  buf.write(txId, pos); pos += 4;
  buf.write(String(transactionSize).slice(0, 1), pos++);
  buf.write(String(transactionSeq).slice(0, 1), pos++);
  buf.write(requestType, pos++);
  buf.write('D', pos++);                              // destination = Device
  buf.write('0000', pos); pos += 4;                   // serviceId
  buf.write(deviceId.padEnd(8, ' ').slice(0, 8), pos); pos += 8; // deviceId(8): reserved 공백 보존

  buf.write(functionCode.padStart(3, '0'), pos); pos += 3;
  buf.write(pageId.padStart(2, '0'), pos); pos += 2;
  buf.write(addressType, pos++);
  buf.write('000', pos); pos += 3;                    // address
  buf.write(dataLength.toString().padStart(3, '0'), pos); pos += 3;
  data.copy(buf, pos); pos += dataLength;
  buf.write(calcChecksum(buf, 10, pos), pos); pos += 4;
  buf.write('!', pos);
  return buf;
}

// 300 운전/정지 제어. payload: { requestType?, operation:'1'|'2' }
function buildControlFrame({ deviceId, transactionId, payload }) {
  const reqType = (payload && payload.requestType) || '00';
  const op = (payload && payload.operation) || '1';
  return buildFrame({
    deviceId, functionCode: '300', addressType: 'J', transactionId,
    dataBuf: Buffer.from(reqType + op, 'utf8'),
  });
}

// 501 설정 / 800 연산압력 등 JSON 페이로드 명령.
function buildJsonCommandFrame({ deviceId, functionCode, transactionId, payload }) {
  return buildFrame({
    deviceId, functionCode, addressType: 'J', transactionId,
    dataBuf: Buffer.from(JSON.stringify(payload || {}), 'utf8'),
  });
}

// 502 연간압력 다운로드. 365개를 각 4 ASCII(=round(kPa*100), 0~9999)로 packing → 1460B.
function buildAnnualDownloadFrame({ deviceId, transactionId, pressures }) {
  const arr = (pressures || []).slice(0, 365);
  while (arr.length < 365) arr.push(0);
  const dataBuf = Buffer.from(
    arr.map((p) => String(Math.max(0, Math.round((p || 0) * 100)) % 10000).padStart(4, '0')).join(''),
    'utf8',
  );
  return buildFrame({ deviceId, functionCode: '502', addressType: 'B', transactionId, dataBuf });
}

// 503 연간압력 업로드 요청. 장비가 보관한 365개를 회신하도록 지시.
function buildAnnualRequestFrame({ deviceId, transactionId, payload }) {
  const year = (payload && payload.year) || new Date().getFullYear();
  return buildFrame({
    deviceId, functionCode: '503', addressType: 'J', transactionId,
    dataBuf: Buffer.from(JSON.stringify({ year }), 'utf8'),
  });
}

// 503 응답(1460B packing) → 365개 kPa 배열로 디코딩.
function decodeAnnualPressures(buf) {
  const str = buf.toString('utf8');
  const out = [];
  for (let i = 0; i + 4 <= str.length && out.length < 365; i += 4) {
    out.push(parseInt(str.slice(i, i + 4), 10) / 100);
  }
  return out;
}

// 수신 프레임에 대한 ACK 응답 빌드 (장비 → Gateway 수신 확인).
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
  const totalDataLen = 3 + 3 + msg.length;

  const buf = Buffer.alloc(34 + totalDataLen + 4 + 1);
  let pos = 0;
  buf.write('@', pos++);
  buf.write(protocolId, pos++);
  buf.write(transactionId, pos); pos += 4;
  buf.write('1', pos++);
  buf.write('1', pos++);
  buf.write('3', pos++);                 // requestType = Response
  buf.write('D', pos++);
  buf.write(serviceId, pos); pos += 4;
  buf.write(deviceId, pos); pos += 8;
  buf.write(functionCode, pos); pos += 3;
  buf.write(pageId, pos); pos += 2;
  buf.write(addressType, pos++);
  buf.write(address, pos); pos += 3;
  buf.write(totalDataLen.toString().padStart(3, '0'), pos); pos += 3;
  buf.write(code.toString().padStart(3, '0'), pos); pos += 3;
  buf.write(msg.length.toString().padStart(3, '0'), pos); pos += 3;
  msg.copy(buf, pos); pos += msg.length;
  buf.write(calcChecksum(buf, 10, pos), pos); pos += 4;
  buf.write('!', pos);
  return buf;
}

module.exports = {
  calcChecksum, parseFrame, buildFrame, buildControlFrame, buildJsonCommandFrame,
  buildAnnualDownloadFrame, buildAnnualRequestFrame, decodeAnnualPressures, buildAck,
};

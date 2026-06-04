-- SPC 시스템 PostgreSQL 스키마
-- 안전하게 재실행 가능 (CREATE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS).
-- 기존 데이터(device_data 등)는 보존된다.

-- ── 마스터 ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account (
  id              BIGSERIAL PRIMARY KEY,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  role            VARCHAR(20)  NOT NULL DEFAULT 'viewer',   -- admin/operator/viewer
  status          VARCHAR(20)  NOT NULL DEFAULT 'active',   -- active/inactive/locked
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site (
  id          BIGSERIAL PRIMARY KEY,
  site_key    VARCHAR(2) UNIQUE NOT NULL,   -- deviceId 앞 2자리
  name        VARCHAR(100) NOT NULL,
  address     VARCHAR(255),
  latitude    DECIMAL(11,7),
  longitude   DECIMAL(11,7),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device (
  id                     BIGSERIAL PRIMARY KEY,
  device_id              VARCHAR(8) UNIQUE NOT NULL,   -- siteKey(2)+type(1)+deviceKey(4)
  site_key               VARCHAR(2),
  type                   VARCHAR(1),
  device_key             VARCHAR(4),
  name                   VARCHAR(100),
  description            VARCHAR(255),
  location               VARCHAR(255),
  latitude               DECIMAL(11,7),
  longitude              DECIMAL(11,7),
  status_use             VARCHAR(20)  NOT NULL DEFAULT 'Active',
  install_date           DATE,
  model_name             VARCHAR(100),
  serial_no              VARCHAR(100),
  interface_version      VARCHAR(10),
  modem_type             VARCHAR(50),
  client_host            VARCHAR(50),
  assigned_account_id    BIGINT REFERENCES account(id),
  connected              BOOLEAN      NOT NULL DEFAULT false,
  last_status_datetime   TIMESTAMPTZ,
  last_pt_cur            DOUBLE PRECISION,
  last_p_con             DOUBLE PRECISION,
  last_pe_cur            DOUBLE PRECISION,
  last_operation_status  VARCHAR(1),
  last_operation         VARCHAR(1),
  last_status_code       INTEGER,
  last_ping_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 기존 PoC device 테이블에 누락된 컬럼 보강 (재실행 안전)
ALTER TABLE device ADD COLUMN IF NOT EXISTS site_key              VARCHAR(2);
ALTER TABLE device ADD COLUMN IF NOT EXISTS type                  VARCHAR(1);
ALTER TABLE device ADD COLUMN IF NOT EXISTS device_key            VARCHAR(4);
ALTER TABLE device ADD COLUMN IF NOT EXISTS name                  VARCHAR(100);
ALTER TABLE device ADD COLUMN IF NOT EXISTS description           VARCHAR(255);
ALTER TABLE device ADD COLUMN IF NOT EXISTS location              VARCHAR(255);
ALTER TABLE device ADD COLUMN IF NOT EXISTS latitude              DECIMAL(11,7);
ALTER TABLE device ADD COLUMN IF NOT EXISTS longitude             DECIMAL(11,7);
ALTER TABLE device ADD COLUMN IF NOT EXISTS status_use            VARCHAR(20) DEFAULT 'Active';
ALTER TABLE device ADD COLUMN IF NOT EXISTS install_date          DATE;
ALTER TABLE device ADD COLUMN IF NOT EXISTS model_name            VARCHAR(100);
ALTER TABLE device ADD COLUMN IF NOT EXISTS serial_no             VARCHAR(100);
ALTER TABLE device ADD COLUMN IF NOT EXISTS interface_version     VARCHAR(10);
ALTER TABLE device ADD COLUMN IF NOT EXISTS modem_type            VARCHAR(50);
ALTER TABLE device ADD COLUMN IF NOT EXISTS client_host           VARCHAR(50);
ALTER TABLE device ADD COLUMN IF NOT EXISTS assigned_account_id   BIGINT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS connected             BOOLEAN DEFAULT false;
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_status_datetime  TIMESTAMPTZ;
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_pt_cur           DOUBLE PRECISION;
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_p_con            DOUBLE PRECISION;
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_pe_cur           DOUBLE PRECISION;
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_operation_status VARCHAR(1);
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_operation        VARCHAR(1);
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_status_code      INTEGER;
ALTER TABLE device ADD COLUMN IF NOT EXISTS last_ping_at          TIMESTAMPTZ;
ALTER TABLE device ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ DEFAULT now();
ALTER TABLE device ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_device_site_type ON device (site_key, type);
CREATE INDEX IF NOT EXISTS idx_device_status_last ON device (status_use, last_status_datetime DESC);

-- ── 시계열 ────────────────────────────────────────────────────────────────────
-- device_data 는 기존에 존재할 수 있으므로 누락 컬럼만 ALTER 로 추가한다.
CREATE TABLE IF NOT EXISTS device_data (
  id                   BIGSERIAL PRIMARY KEY,
  device_id            TEXT NOT NULL,
  status_datetime      TEXT,
  received_at          TIMESTAMPTZ NOT NULL,
  pt_cur               DOUBLE PRECISION,
  pt_b                 DOUBLE PRECISION,
  p_con                DOUBLE PRECISION,
  pe_cur               DOUBLE PRECISION,
  operation_status     TEXT,
  operation            TEXT,
  remain_time_minutes  INTEGER,
  remain_time_seconds  INTEGER,
  status_code          INTEGER,
  data_cycle           INTEGER,
  network_cycle        INTEGER
);
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS pt_b_datetime    TEXT;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS p_con_datetime   TEXT;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS p_con_init       DOUBLE PRECISION;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS data_cycle_unit  TEXT;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS network_cycle_unit TEXT;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS moter_up         INTEGER;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS moter_down       INTEGER;
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS moter_action     VARCHAR(1);
ALTER TABLE device_data ADD COLUMN IF NOT EXISTS operation_mode   VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_device_data_device_received ON device_data (device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_data_device_sdt ON device_data (device_id, status_datetime DESC);

CREATE TABLE IF NOT EXISTS device_alarm (
  id              BIGSERIAL PRIMARY KEY,
  device_id       TEXT NOT NULL,
  alarm_datetime  TEXT,
  alarm_type      INTEGER,
  alarm_code      INTEGER,
  received_at     TIMESTAMPTZ NOT NULL
);
ALTER TABLE device_alarm ADD COLUMN IF NOT EXISTS message         VARCHAR(255);
ALTER TABLE device_alarm ADD COLUMN IF NOT EXISTS severity        VARCHAR(20);
ALTER TABLE device_alarm ADD COLUMN IF NOT EXISTS acknowledged    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE device_alarm ADD COLUMN IF NOT EXISTS acknowledged_by BIGINT;
ALTER TABLE device_alarm ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_device_alarm_device_received ON device_alarm (device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_alarm_unack ON device_alarm (acknowledged) WHERE acknowledged = false;

-- ── 설정 ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_setting (
  device_id          VARCHAR(8) PRIMARY KEY,
  data_cycle         INTEGER,
  data_cycle_unit    VARCHAR(1),
  network_cycle      INTEGER,
  network_cycle_unit VARCHAR(1),
  operation_status   VARCHAR(1),
  p_con_datetime     VARCHAR(8),
  p_con              DOUBLE PRECISION,
  p_max              DOUBLE PRECISION DEFAULT 2.3,
  p_min              DOUBLE PRECISION DEFAULT 1.5,
  p_con_p            DOUBLE PRECISION DEFAULT 0.01,
  p_con_m            DOUBLE PRECISION DEFAULT 0.01,
  ud_con             DOUBLE PRECISION,
  vd_con             DOUBLE PRECISION,
  pel1               DOUBLE PRECISION,
  pel2               DOUBLE PRECISION,
  is_use_max         BOOLEAN DEFAULT false,
  is_use_min         BOOLEAN DEFAULT false,
  dp_con             DOUBLE PRECISION,
  delay_time         INTEGER DEFAULT 60,
  delay_time_unit    VARCHAR(1) DEFAULT '1',
  motor_step_angle   DOUBLE PRECISION DEFAULT 7.5,
  reducer            INTEGER DEFAULT 30,
  turn_angle         INTEGER DEFAULT 15,
  alarm_setting_001  BOOLEAN DEFAULT false,
  alarm_setting_002  BOOLEAN DEFAULT true,
  alarm_setting_003  BOOLEAN DEFAULT false,
  alarm_setting_004  BOOLEAN DEFAULT false,
  alarm_setting_005  BOOLEAN DEFAULT false,
  alarm_setting_006  BOOLEAN DEFAULT false,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT
);

-- 연간 설정 압력 (Long format: device_id + MMDD)
CREATE TABLE IF NOT EXISTS device_setting_pupl (
  device_id   VARCHAR(8) NOT NULL,
  year        SMALLINT   NOT NULL,
  month_day   VARCHAR(4) NOT NULL,   -- MMDD
  pupl        DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, year, month_day)
);

-- ── 제어 큐 ───────────────────────────────────────────────────────────────────
-- 기존 device_command 는 단순 로그였으므로 누락 컬럼을 ALTER 로 보강한다.
CREATE TABLE IF NOT EXISTS device_command (
  id             BIGSERIAL PRIMARY KEY,
  device_id      TEXT NOT NULL,
  function_code  TEXT NOT NULL,
  operation      TEXT NOT NULL,
  sent_at        TIMESTAMPTZ,
  status         TEXT NOT NULL
);
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS page_id        VARCHAR(2);
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS data_json      JSONB;
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS priority       SMALLINT NOT NULL DEFAULT 5;
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS requested_by   BIGINT;
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS requested_at   TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS acked_at       TIMESTAMPTZ;
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS result_code    INTEGER;
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS result_message VARCHAR(255);
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS retry_count    SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE device_command ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_device_command_pickup ON device_command (device_id, status, priority DESC, requested_at);

-- ── 로그 / 룩업 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS frame_log (
  id             BIGSERIAL PRIMARY KEY,
  direction      VARCHAR(2),         -- RX / TX
  device_id      VARCHAR(8),
  function_code  VARCHAR(3),
  page_id        VARCHAR(2),
  raw            TEXT,
  parsed_ok      BOOLEAN,
  error_message  VARCHAR(255),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_frame_log_received ON frame_log (received_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT,
  action       VARCHAR(50),
  target_type  VARCHAR(50),
  target_id    VARCHAR(50),
  payload      JSONB,
  ip           VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alarm_code (
  code         SMALLINT PRIMARY KEY,
  name         VARCHAR(100),
  severity     VARCHAR(20),          -- info/warn/critical
  description  VARCHAR(255)
);

-- ── 시드 데이터 ───────────────────────────────────────────────────────────────
INSERT INTO site (site_key, name, latitude, longitude) VALUES
  ('07', '서울', 37.575779, 126.976822),
  ('12', '서울센터', 37.566535, 126.977969)
ON CONFLICT (site_key) DO NOTHING;

-- 기본 관리자: admin@spc.local / demo1234 (bcrypt). gateway 부팅 시 보장.
INSERT INTO alarm_code (code, name, severity, description) VALUES
  (1, '통신 누락',      'warn',     '장비와의 통신이 일정 시간 이상 누락'),
  (2, '최고 압력 초과', 'critical', '설정 최고 압력 초과'),
  (3, '최저 압력 미달', 'critical', '설정 최저 압력 미달'),
  (4, '전원 공급 이상', 'critical', '전원 공급 알람'),
  (5, '기타',           'info',     '기타 알람')
ON CONFLICT (code) DO NOTHING;

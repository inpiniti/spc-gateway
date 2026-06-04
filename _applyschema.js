const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({ host:'127.0.0.1', port:5432, database:'spcdb', user:'spc', password:'1234' });
(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('schema applied OK');
    const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    console.log('TABLES:', t.rows.map(r=>r.table_name).join(', '));
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='device_data' ORDER BY ordinal_position`);
    console.log('device_data cols:', cols.rows.map(r=>r.column_name).join(', '));
    const dd = await pool.query('SELECT count(*)::int n FROM device_data');
    console.log('device_data rows preserved:', dd.rows[0].n);
    const sites = await pool.query('SELECT site_key, name FROM site ORDER BY site_key');
    console.log('sites:', JSON.stringify(sites.rows));
  } catch(e){ console.log('ERR', e.message); }
  await pool.end();
})();

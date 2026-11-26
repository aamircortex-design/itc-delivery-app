const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const initDb = require('../db.js/db.js');
const app = require('../server.js');

test('manager daily list excludes historical completed bills but keeps that day and active carryovers', async t => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = ':memory:';
  const db = await initDb();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  app.locals.db = db;
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  });

  await db.run("INSERT INTO companies (id, name) VALUES (1, 'Test')");
  for (const [id, name, role, token] of [
    [1, 'Admin', 'admin', 'admin-daily-session'],
    [2, 'Manager', 'manager', 'manager-daily-session']
  ]) {
    await db.run(
      `INSERT INTO users (id, full_name, position, company_id, company_name, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, 1, 'Test', ?, 'salt', 'hash', ?)`,
      [id, name, role, name.toLowerCase(), role]
    );
    await db.run('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
      crypto.createHash('sha256').update(token).digest('hex'),
      id,
      '2999-01-01T00:00:00.000Z'
    ]);
  }

  const selectedDate = '2026-11-26';
  const rows = [
    ['B-OLD-COMPLETED', '2026-11-20', 'Completed', null, '2026-11-22'],
    ['B-OLD-RETURNED', '2026-11-18', 'Returned', null, '2026-11-24'],
    ['B-DELIVERED-TODAY', '2026-11-20', 'Completed', null, selectedDate],
    ['B-SCHEDULED-TODAY', selectedDate, 'Pending', null, null],
    ['B-CARRYOVER', '2026-11-20', 'Not supplied', selectedDate, null],
    ['B-FUTURE-CARRYOVER', '2026-11-20', 'Not supplied', '2026-11-27', null]
  ];
  for (const [billNo, deliveryDate, status, notSuppliedFromDate, completedDate] of rows) {
    await db.run(
      `INSERT INTO bills (company_id, bill_no, outlet_name, address, delivery_date, status, not_supplied_from_date, completed_delivery_date)
       VALUES (1, ?, ?, 'Address', ?, ?, ?, ?)`,
      [billNo, billNo, deliveryDate, status, notSuppliedFromDate, completedDate]
    );
  }

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/bills?date=${selectedDate}`,
    { headers: { Cookie: 'taf_disti_session=manager-daily-session' } }
  );
  assert.equal(response.status, 200);
  const managerBills = await response.json();
  assert.deepEqual(
    managerBills.map(bill => bill.bill_no).sort(),
    ['B-CARRYOVER', 'B-DELIVERED-TODAY', 'B-SCHEDULED-TODAY']
  );

  const invalidDateResponse = await fetch(
    `http://127.0.0.1:${server.address().port}/api/bills?date=not-a-date`,
    { headers: { Cookie: 'taf_disti_session=manager-daily-session' } }
  );
  assert.equal(invalidDateResponse.status, 400);

  const adminResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/bills`, {
    headers: { Cookie: 'taf_disti_session=admin-daily-session' }
  });
  assert.equal(adminResponse.status, 200);
  assert.equal((await adminResponse.json()).length, rows.length);
});

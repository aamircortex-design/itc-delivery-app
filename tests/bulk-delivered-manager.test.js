const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { strFromU8, unzipSync } = require('fflate');
const initDb = require('../db.js/db.js');
const app = require('../server.js');

test('not-supplied bills carry forward and completed bills stay on their scheduled date in exports', async t => {
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
  await db.run(`INSERT INTO users (id, full_name, position, company_id, company_name, user_id, password_salt, password_hash, role)
    VALUES (1, 'Manager', 'Manager', 1, 'Test', 'manager', 'salt', 'hash', 'manager')`);
  await db.run(`INSERT INTO users (id, full_name, position, company_id, company_name, user_id, password_salt, password_hash, role)
    VALUES (2, 'Partner', 'Delivery Partner', 1, 'Test', 'partner', 'salt', 'hash', 'delivery_partner')`);
  const managerToken = 'manager-session';
  const partnerToken = 'partner-session';
  for (const [userId, token] of [[1, managerToken], [2, partnerToken]]) {
    await db.run('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      [crypto.createHash('sha256').update(token).digest('hex'), userId, '2999-01-01T00:00:00.000Z']);
  }
  const deliveryDate = '2026-11-05';
  const bill = await db.run(
    `INSERT INTO bills (company_id, bill_no, outlet_name, address, delivery_date, status, not_supplied_from_date)
     VALUES (1, 'B-1', 'Outlet', 'Address', '2026-11-03', 'Not supplied', ?)`,
    [deliveryDate]
  );
  const notSuppliedBill = await db.run(
    `INSERT INTO bills (company_id, bill_no, outlet_name, address, delivery_date, status, not_supplied_from_date)
     VALUES (1, 'B-3', 'Outlet 3', 'Address 3', '2026-11-03', 'Not supplied', ?)`,
    [deliveryDate]
  );
  await db.run(
    'INSERT INTO bill_items (bill_id, item_name, qty_ordered, qty_delivered) VALUES (?, ?, ?, ?)',
    [notSuppliedBill.lastID, 'Product 3', 4, 0]
  );
  await db.run(
    'INSERT INTO bill_items (bill_id, item_name, qty_ordered, qty_delivered) VALUES (?, ?, ?, ?)',
    [bill.lastID, 'Product', 10, 2]
  );

  const bulkResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/bills/bulk-delivered`, {
    method: 'POST',
    headers: { Cookie: `taf_disti_session=${managerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ billIds: [bill.lastID], deliveryDate })
  });
  assert.equal(bulkResponse.status, 200);
  assert.equal((await bulkResponse.json()).updatedCount, 1);
  assert.deepEqual(
    await db.get('SELECT status, completed_delivery_date FROM bills WHERE id = ?', [bill.lastID]),
    { status: 'Completed', completed_delivery_date: deliveryDate }
  );
  assert.deepEqual(
    await db.get('SELECT qty_delivered, qty_returned FROM bill_items WHERE bill_id = ?', [bill.lastID]),
    { qty_delivered: 10, qty_returned: 0 }
  );

  const secondBill = await db.run(
    `INSERT INTO bills (company_id, bill_no, outlet_name, address, delivery_date, assigned_to, status, not_supplied_from_date)
     VALUES (1, 'B-2', 'Outlet 2', 'Address 2', '2026-11-03', 2, 'Not supplied', ?)`,
    [deliveryDate]
  );
  const item = await db.run(
    'INSERT INTO bill_items (bill_id, item_name, qty_ordered, qty_delivered) VALUES (?, ?, ?, ?)',
    [secondBill.lastID, 'Product 2', 8, 1]
  );
  const reconcileResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/bills/reconcile`, {
    method: 'POST',
    headers: { Cookie: `taf_disti_session=${partnerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      billId: secondBill.lastID,
      items: [{ id: item.lastID, qty_delivered: 8, qty_returned: 0, return_type: '' }],
      deliveryDate
    })
  });
  assert.equal(reconcileResponse.status, 200);
  assert.deepEqual(
    await db.get('SELECT status, completed_delivery_date FROM bills WHERE id = ?', [secondBill.lastID]),
    { status: 'Completed', completed_delivery_date: deliveryDate }
  );

  const billsResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/bills`, {
    headers: { Cookie: `taf_disti_session=${managerToken}` }
  });
  const bills = await billsResponse.json();
  assert.equal(bills.filter(entry => entry.completed_delivery_date === deliveryDate).length, 2);

  const exportResponse = await fetch(
    `http://127.0.0.1:${server.address().port}/api/bills/export?date=${deliveryDate}`,
    { headers: { Cookie: `taf_disti_session=${managerToken}` } }
  );
  assert.equal(exportResponse.status, 200);
  const workbookFiles = unzipSync(new Uint8Array(await exportResponse.arrayBuffer()));
  const workbookText = Object.values(workbookFiles).map(strFromU8).join('\n');
  assert.doesNotMatch(workbookText, /B-1/);
  assert.doesNotMatch(workbookText, /B-2/);
  assert.match(workbookText, /B-3/);

  const originalDateExportResponse = await fetch(
    'http://127.0.0.1:' + server.address().port + '/api/bills/export?date=2026-11-03',
    { headers: { Cookie: `taf_disti_session=${managerToken}` } }
  );
  assert.equal(originalDateExportResponse.status, 200);
  const originalDateFiles = unzipSync(new Uint8Array(await originalDateExportResponse.arrayBuffer()));
  const originalDateText = Object.values(originalDateFiles).map(strFromU8).join('\n');
  assert.match(originalDateText, /B-3/);
  assert.match(originalDateText, /B-1/);
  assert.match(originalDateText, /B-2/);
});

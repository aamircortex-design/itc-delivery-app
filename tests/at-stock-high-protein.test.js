const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const initDb = require('../db.js/db.js');
const app = require('../server.js');

test('special grains 1 kg sales and existing stock are included in high protein', async t => {
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
    VALUES (1, 'Admin', 'Admin', 1, 'Test', 'admin', 'salt', 'hash', 'admin')`);
  const token = 'test-session';
  await db.run('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)',
    [crypto.createHash('sha256').update(token).digest('hex'), '2999-01-01T00:00:00.000Z']);

  const name = 'ASVD ATTA WITH SPECIAL GRAINS 1KG';
  const addSale = (date, bill, code, itemName, quantity, returned = 0) => db.run(
    `INSERT INTO profitability_sales
      (company_id, sales_date, bill_no, item_code, item_name, quantity, sales_return_qty, sales_category, gross_amount)
     VALUES (1, ?, ?, ?, ?, ?, ?, '06 ATTA', 0)`,
    [date, bill, code, itemName, quantity, returned]
  );
  await addSale('2026-11-05', '1', 'FATSG001SW', `${name}_FATSG001SW`, 60, 2);
  await addSale('2026-11-05', '2', '', `${name}_FATSG001`, 3);
  await addSale('2026-11-05', '3', 'OTHER', 'AASHIRVAAD SUPERIOR MP AT 1KG', 5);
  await addSale('2026-11-05', '4', 'SELECT', 'AASHIRVAAD ATTA 1KG SELECT', 4);
  await db.run(`INSERT INTO at_stock_daily
    (company_id, stock_date, sales_category, item_code, item_name, opening_qty, purchase_qty, damaged_qty)
    VALUES (1, '2026-11-05', 'AT', 'FATSG001', ?, 90, 30, 1)`, [name]);

  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => {
    const response = await fetch(base + path, { headers: { Cookie: `taf_disti_session=${token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const report = await get('/api/profitability/at-stock?date=2026-11-05');
  const protein = report.rows.find(row => row.itemName === 'ATTA HIGH PROTEIN 1KG');
  assert.equal(protein.displayName, 'ATTA HIGH PROTEIN 1KG');
  assert.equal(protein.salesQty, 63);
  assert.equal(protein.returnQty, 2);
  assert.equal(protein.openingQty, 90);
  assert.equal(protein.purchaseQty, 30);
  assert.equal(protein.damagedQty, 1);
  assert.equal(protein.closingQty, 58);
  assert.equal(report.rows.filter(row => ['FATSG001', 'FATSG001SW'].includes(row.itemCode)).length, 0);
  assert.equal(report.rows.find(row => row.itemCode === 'OTHER').salesQty, 5);
  assert.equal(report.rows.find(row => row.itemCode === 'SELECT').salesQty, 4);

  const tallied = await fetch(`${base}/api/profitability/at-stock/2026-11-05/tallied`, {
    method: 'PATCH',
    headers: { Cookie: `taf_disti_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'AT', itemCode: '', itemName: protein.itemName, tallied: true })
  });
  assert.equal(tallied.status, 200);
  const afterTally = (await get('/api/profitability/at-stock?date=2026-11-05')).rows
    .find(row => row.itemName === protein.itemName);
  assert.equal(afterTally.tallied, true);
  assert.equal(afterTally.purchaseQty, 30);
  assert.equal(afterTally.damagedQty, 1);
  assert.equal(afterTally.closingQty, 58);

  const saved = await fetch(`${base}/api/profitability/at-stock/2026-11-05`, {
    method: 'PUT',
    headers: { Cookie: `taf_disti_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{
      category: 'AT', itemCode: '', itemName: protein.itemName,
      openingQty: afterTally.openingQty, purchaseQty: afterTally.purchaseQty, damagedQty: afterTally.damagedQty
    }] })
  });
  assert.equal(saved.status, 200);
  const afterSave = (await get('/api/profitability/at-stock?date=2026-11-05')).rows
    .find(row => row.itemName === protein.itemName);
  assert.equal(afterSave.closingQty, 58);
  assert.equal(afterSave.tallied, true);

  const nextDay = await get('/api/profitability/at-stock?date=2026-11-06');
  assert.equal(nextDay.rows.find(row => row.itemName === 'ATTA HIGH PROTEIN 1KG').openingQty, 58);
  const assignments = await get('/api/profitability/at-assignment?date=2026-11-05');
  assert.equal(assignments.agents[0].items.find(row => row.itemCode === 'FATSG001SW').displayName, 'ATTA HIGH PROTEIN 1KG');
  const damages = await get('/api/profitability/damages?fromDate=2026-11-05&toDate=2026-11-05');
  assert.equal(damages.entries[0].displayName, 'ATTA HIGH PROTEIN 1KG');
  assert.equal(damages.warehouse[0].displayName, 'ATTA HIGH PROTEIN 1KG');
});

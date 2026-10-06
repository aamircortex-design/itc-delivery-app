const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function initDb() {
  const db = await open({
    filename: process.env.DATABASE_PATH || path.join(__dirname, '..', 'delivery.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      bill_no TEXT NOT NULL,
      outlet_name TEXT NOT NULL,
      address TEXT NOT NULL,
      delivery_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (company_id, bill_no)
    );

    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      qty_ordered INTEGER NOT NULL CHECK (qty_ordered >= 0),
      qty_delivered INTEGER NOT NULL DEFAULT 0 CHECK (qty_delivered >= 0),
      qty_returned INTEGER NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
      UNIQUE (bill_id, item_name)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      position TEXT NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      company_name TEXT NOT NULL,
      user_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('admin', 'manager', 'delivery_partner')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
  `);

  const userColumns = await db.all('PRAGMA table_info(users)');
  if (!userColumns.some(column => column.name === 'company_id')) {
    await db.exec('ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  }

  const billColumns = await db.all('PRAGMA table_info(bills)');
  if (!billColumns.some(column => column.name === 'delivery_date')) {
    await db.exec("ALTER TABLE bills ADD COLUMN delivery_date TEXT NOT NULL DEFAULT ''");
  }
  if (!billColumns.some(column => column.name === 'assigned_to')) {
    await db.exec('ALTER TABLE bills ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!billColumns.some(column => column.name === 'company_id')) {
    await db.exec('ALTER TABLE bills ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  }

  const legacyCompany = await db.get('SELECT id FROM companies ORDER BY id LIMIT 1');
  let legacyCompanyId = legacyCompany?.id;
  if (!legacyCompanyId) {
    const existingData = await db.get(
      'SELECT EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM bills) AS hasData'
    );
    if (existingData.hasData) {
      const firstUser = await db.get('SELECT company_name FROM users ORDER BY id LIMIT 1');
      const result = await db.run(
        'INSERT INTO companies (name) VALUES (?)',
        [firstUser?.company_name || 'Existing Workspace']
      );
      legacyCompanyId = result.lastID;
    }
  }
  if (legacyCompanyId) {
    await db.run('UPDATE users SET company_id = ? WHERE company_id IS NULL', [legacyCompanyId]);
    await db.run('UPDATE bills SET company_id = ? WHERE company_id IS NULL', [legacyCompanyId]);
  }

  const userTable = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
  if (!userTable.sql.includes("'delivery_partner'")) {
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.exec(`
        CREATE TABLE users_updated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          position TEXT NOT NULL,
          company_id INTEGER NOT NULL REFERENCES companies(id),
          company_name TEXT NOT NULL,
          user_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('admin', 'manager', 'delivery_partner')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_updated (id, full_name, position, company_id, company_name, user_id, password_salt, password_hash, role, created_at)
        SELECT id, full_name, position, company_id, company_name, user_id, password_salt, password_hash,
               CASE role WHEN 'user' THEN 'manager' ELSE role END, created_at
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_updated RENAME TO users;
      `);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    } finally {
      await db.exec('PRAGMA foreign_keys = ON');
    }
  }

  const billIndexes = await db.all('PRAGMA index_list(bills)');
  const billNumberUniqueIndex = billIndexes.find(index => index.unique && index.origin === 'u');
  if (billNumberUniqueIndex) {
    const indexedColumns = await db.all(`PRAGMA index_info("${billNumberUniqueIndex.name}")`);
    if (indexedColumns.length === 1 && indexedColumns[0].name === 'bill_no') {
      await db.exec('PRAGMA foreign_keys = OFF');
      await db.exec('BEGIN IMMEDIATE');
      try {
        await db.exec(`
          CREATE TABLE bills_updated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id),
            bill_no TEXT NOT NULL,
            outlet_name TEXT NOT NULL,
            address TEXT NOT NULL,
            delivery_date TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'Pending',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE (company_id, bill_no)
          );
          INSERT INTO bills_updated
            (id, company_id, bill_no, outlet_name, address, delivery_date, status, created_at, updated_at, assigned_to)
          SELECT id, company_id, bill_no, outlet_name, address, delivery_date, status, created_at, updated_at, assigned_to
          FROM bills;
          DROP TABLE bills;
          ALTER TABLE bills_updated RENAME TO bills;
        `);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      } finally {
        await db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  await db.run('DELETE FROM auth_sessions WHERE expires_at <= ?', [new Date().toISOString()]);
  await db.exec('CREATE INDEX IF NOT EXISTS users_company_id ON users(company_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS bills_company_id ON bills(company_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS bills_assigned_to ON bills(assigned_to)');

  return db;
}

module.exports = initDb;

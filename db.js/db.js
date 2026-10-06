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
    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_no TEXT NOT NULL UNIQUE,
      outlet_name TEXT NOT NULL,
      address TEXT NOT NULL,
      delivery_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  const billColumns = await db.all('PRAGMA table_info(bills)');
  if (!billColumns.some(column => column.name === 'delivery_date')) {
    await db.exec("ALTER TABLE bills ADD COLUMN delivery_date TEXT NOT NULL DEFAULT ''");
  }
  if (!billColumns.some(column => column.name === 'assigned_to')) {
    await db.exec('ALTER TABLE bills ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL');
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
          company_name TEXT NOT NULL,
          user_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('admin', 'manager', 'delivery_partner')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_updated (id, full_name, position, company_name, user_id, password_salt, password_hash, role, created_at)
        SELECT id, full_name, position, company_name, user_id, password_salt, password_hash,
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

  await db.run('DELETE FROM auth_sessions WHERE expires_at <= ?', [new Date().toISOString()]);
  await db.exec('CREATE INDEX IF NOT EXISTS bills_assigned_to ON bills(assigned_to)');

  return db;
}

module.exports = initDb;

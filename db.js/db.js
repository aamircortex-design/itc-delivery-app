const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function initDb() {
  if (process.env.RENDER_SERVICE_ID) {
    if (!process.env.DATABASE_PATH) {
      throw new Error('DATABASE_PATH is required on Render. Mount a persistent disk at /var/data and set DATABASE_PATH=/var/data/delivery.sqlite.');
    }

    const persistentDirectory = path.resolve('/var/data');
    const databasePath = path.resolve(process.env.DATABASE_PATH);
    const relativePath = path.relative(persistentDirectory, databasePath);
    if (
      !fs.existsSync(persistentDirectory) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Render database must be stored on the persistent disk under /var/data. Verify the disk mount and DATABASE_PATH before starting the app.');
    }
  }

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
      salesman TEXT NOT NULL DEFAULT '',
      delivery_date TEXT NOT NULL DEFAULT '',
      not_supplied_from_date TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      progress_started_at TEXT,
      progress_updated_at TEXT,
      completed_at TEXT,
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
      return_type TEXT NOT NULL DEFAULT '' CHECK (return_type IN ('', 'R', 'DA', 'DUE')),
      UNIQUE (bill_id, item_name)
    );

    CREATE TABLE IF NOT EXISTS profitability_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sales_date TEXT NOT NULL,
      bill_no TEXT NOT NULL COLLATE NOCASE,
      outlet_name TEXT NOT NULL DEFAULT '',
      item_code TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
      item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL,
      sales_return_qty REAL NOT NULL DEFAULT 0,
      sales_category TEXT NOT NULL DEFAULT 'Uncategorized',
      gross_amount REAL NOT NULL,
      rfa_amount REAL NOT NULL DEFAULT 0,
      output_tax REAL NOT NULL DEFAULT 0,
      UNIQUE (company_id, sales_date, bill_no, item_code, item_name)
    );
    CREATE TABLE IF NOT EXISTS at_stock_daily (
      company_id INTEGER NOT NULL,
      stock_date TEXT NOT NULL,
      sales_category TEXT NOT NULL CHECK (sales_category IN ('AT', 'BC')),
      item_code TEXT NOT NULL DEFAULT '',
      item_name TEXT NOT NULL,
      opening_qty REAL,
      purchase_qty REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, stock_date, sales_category, item_code, item_name)
    );

    CREATE TABLE IF NOT EXISTS profitability_product_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_code TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
      item_name TEXT NOT NULL COLLATE NOCASE,
      purchase_unit_cost REAL NOT NULL CHECK (purchase_unit_cost >= 0),
      input_gst_rate REAL NOT NULL DEFAULT 0 CHECK (input_gst_rate >= 0 AND input_gst_rate <= 100),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (company_id, item_code, item_name)
    );

    CREATE INDEX IF NOT EXISTS profitability_sales_period
      ON profitability_sales(company_id, sales_date);
    CREATE UNIQUE INDEX IF NOT EXISTS profitability_product_costs_by_code
      ON profitability_product_costs(company_id, item_code) WHERE item_code <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS profitability_product_costs_by_name
      ON profitability_product_costs(company_id, item_name) WHERE item_code = '';

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

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rt_damage_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      rt_number TEXT NOT NULL,
      outlet_name TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      damage_date TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'Pending' CHECK (approval_status IN ('Pending', 'Approved', 'Rejected')),
      rt_entry_month TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      photo_mime_type TEXT NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
      photo_data BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry ON password_reset_tokens(expires_at);
  `);

  const damageColumns = await db.all('PRAGMA table_info(rt_damage_reports)');
  if (!damageColumns.some(column => column.name === 'damage_date')) {
    await db.exec("ALTER TABLE rt_damage_reports ADD COLUMN damage_date TEXT NOT NULL DEFAULT ''");
    await db.exec("UPDATE rt_damage_reports SET damage_date = substr(created_at, 1, 10) WHERE damage_date = ''");
  }
  const damageUserColumn = damageColumns.find(column => column.name === 'user_id');
  const damageForeignKeys = await db.all('PRAGMA foreign_key_list(rt_damage_reports)');
  if (
    damageUserColumn?.notnull ||
    damageForeignKeys.some(key => key.from === 'user_id' && key.on_delete.toUpperCase() !== 'SET NULL')
  ) {
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.exec(`
        CREATE TABLE rt_damage_reports_updated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          rt_number TEXT NOT NULL,
          outlet_name TEXT NOT NULL DEFAULT '',
          agent_name TEXT NOT NULL DEFAULT '',
          damage_date TEXT NOT NULL,
          approval_status TEXT NOT NULL DEFAULT 'Pending' CHECK (approval_status IN ('Pending', 'Approved', 'Rejected')),
          rt_entry_month TEXT,
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TEXT,
          review_note TEXT NOT NULL DEFAULT '',
          photo_mime_type TEXT NOT NULL CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
          photo_data BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO rt_damage_reports_updated
          (id, company_id, user_id, rt_number, damage_date, photo_mime_type, photo_data, created_at)
        SELECT id, company_id, user_id, rt_number, damage_date, photo_mime_type, photo_data, created_at
        FROM rt_damage_reports;
        DROP TABLE rt_damage_reports;
        ALTER TABLE rt_damage_reports_updated RENAME TO rt_damage_reports;
      `);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    } finally {
      await db.exec('PRAGMA foreign_keys = ON');
    }
  }

  const currentDamageColumns = await db.all('PRAGMA table_info(rt_damage_reports)');
  if (!currentDamageColumns.some(column => column.name === 'outlet_name')) {
    await db.exec("ALTER TABLE rt_damage_reports ADD COLUMN outlet_name TEXT NOT NULL DEFAULT ''");
  }
  if (!currentDamageColumns.some(column => column.name === 'agent_name')) {
    await db.exec("ALTER TABLE rt_damage_reports ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''");
  }
  await db.exec(`
    UPDATE rt_damage_reports
    SET agent_name = COALESCE(
      NULLIF(agent_name, ''),
      (SELECT full_name FROM users WHERE users.id = rt_damage_reports.user_id),
      'Former team member'
    )
    WHERE agent_name = ''
  `);
  if (!currentDamageColumns.some(column => column.name === 'approval_status')) {
    await db.exec("ALTER TABLE rt_damage_reports ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'Pending'");
  }
  if (!currentDamageColumns.some(column => column.name === 'rt_entry_month')) {
    await db.exec('ALTER TABLE rt_damage_reports ADD COLUMN rt_entry_month TEXT');
  }
  if (!currentDamageColumns.some(column => column.name === 'reviewed_by')) {
    await db.exec('ALTER TABLE rt_damage_reports ADD COLUMN reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!currentDamageColumns.some(column => column.name === 'reviewed_at')) {
    await db.exec('ALTER TABLE rt_damage_reports ADD COLUMN reviewed_at TEXT');
  }
  if (!currentDamageColumns.some(column => column.name === 'review_note')) {
    await db.exec("ALTER TABLE rt_damage_reports ADD COLUMN review_note TEXT NOT NULL DEFAULT ''");
  }

  const userColumns = await db.all('PRAGMA table_info(users)');
  if (!userColumns.some(column => column.name === 'company_id')) {
    await db.exec('ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  }
  if (!userColumns.some(column => column.name === 'email')) {
    await db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }

  const profitabilitySalesColumns = await db.all('PRAGMA table_info(profitability_sales)');
  if (!profitabilitySalesColumns.some(column => column.name === 'sales_return_qty')) {
    await db.exec('ALTER TABLE profitability_sales ADD COLUMN sales_return_qty REAL NOT NULL DEFAULT 0');
  }
  if (!profitabilitySalesColumns.some(column => column.name === 'sales_category')) {
    await db.exec("ALTER TABLE profitability_sales ADD COLUMN sales_category TEXT NOT NULL DEFAULT 'Uncategorized'");
  }

  const billColumns = await db.all('PRAGMA table_info(bills)');
  const atStockColumns = await db.all('PRAGMA table_info(at_stock_daily)');
  if (!atStockColumns.some(column => column.name === 'assigned')) {
    await db.exec('ALTER TABLE at_stock_daily ADD COLUMN assigned INTEGER NOT NULL DEFAULT 0');
  }
  if (!atStockColumns.some(column => column.name === 'damaged_qty')) {
    await db.exec('ALTER TABLE at_stock_daily ADD COLUMN damaged_qty REAL NOT NULL DEFAULT 0');
  }
  const billItemColumns = await db.all('PRAGMA table_info(bill_items)');
  if (!billItemColumns.some(column => column.name === 'return_type')) {
    await db.exec("ALTER TABLE bill_items ADD COLUMN return_type TEXT NOT NULL DEFAULT ''");
  }
  if (!billColumns.some(column => column.name === 'delivery_date')) {
    await db.exec("ALTER TABLE bills ADD COLUMN delivery_date TEXT NOT NULL DEFAULT ''");
  }
  if (!billColumns.some(column => column.name === 'salesman')) {
    await db.exec("ALTER TABLE bills ADD COLUMN salesman TEXT NOT NULL DEFAULT ''");
  }
  if (!billColumns.some(column => column.name === 'not_supplied_from_date')) {
    await db.exec('ALTER TABLE bills ADD COLUMN not_supplied_from_date TEXT');
  }
  if (!billColumns.some(column => column.name === 'assigned_to')) {
    await db.exec('ALTER TABLE bills ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!billColumns.some(column => column.name === 'company_id')) {
    await db.exec('ALTER TABLE bills ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  }
  if (!billColumns.some(column => column.name === 'progress_started_at')) {
    await db.exec('ALTER TABLE bills ADD COLUMN progress_started_at TEXT');
  }
  if (!billColumns.some(column => column.name === 'progress_updated_at')) {
    await db.exec('ALTER TABLE bills ADD COLUMN progress_updated_at TEXT');
  }
  if (!billColumns.some(column => column.name === 'completed_at')) {
    await db.exec('ALTER TABLE bills ADD COLUMN completed_at TEXT');
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
            salesman TEXT NOT NULL DEFAULT '',
            delivery_date TEXT NOT NULL DEFAULT '',
            not_supplied_from_date TEXT,
            status TEXT NOT NULL DEFAULT 'Pending',
            progress_started_at TEXT,
            progress_updated_at TEXT,
            completed_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE (company_id, bill_no)
          );
          INSERT INTO bills_updated
            (id, company_id, bill_no, outlet_name, address, salesman, delivery_date, not_supplied_from_date, status, progress_started_at, progress_updated_at, completed_at, created_at, updated_at, assigned_to)
          SELECT id, company_id, bill_no, outlet_name, address, salesman, delivery_date, not_supplied_from_date, status, progress_started_at, progress_updated_at, completed_at, created_at, updated_at, assigned_to
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
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL');
  await db.exec('CREATE INDEX IF NOT EXISTS bills_company_id ON bills(company_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS bills_assigned_to ON bills(assigned_to)');
  await db.exec('CREATE INDEX IF NOT EXISTS rt_damage_reports_company_date ON rt_damage_reports(company_id, damage_date, created_at DESC)');

  return db;
}

module.exports = initDb;

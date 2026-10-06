const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Readable } = require('stream');
const { parse } = require('csv-parse/sync');
const { strToU8, zipSync } = require('fflate');
const readXlsxFile = require('read-excel-file/node');
const initDb = require('./db.js/db.js');
const scrypt = promisify(crypto.scrypt);

const app = express();
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const sessionCookieName = 'taf_disti_session';
const publicPaths = new Set([
  '/login',
  '/login.html',
  '/setup',
  '/setup.html',
  '/company-setup.html',
  '/company-setup',
  '/auth.css',
  '/auth.js',
  '/styles.css',
  '/app.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/service-worker.js',
  '/icons/taf-disti-desk.svg',
  '/health',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/company-setup'
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (/\.(xlsx|csv)$/i.test(file.originalname)) {
      return callback(null, true);
    }
    callback(new Error('Choose an Excel (.xlsx) or CSV file.'));
  }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (req, res) => {
  try {
    await req.app.locals.db.get('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'unavailable' });
  }
});

function getCookieValue(req, name) {
  const cookies = req.headers.cookie?.split(';') || [];
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : '';
}

function getSessionTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(res, token) {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

async function issueSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await db.run(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [getSessionTokenHash(token), userId, expiresAt]
  );
  return token;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = await scrypt(password, salt, 64);
  return { salt, hash: derivedKey.toString('hex') };
}

async function verifyPassword(password, salt, expectedHash) {
  const actual = await hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, 'hex');
  const derived = Buffer.from(actual.hash, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function validateUserDetails(details = {}) {
  const user = {
    fullName: String(details.fullName || '').trim(),
    position: String(details.position || '').trim(),
    companyName: String(details.companyName || '').trim(),
    userId: String(details.userId || '').trim(),
    password: String(details.password || ''),
    role: String(details.role || 'manager')
  };

  if (!user.fullName || user.fullName.length > 120) {
    throw new Error('Enter a name of 1 to 120 characters.');
  }
  if (!user.position || user.position.length > 100) {
    throw new Error('Enter a position of 1 to 100 characters.');
  }
  if (!user.companyName || user.companyName.length > 150) {
    throw new Error('Enter a company name of 1 to 150 characters.');
  }
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(user.userId)) {
    throw new Error('User ID must be 3 to 64 characters using letters, numbers, dots, underscores, hyphens, or @.');
  }
  if (user.password.length < 8 || user.password.length > 128) {
    throw new Error('Password must be between 8 and 128 characters.');
  }
  if (!['admin', 'manager', 'delivery_partner'].includes(user.role)) {
    throw new Error('Choose a valid user role.');
  }

  return user;
}

async function authenticateRequest(req, res, next) {
  try {
    if (!publicPaths.has(req.path)) {
      res.set('Cache-Control', 'no-store');
    }

    const token = getCookieValue(req, sessionCookieName);
    if (token) {
      req.user = await req.app.locals.db.get(
        `SELECT users.id, users.full_name AS fullName, users.position,
                companies.name AS companyName, users.company_id AS companyId,
                users.user_id AS userId, users.role
         FROM auth_sessions
         JOIN users ON users.id = auth_sessions.user_id
         JOIN companies ON companies.id = users.company_id
         WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?`,
        [getSessionTokenHash(token), new Date().toISOString()]
      );
      if (!req.user) clearSessionCookie(res);
    }

    if (publicPaths.has(req.path)) {
      return next();
    }

    if (!req.user) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Please sign in to continue.' });
      }
      return res.redirect(303, '/login');
    }

    if (
      (req.path === '/users' || req.path === '/users.html' || req.path === '/users.js' ||
        req.path.startsWith('/api/users')) &&
      req.user.role !== 'admin'
    ) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Administrator access is required to manage users.' });
      }
      return res.redirect(303, '/');
    }

    next();
  } catch (error) {
    next(error);
  }
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const password = String(req.body.password || '');
    if (!userId || !password || password.length > 128) {
      return res.status(400).json({ error: 'Enter your user ID and password.' });
    }

    const user = await req.app.locals.db.get(
      'SELECT id, password_salt, password_hash FROM users WHERE user_id = ? COLLATE NOCASE',
      [userId]
    );
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
      return res.status(401).json({ error: 'The user ID or password is incorrect.' });
    }

    const token = await issueSession(req.app.locals.db, user.id);
    setSessionCookie(res, token);
    res.json({ message: 'Signed in successfully.' });
  } catch (error) {
    console.error('Could not sign in:', error);
    res.status(500).json({ error: 'Could not sign in. Please try again.' });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  let transactionOpen = false;
  try {
    const user = validateUserDetails(req.body);
    const password = await hashPassword(user.password);

    await req.app.locals.db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const existingUser = await req.app.locals.db.get('SELECT id FROM users LIMIT 1');
    if (existingUser) {
      await req.app.locals.db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(409).json({ error: 'Initial setup is already complete. Sign in with an administrator account.' });
    }

    const existingCompany = await req.app.locals.db.get('SELECT id FROM companies ORDER BY id LIMIT 1');
    let companyId;
    if (existingCompany) {
      companyId = existingCompany.id;
      await req.app.locals.db.run('UPDATE companies SET name = ? WHERE id = ?', [user.companyName, companyId]);
    } else {
      const company = await req.app.locals.db.run(
        'INSERT INTO companies (name) VALUES (?)',
        [user.companyName]
      );
      companyId = company.lastID;
    }
    const result = await req.app.locals.db.run(
      `INSERT INTO users (full_name, position, company_id, company_name, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')`,
      [user.fullName, user.position, companyId, user.companyName, user.userId, password.salt, password.hash]
    );
    const token = await issueSession(req.app.locals.db, result.lastID);
    await req.app.locals.db.exec('COMMIT');
    transactionOpen = false;
    setSessionCookie(res, token);
    res.status(201).json({ message: 'Administrator account created.' });
  } catch (error) {
    if (transactionOpen) await req.app.locals.db.exec('ROLLBACK');
    if (error.message.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That user ID is already in use.' });
    }
    if (/Enter |User ID|Password|role/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Could not complete initial setup:', error);
    res.status(500).json({ error: 'Could not create the administrator account. Please try again.' });
  }
});

app.post('/api/auth/company-setup', async (req, res) => {
  let transactionOpen = false;
  try {
    const user = validateUserDetails(req.body);
    const password = await hashPassword(user.password);
    const db = req.app.locals.db;
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const company = await db.run(
      'INSERT INTO companies (name) VALUES (?)',
      [user.companyName]
    );
    const result = await db.run(
      `INSERT INTO users (full_name, position, company_id, company_name, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')`,
      [user.fullName, user.position, company.lastID, user.companyName, user.userId, password.salt, password.hash]
    );
    const token = await issueSession(db, result.lastID);
    await db.exec('COMMIT');
    transactionOpen = false;
    setSessionCookie(res, token);
    res.status(201).json({ message: 'Company workspace created.' });
  } catch (error) {
    if (transactionOpen) await req.app.locals.db.exec('ROLLBACK');
    if (error.message.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That user ID is already in use. Choose another one.' });
    }
    if (/Enter |User ID|Password|role/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Could not create company workspace:', error);
    res.status(500).json({ error: 'Could not create the company workspace. Please try again.' });
  }
});

app.use(authenticateRequest);

app.get('/login', async (req, res) => {
  if (req.user) return res.redirect(303, '/');
  const user = await req.app.locals.db.get('SELECT id FROM users LIMIT 1');
  res.redirect(303, user ? '/login.html' : '/setup');
});

app.get('/setup', async (req, res) => {
  if (req.user) return res.redirect(303, req.user.role === 'admin' ? '/users' : '/');
  const user = await req.app.locals.db.get('SELECT id FROM users LIMIT 1');
  res.redirect(303, user ? '/login' : '/setup.html');
});

app.get('/company-setup', (req, res) => {
  if (req.user) return res.redirect(303, '/');
  res.sendFile(path.join(__dirname, 'public', 'company-setup.html'));
});

app.get('/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = getCookieValue(req, sessionCookieName);
    await req.app.locals.db.run(
      'DELETE FROM auth_sessions WHERE token_hash = ?',
      [getSessionTokenHash(token)]
    );
    clearSessionCookie(res);
    res.json({ message: 'Signed out successfully.' });
  } catch (error) {
    console.error('Could not sign out:', error);
    res.status(500).json({ error: 'Could not sign out. Please try again.' });
  }
});

app.get('/api/auth/session', (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await req.app.locals.db.all(
      `SELECT users.id, users.full_name AS fullName, users.position, companies.name AS companyName,
              users.user_id AS userId, users.role, users.created_at AS createdAt
       FROM users JOIN companies ON companies.id = users.company_id
       WHERE users.company_id = ? ORDER BY full_name COLLATE NOCASE`,
      [req.user.companyId]
    );
    res.json(users);
  } catch (error) {
    console.error('Could not load user list:', error);
    res.status(500).json({ error: 'Could not load users. Please try again.' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const user = validateUserDetails({ ...req.body, companyName: req.user.companyName });
    const password = await hashPassword(user.password);
    const result = await req.app.locals.db.run(
      `INSERT INTO users (full_name, position, company_id, company_name, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.fullName, user.position, req.user.companyId, req.user.companyName, user.userId, password.salt, password.hash, user.role]
    );
    res.status(201).json({ message: 'User created successfully.', id: result.lastID });
  } catch (error) {
    if (error.message.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That user ID is already in use.' });
    }
    if (/Enter |User ID|Password|role/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Could not create user:', error);
    res.status(500).json({ error: 'Could not create user. Please try again.' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const userId = Number(req.params.id);
  const db = req.app.locals.db;
  let transactionOpen = false;
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'Choose a valid user.' });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot remove your own account.' });
  }

  try {
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const user = await db.get('SELECT id, role FROM users WHERE id = ? AND company_id = ?', [userId, req.user.companyId]);
    if (!user) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(404).json({ error: 'User not found.' });
    }
    if (user.role === 'admin') {
      const admins = await db.get("SELECT COUNT(*) AS count FROM users WHERE company_id = ? AND role = 'admin'", [req.user.companyId]);
      if (admins.count <= 1) {
        await db.exec('ROLLBACK');
        transactionOpen = false;
        return res.status(400).json({ error: 'The last administrator cannot be removed.' });
      }
    }
    await db.run('DELETE FROM users WHERE id = ?', [userId]);
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ message: 'User removed successfully.' });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK');
    console.error('Could not remove user:', error);
    res.status(500).json({ error: 'Could not remove user. Please try again.' });
  }
});

app.get('/api/delivery-partners', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only administrators and managers can view delivery partners.' });
  }
  try {
    const partners = await req.app.locals.db.all(
      `SELECT id, full_name AS fullName FROM users
       WHERE company_id = ? AND role = 'delivery_partner' ORDER BY full_name COLLATE NOCASE`,
      [req.user.companyId]
    );
    res.json(partners);
  } catch (error) {
    console.error('Could not load delivery partners:', error);
    res.status(500).json({ error: 'Could not load delivery partners. Please try again.' });
  }
});

app.patch('/api/bills/:id/assignment', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only administrators and managers can assign deliveries.' });
  }
  const billId = Number(req.params.id);
  const partnerId = req.body.partnerId === null || req.body.partnerId === '' ? null : Number(req.body.partnerId);
  if (!Number.isSafeInteger(billId) || billId < 1 ||
      (partnerId !== null && (!Number.isSafeInteger(partnerId) || partnerId < 1))) {
    return res.status(400).json({ error: 'Choose a valid bill and delivery partner.' });
  }

  try {
    const db = req.app.locals.db;
    const bill = await db.get(
      'SELECT id FROM bills WHERE id = ? AND company_id = ?',
      [billId, req.user.companyId]
    );
    if (!bill) return res.status(404).json({ error: 'Delivery not found.' });
    if (partnerId !== null) {
      const partner = await db.get(
        "SELECT id FROM users WHERE id = ? AND company_id = ? AND role = 'delivery_partner'",
        [partnerId, req.user.companyId]
      );
      if (!partner) return res.status(400).json({ error: 'Choose an active delivery partner.' });
    }
    await db.run(
      'UPDATE bills SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
      [partnerId, billId, req.user.companyId]
    );
    res.json({ message: 'Delivery assignment saved.' });
  } catch (error) {
    console.error('Could not assign delivery:', error);
    res.status(500).json({ error: 'Could not assign delivery. Please try again.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const normalizeHeader = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const headerAliases = {
  billno: ['billno', 'billnumber', 'invoiceno', 'invoicenumber', 'orderid'],
  outletname: ['outletname', 'outlet', 'customername', 'storename', 'recipient'],
  address: ['address', 'deliveryaddress', 'location'],
  itemname: ['itemname', 'item', 'productname', 'product'],
  quantity: ['quantity', 'qty', 'qtyordered', 'orderedquantity', 'invoiceqty'],
  invoiceDate: ['invoicedate', 'invoicesrdate', 'invoicesalesdate', 'salesdate', 'billdate', 'date'],
  salesReturn: ['salesreturn', 'salesreturnno', 'salesreturnnumber', 'returnno'],
  beat: ['beat']
};

function findHeaderIndex(rows) {
  return rows.findIndex(row => {
    const available = new Set(row.map(normalizeHeader));
    return ['billno', 'itemname', 'quantity'].every(field =>
      headerAliases[field].some(alias => available.has(alias))
    );
  });
}

function mapRow(headers, row) {
  const columns = new Map(headers.map((key, index) => [normalizeHeader(key), row[index]]));
  const result = {};

  for (const [field, aliases] of Object.entries(headerAliases)) {
    const alias = aliases.find(candidate => columns.has(candidate));
    const value = alias ? columns.get(alias) : '';
    result[field] = field === 'invoiceDate' && value instanceof Date
      ? value
      : String(value ?? '').trim();
  }

  if (!result.address && result.beat) {
    result.address = `Beat: ${result.beat}`;
  }

  return result;
}

function normalizeDeliveryDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }

  const text = String(value ?? '').trim();
  let year;
  let month;
  let day;

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    [year, month, day] = text.split('-').map(Number);
  } else {
    const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
    if (!match) return '';
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatSalesDate(isoDate) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(number) {
  let name = '';
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function createWorksheet(rows, { autoFilterRow } = {}) {
  const columnCount = Math.max(1, ...rows.map(row => row.length));
  const columnWidths = Array.from({ length: columnCount }, (_, index) => {
    const contentWidth = Math.max(
      10,
      ...rows.map(row => String(row[index] ?? '').length)
    );
    return `<col min="${index + 1}" max="${index + 1}" width="${Math.min(contentWidth + 2, 50)}" customWidth="1"/>`;
  }).join('');
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columnCount }, (_, columnIndex) => {
      const value = row[columnIndex] ?? '';
      const reference = `${excelColumnName(columnIndex + 1)}${rowIndex + 1}`;

      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${reference}"><v>${value}</v></c>`;
      }

      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const autoFilter = autoFilterRow && rows.length >= autoFilterRow
    ? `<autoFilter ref="A${autoFilterRow}:${excelColumnName(columnCount)}${rows.length}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetFormatPr defaultRowHeight="18"/>
      <cols>${columnWidths}</cols>
      <sheetData>${sheetRows}</sheetData>
      ${autoFilter}
    </worksheet>`;
}

function createDeliveryWorkbook(summaryRows, itemRows) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      </Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Daily Summary" sheetId="1" r:id="rId1"/>
          <sheet name="Delivery Items" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
      </Relationships>`,
    'xl/worksheets/sheet1.xml': createWorksheet(summaryRows, { autoFilterRow: 14 }),
    'xl/worksheets/sheet2.xml': createWorksheet(itemRows, { autoFilterRow: 1 })
  };

  return zipSync(Object.fromEntries(
    Object.entries(files).map(([name, contents]) => [name, strToU8(contents)])
  ));
}

function getBillStatus(totals) {
  const ordered = Number(totals.ordered) || 0;
  const delivered = Number(totals.delivered) || 0;
  const returned = Number(totals.returned) || 0;

  if (ordered > 0 && delivered === 0 && returned === ordered) return 'Returned';
  if (ordered > 0 && delivered + returned === ordered) return 'Completed';
  if (delivered + returned > 0) return 'In progress';
  return 'Pending';
}

async function parseDeliveryRows(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  let sheetRows;
  if (extension === '.csv') {
    sheetRows = parse(file.buffer, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  } else {
    const worksheets = await readXlsxFile(Readable.from([file.buffer]));
    sheetRows = worksheets[0]?.data || [];
  }

  const headerIndex = findHeaderIndex(sheetRows);
  if (headerIndex === -1) {
    throw new Error('Could not find columns for Bill No, Item Name, and Quantity. For a sales register, use Invoice No., Item Name, and Invoice Qty.');
  }

  const headers = sheetRows[headerIndex];
  const normalizedHeaders = new Set(headers.map(normalizeHeader));
  const isSalesRegister = normalizedHeaders.has('salesreturn') || normalizedHeaders.has('salesreturnqty');
  const hasInvoiceDate = headerAliases.invoiceDate.some(alias => normalizedHeaders.has(alias));
  const rows = sheetRows.slice(headerIndex + 1)
    .map((row, index) => ({ ...mapRow(headers, row), rowNumber: headerIndex + index + 2 }))
    .filter(row => row.billno || row.itemname || row.quantity);

  return { rows, isSalesRegister, hasInvoiceDate };
}

app.post('/api/bills/upload', upload.single('file'), async (req, res) => {
  if (req.user.role === 'delivery_partner') {
    return res.status(403).json({ error: 'Only administrators and managers can import deliveries.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let transactionOpen = false;

  try {
    const selectedDate = normalizeDeliveryDate(req.body.deliveryDate);
    if (!selectedDate) {
      return res.status(400).json({ error: 'Choose a valid sales date to import.' });
    }

    const importedFile = await parseDeliveryRows(req.file);
    if (importedFile.isSalesRegister && !importedFile.hasInvoiceDate) {
      return res.status(400).json({ error: 'The sales register needs an Invoice / SR Date column so the app can import just one selected day.' });
    }

    const rows = [];
    const availableDates = new Set();
    let salesReturnsSkipped = 0;
    let otherDatesSkipped = 0;

    for (const row of importedFile.rows) {
      const quantity = Number(String(row.quantity).replace(/,/g, ''));
      const invoiceDate = importedFile.hasInvoiceDate
        ? normalizeDeliveryDate(row.invoiceDate)
        : selectedDate;

      if (importedFile.isSalesRegister && quantity <= 0) {
        if (invoiceDate === selectedDate) salesReturnsSkipped += 1;
        continue;
      }

      if (!invoiceDate) {
        return res.status(400).json({
          error: `Row ${row.rowNumber} has an invalid or missing invoice date. Use day/month/year, such as 06/10/2026.`
        });
      }
      availableDates.add(invoiceDate);
      if (invoiceDate !== selectedDate) {
        otherDatesSkipped += 1;
        continue;
      }

      rows.push({ ...row, quantity, deliveryDate: selectedDate });
    }

    if (!rows.length) {
      const dates = [...availableDates].sort();
      const availableMessage = dates.length
        ? ` Dates in this file: ${dates.map(formatSalesDate).join(', ')}.`
        : '';
      return res.status(400).json({
        error: `No positive-quantity sales were found for ${formatSalesDate(selectedDate)}.${availableMessage} Sales-return-only rows are not imported.`
      });
    }

    for (const row of rows) {
      if (!row.billno || !row.outletname || !row.itemname) {
        return res.status(400).json({
          error: `Row ${row.rowNumber} is missing a bill number, outlet name, or item name.`
        });
      }

      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1) {
        return res.status(400).json({ error: `Row ${row.rowNumber} needs a whole-number quantity greater than zero.` });
      }
    }

    const aggregatedRows = new Map();
    for (const row of rows) {
      const key = `${row.billno}\u0000${row.itemname}`;
      const existing = aggregatedRows.get(key);
      if (existing) {
        existing.quantity += row.quantity;
        existing.sourceRows += 1;
        if (!Number.isSafeInteger(existing.quantity)) {
          return res.status(400).json({ error: `The total quantity for row ${row.rowNumber} is too large.` });
        }
      } else {
        aggregatedRows.set(key, { ...row, sourceRows: 1 });
      }
    }

    await req.app.locals.db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const touchedBillIds = new Set();
    const billIdByNumber = new Map();
    const duplicateBillNumbers = new Set();
    let billsImported = 0;
    let rowsImported = 0;

    for (const row of aggregatedRows.values()) {
      if (billIdByNumber.has(row.billno) || duplicateBillNumbers.has(row.billno)) {
        continue;
      }

      let bill = await req.app.locals.db.get(
        'SELECT id, delivery_date FROM bills WHERE company_id = ? AND bill_no = ?',
        [req.user.companyId, row.billno]
      );

      if (bill && bill.delivery_date === selectedDate) {
        duplicateBillNumbers.add(row.billno);
        continue;
      }

      if (bill && bill.delivery_date) {
        const error = new Error(
          `Bill ${row.billno} is already recorded for ${formatSalesDate(bill.delivery_date)}. It was not imported again for ${formatSalesDate(selectedDate)}.`
        );
        error.statusCode = 409;
        throw error;
      }

      await req.app.locals.db.run(
        `INSERT INTO bills (company_id, bill_no, outlet_name, address, delivery_date)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(company_id, bill_no) DO UPDATE SET
           outlet_name = excluded.outlet_name,
           address = excluded.address,
           delivery_date = excluded.delivery_date,
           updated_at = CURRENT_TIMESTAMP
         WHERE bills.delivery_date = ''`,
        [req.user.companyId, row.billno, row.outletname, row.address, row.deliveryDate]
      );

      bill = await req.app.locals.db.get(
        'SELECT id, delivery_date FROM bills WHERE company_id = ? AND bill_no = ?',
        [req.user.companyId, row.billno]
      );
      if (bill.delivery_date !== selectedDate) {
        const error = new Error(`Bill ${row.billno} is already recorded for another sales date.`);
        error.statusCode = 409;
        throw error;
      }
      billsImported += 1;
      billIdByNumber.set(row.billno, bill.id);
      touchedBillIds.add(bill.id);
    }

    for (const row of aggregatedRows.values()) {
      if (duplicateBillNumbers.has(row.billno)) {
        continue;
      }

      const billId = billIdByNumber.get(row.billno);
      await req.app.locals.db.run(
        `INSERT INTO bill_items (bill_id, item_name, qty_ordered) VALUES (?, ?, ?)
         ON CONFLICT(bill_id, item_name) DO UPDATE SET
           qty_ordered = MAX(excluded.qty_ordered, bill_items.qty_delivered + bill_items.qty_returned)`,
        [billId, row.itemname, row.quantity]
      );
      rowsImported += row.sourceRows;
    }

    for (const billId of touchedBillIds) {
      const totals = await req.app.locals.db.get(
        'SELECT SUM(qty_ordered) AS ordered, SUM(qty_delivered) AS delivered, SUM(qty_returned) AS returned FROM bill_items WHERE bill_id = ?',
        [billId]
      );
      await req.app.locals.db.run(
        'UPDATE bills SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
        [getBillStatus(totals), billId, req.user.companyId]
      );
    }

    await req.app.locals.db.exec('COMMIT');
    transactionOpen = false;
    res.json({
      message: 'Delivery data imported successfully.',
      rowsImported,
      billsImported,
      duplicateBillsSkipped: duplicateBillNumbers.size,
      deliveryDate: selectedDate,
      salesReturnsSkipped,
      otherDatesSkipped
    });
  } catch (error) {
    if (transactionOpen) {
      await req.app.locals.db.exec('ROLLBACK');
    }
    console.error('Delivery file import failed:', error);
    res.status(error.statusCode || 400).json({ error: `Could not import this file: ${error.message}` });
  }
});

app.get('/api/bills/export', async (req, res) => {
  if (req.user.role === 'delivery_partner') {
    return res.status(403).json({ error: 'Delivery partners cannot export the full delivery report.' });
  }
  const selectedDate = normalizeDeliveryDate(req.query.date);
  if (!selectedDate) {
    return res.status(400).json({ error: 'Choose a valid sales date to export.' });
  }

  try {
    const db = req.app.locals.db;
    const bills = await db.all(
      `SELECT * FROM bills
       WHERE company_id = ? AND (delivery_date = ? OR (delivery_date = '' AND substr(created_at, 1, 10) = ?))
       ORDER BY bill_no`,
      [req.user.companyId, selectedDate, selectedDate]
    );

    if (!bills.length) {
      return res.status(404).json({ error: `There are no deliveries for ${formatSalesDate(selectedDate)} to export.` });
    }

    let orderedUnits = 0;
    let deliveredUnits = 0;
    let returnedUnits = 0;
    let pendingUnits = 0;
    let billsWithPendingItems = 0;
    let completedBills = 0;
    const summaryRows = [
      ['TAF Disti Desk - Daily Delivery Report'],
      ['Sales Date', selectedDate],
      [],
      ['Daily Metric', 'Value']
    ];
    const itemRows = [[
      'Sales Date',
      'Bill Number',
      'Outlet',
      'Delivery Area / Address',
      'Item',
      'Quantity Ordered',
      'Quantity Delivered',
      'Quantity Returned',
      'Quantity Pending',
      'Bill Status'
    ]];
    const billSummaries = [];

    for (const bill of bills) {
      const items = await db.all(
        'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY item_name',
        [bill.id]
      );
      const quantities = items.reduce((totals, item) => {
        totals.ordered += Number(item.qty_ordered);
        totals.delivered += Number(item.qty_delivered);
        totals.returned += Number(item.qty_returned);
        return totals;
      }, { ordered: 0, delivered: 0, returned: 0 });
      const remaining = Math.max(0, quantities.ordered - quantities.delivered - quantities.returned);
      const status = getBillStatus(quantities);

      orderedUnits += quantities.ordered;
      deliveredUnits += quantities.delivered;
      returnedUnits += quantities.returned;
      pendingUnits += remaining;
      if (remaining > 0) billsWithPendingItems += 1;
      if (status === 'Completed' || status === 'Returned') completedBills += 1;

      billSummaries.push([
        bill.bill_no,
        bill.outlet_name,
        bill.address,
        status,
        items.length,
        quantities.ordered,
        quantities.delivered,
        quantities.returned,
        remaining
      ]);

      for (const item of items) {
        const ordered = Number(item.qty_ordered);
        const delivered = Number(item.qty_delivered);
        const returned = Number(item.qty_returned);
        itemRows.push([
          selectedDate,
          bill.bill_no,
          bill.outlet_name,
          bill.address,
          item.item_name,
          ordered,
          delivered,
          returned,
          Math.max(0, ordered - delivered - returned),
          status
        ]);
      }
    }

    summaryRows.push(
      ['Total Bills', bills.length],
      ['Bills With Pending Items', billsWithPendingItems],
      ['Completed Or Returned Bills', completedBills],
      ['Total Units Ordered', orderedUnits],
      ['Total Units Delivered', deliveredUnits],
      ['Total Units Returned', returnedUnits],
      ['Total Units Pending', pendingUnits],
      [],
      [],
      ['Bill Number', 'Outlet', 'Delivery Area / Address', 'Status', 'Item Lines', 'Units Ordered', 'Units Delivered', 'Units Returned', 'Units Pending'],
      ...billSummaries
    );

    const workbook = createDeliveryWorkbook(summaryRows, itemRows);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="TAF-Disti-Desk-${selectedDate}.xlsx"`,
      'Content-Length': workbook.length,
      'Cache-Control': 'no-store'
    });
    res.send(Buffer.from(workbook));
  } catch (error) {
    console.error('Could not export daily delivery report:', error);
    res.status(500).json({ error: 'Could not create the Excel report. Please try again.' });
  }
});

app.get('/api/bills', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const bills = req.user.role === 'delivery_partner'
      ? await db.all(
        `SELECT bills.*, users.full_name AS assigned_partner_name, users.id AS assigned_to
         FROM bills LEFT JOIN users ON users.id = bills.assigned_to
         WHERE bills.company_id = ? AND bills.assigned_to = ? ORDER BY bills.id DESC`,
        [req.user.companyId, req.user.id]
      )
      : await db.all(
        `SELECT bills.*, users.full_name AS assigned_partner_name, users.id AS assigned_to
         FROM bills LEFT JOIN users ON users.id = bills.assigned_to
         WHERE bills.company_id = ? ORDER BY bills.id DESC`,
        [req.user.companyId]
      );
    for (const bill of bills) {
      bill.items = await db.all('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id', [bill.id]);
    }
    res.json(bills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bills/reconcile', async (req, res) => {
  const { billId, items } = req.body;
  const db = req.app.locals.db;

  if (!Number.isSafeInteger(Number(billId)) || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'A valid bill and at least one item are required.' });
  }

  const seenIds = new Set();
  try {
    await db.exec('BEGIN IMMEDIATE');
    if (req.user.role === 'manager') {
      await db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Managers assign deliveries; only the assigned delivery partner or an administrator can update progress.' });
    }
    const bill = req.user.role === 'delivery_partner'
      ? await db.get(
        'SELECT id FROM bills WHERE id = ? AND company_id = ? AND assigned_to = ?',
        [Number(billId), req.user.companyId, req.user.id]
      )
      : await db.get(
        'SELECT id FROM bills WHERE id = ? AND company_id = ?',
        [Number(billId), req.user.companyId]
      );
    if (!bill) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Delivery not found.' });
    }

    for (const item of items) {
      const id = Number(item.id);
      const delivered = Number(item.qty_delivered);
      const returned = Number(item.qty_returned);
      const currentItem = await db.get(
        'SELECT qty_ordered FROM bill_items WHERE id = ? AND bill_id = ?',
        [id, Number(billId)]
      );

      if (
        !Number.isSafeInteger(id) ||
        seenIds.has(id) ||
        !currentItem ||
        !Number.isSafeInteger(delivered) ||
        !Number.isSafeInteger(returned) ||
        delivered < 0 ||
        returned < 0 ||
        delivered + returned > currentItem.qty_ordered
      ) {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: 'Item quantities must be whole numbers and cannot exceed the ordered quantity.' });
      }

      seenIds.add(id);
      await db.run(
        'UPDATE bill_items SET qty_delivered = ?, qty_returned = ? WHERE id = ?',
        [delivered, returned, id]
      );
    }

    const totals = await db.get(
      'SELECT SUM(qty_ordered) AS ordered, SUM(qty_delivered) AS delivered, SUM(qty_returned) AS returned FROM bill_items WHERE bill_id = ?',
      [Number(billId)]
    );
    const status = getBillStatus(totals);

    await db.run(
      'UPDATE bills SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
      [status, Number(billId), req.user.companyId]
    );
    await db.exec('COMMIT');
    res.json({ message: 'Delivery progress saved.', status });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error('Could not reconcile delivery:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 10 MB or smaller.' : error.message });
  }
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  next();
});

async function start() {
  app.locals.db = await initDb();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error('Could not start the delivery app:', error);
    process.exitCode = 1;
  });
}

module.exports = app;
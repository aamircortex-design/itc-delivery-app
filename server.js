const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Readable } = require('stream');
const nodemailer = require('nodemailer');
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
  '/forgot-password.html',
  '/forgot-password',
  '/reset-password.html',
  '/reset-password',
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
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
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
const damageReportFormData = multer({ limits: { fields: 4, fieldSize: 1024 } });

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

function getAtPackWeightKg(itemName) {
  const name = String(itemName).replace(/O(?=[.,]\d)/gi, '0');
  const kgMatch = name.match(/(\d+(?:[.,]\d+)?)\s*(?:kgs?|kilograms?)/i);
  const gramMatch = name.match(/(\d+(?:[.,]\d+)?)\s*g(?![a-z])/i);
  if (!kgMatch && !gramMatch) return null;
  const weight = kgMatch
    ? Number(kgMatch[1].replace(',', '.'))
    : Number(gramMatch[1].replace(',', '.')) / 1000;
  return Number.isFinite(weight) && weight > 0 && weight <= 30 ? weight : null;
}

function getAtDisplayName(itemName, packWeightKg) {
  const name = String(itemName).toUpperCase();
  const variants = [
    [/MULTIGRAIN/, 'MULTIGRAINS'], [/SELECT/, 'SELECT'], [/RAGI/, 'RAGI'],
    [/MILLETS/, 'MILLETS'], [/SUPERIOR/, 'SUPERIOR MP'], [/MPATTA/, 'MP'],
    [/\bSRC\b|SUGAR RELEASE|SUGRA RELEASE/, 'SRC']
  ];
  const variant = variants.find(([pattern]) => pattern.test(name))?.[1];
  const size = !packWeightKg ? '' : packWeightKg < 1 ? `${Math.round(packWeightKg * 1000)}G` : `${packWeightKg}KG`;
  if (/GRAM FLOUR|BESAN/.test(name)) return ['GRAM FLOUR', size].filter(Boolean).join(' ');
  return ['ATTA', variant, size].filter(Boolean).join(' ');
}

function formatAtQuantity(row, quantity, isKg = true) {
  if (row.category !== 'AT') return `${quantity} pcs`;
  if (!row.packWeightKg) return '';
  const kg = isKg ? quantity : quantity * row.packWeightKg;
  const bags = Math.trunc((kg + Number.EPSILON) / 30);
  const pieces = Math.round((kg - bags * 30) / row.packWeightKg);
  return `${bags} bags, ${pieces} pcs`;
}

function sendXlsx(res, workbook, filename) {
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': workbook.length,
    'Cache-Control': 'no-store'
  });
  return res.send(Buffer.from(workbook));
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
    email: String(details.email || '').trim().toLowerCase(),
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
  if (user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
    throw new Error('Enter a valid email address (up to 254 characters).');
  }
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(user.userId)) {
    throw new Error('User ID must be 3 to 64 characters using letters, numbers, dots, underscores, hyphens, or @.');
  }
  if (user.password.length < 8 || user.password.length > 128) {
    throw new Error('Password must be between 8 and 128 characters.');
  }
  if (!['admin', 'manager', 'delivery_partner', 'horeca_iss_ds'].includes(user.role)) {
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
      req.user.role === 'horeca_iss_ds' &&
      req.path.startsWith('/api/') &&
      !req.path.startsWith('/api/auth/') &&
      !req.path.startsWith('/api/orders')
    ) {
      return res.status(403).json({ error: 'Your account can only take HORECA and ISS orders.' });
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

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return res.status(503).json({ error: 'Password reset email is not configured. Please contact your administrator.' });
  }

  const port = SMTP_PORT ? Number(SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(503).json({ error: 'Password reset email is not configured. Please contact your administrator.' });
  }

  let baseUrl;
  try {
    const configuredBaseUrl = process.env.APP_BASE_URL ||
      (process.env.NODE_ENV === 'production' ? '' : `${req.protocol}://${req.get('host')}`);
    const parsedBaseUrl = new URL(configuredBaseUrl);
    if (process.env.NODE_ENV === 'production' && parsedBaseUrl.protocol !== 'https:') {
      throw new Error('Production password reset links must use HTTPS.');
    }
    baseUrl = parsedBaseUrl.origin;
  } catch (error) {
    console.error('Password reset requires a valid public APP_BASE_URL:', error);
    return res.status(503).json({ error: 'Password reset email is not configured. Please contact your administrator.' });
  }

  const db = req.app.locals.db;
  let user;
  let tokenHash;
  try {
    user = await db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [email]);
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      tokenHash = getSessionTokenHash(token);
      await db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);
      await db.run(
        'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        [tokenHash, user.id, new Date(Date.now() + 30 * 60 * 1000).toISOString()]
      );

      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
      });
      const resetUrl = new URL('/reset-password.html', baseUrl);
      resetUrl.searchParams.set('token', token);
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || SMTP_USER,
        to: email,
        subject: 'Reset your TAF Disti Desk password',
        text: `Use this link within 30 minutes to choose a new password:\n\n${resetUrl.toString()}\n\nIf you did not request this, you can ignore this email.`
      });
    }

    res.json({ message: 'If an account uses that email address, a password reset link has been sent.' });
  } catch (error) {
    if (user && tokenHash) {
      await db.run('DELETE FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
    }
    console.error('Could not send password reset email:', error);
    res.status(502).json({ error: 'Could not send the password reset email. Please try again later.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (!token || token.length > 128 || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Use a valid reset link and a password between 8 and 128 characters.' });
  }

  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const reset = await db.get(
      'SELECT user_id AS userId FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?',
      [getSessionTokenHash(token), new Date().toISOString()]
    );
    if (!reset) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'This password reset link is invalid or has expired. Request a new one.' });
    }

    const hashedPassword = await hashPassword(password);
    await db.run(
      'UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?',
      [hashedPassword.salt, hashedPassword.hash, reset.userId]
    );
    await db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [reset.userId]);
    await db.run('DELETE FROM auth_sessions WHERE user_id = ?', [reset.userId]);
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ message: 'Password updated. You can now sign in with your new password.' });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK');
    console.error('Could not reset password:', error);
    res.status(500).json({ error: 'Could not reset your password. Please try again.' });
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
      `INSERT INTO users (full_name, position, company_id, company_name, email, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin')`,
      [user.fullName, user.position, companyId, user.companyName, user.email, user.userId, password.salt, password.hash]
    );
    const token = await issueSession(req.app.locals.db, result.lastID);
    await req.app.locals.db.exec('COMMIT');
    transactionOpen = false;
    setSessionCookie(res, token);
    res.status(201).json({ message: 'Administrator account created.' });
  } catch (error) {
    if (transactionOpen) await req.app.locals.db.exec('ROLLBACK');
    if (error.message.startsWith('SQLITE_CONSTRAINT')) {
      const message = error.message.includes('users.email')
        ? 'That email address is already in use.'
        : 'That user ID is already in use.';
      return res.status(409).json({ error: message });
    }
    if (/Enter |User ID|Password|role|email/i.test(error.message)) {
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
      `INSERT INTO users (full_name, position, company_id, company_name, email, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin')`,
      [user.fullName, user.position, company.lastID, user.companyName, user.email, user.userId, password.salt, password.hash]
    );
    const token = await issueSession(db, result.lastID);
    await db.exec('COMMIT');
    transactionOpen = false;
    setSessionCookie(res, token);
    res.status(201).json({ message: 'Company workspace created.' });
  } catch (error) {
    if (transactionOpen) await req.app.locals.db.exec('ROLLBACK');
    if (error.message.startsWith('SQLITE_CONSTRAINT')) {
      const message = error.message.includes('users.email')
        ? 'That email address is already in use. Choose another one.'
        : 'That user ID is already in use. Choose another one.';
      return res.status(409).json({ error: message });
    }
    if (/Enter |User ID|Password|role|email/i.test(error.message)) {
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

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/setup', async (req, res) => {
  if (req.user) return res.redirect(303, req.user.role === 'admin' ? '/users' : '/');
  const user = await req.app.locals.db.get('SELECT id FROM users LIMIT 1');
  res.redirect(303, user ? '/login' : '/setup.html');
});

app.get('/setup.html', async (req, res) => {
  if (req.user) return res.redirect(303, req.user.role === 'admin' ? '/users' : '/');
  const user = await req.app.locals.db.get('SELECT id FROM users LIMIT 1');
  if (user) return res.redirect(303, '/login.html');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
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
      `SELECT users.id, users.full_name AS fullName, users.position, users.email, companies.name AS companyName,
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

app.get('/api/rt-damage', async (req, res) => {
  const damageDate = normalizeDeliveryDate(req.query.date);
  if (!damageDate) {
    return res.status(400).json({ error: 'Choose a valid date to view RT damage reports.' });
  }
  try {
    const reports = await req.app.locals.db.all(
      `SELECT rt_damage_reports.id, rt_damage_reports.rt_number AS rtNumber,
              rt_damage_reports.outlet_name AS outletName,
              rt_damage_reports.agent_name AS agentName,
              rt_damage_reports.damage_date AS damageDate,
              rt_damage_reports.approval_status AS approvalStatus,
              rt_damage_reports.rt_entry_month AS rtEntryMonth,
              rt_damage_reports.reviewed_at AS reviewedAt,
              rt_damage_reports.review_note AS reviewNote,
              COALESCE(reviewer.full_name, '') AS reviewedBy,
              rt_damage_reports.created_at AS createdAt,
              rt_damage_reports.user_id AS submittedById,
              length(rt_damage_reports.photo_data) > 0 AS hasPhoto,
              COALESCE(users.full_name, 'Former team member') AS submittedBy
       FROM rt_damage_reports
       LEFT JOIN users ON users.id = rt_damage_reports.user_id
       LEFT JOIN users AS reviewer ON reviewer.id = rt_damage_reports.reviewed_by
       WHERE rt_damage_reports.company_id = ? AND rt_damage_reports.damage_date = ?
       ORDER BY rt_damage_reports.created_at DESC, rt_damage_reports.id DESC`,
      [req.user.companyId, damageDate]
    );
    res.json(reports.map(report => ({
      ...report,
      canEdit: report.submittedById === req.user.id && report.approvalStatus === 'Pending'
    })));
  } catch (error) {
    console.error('Could not load RT damage reports:', error);
    res.status(500).json({ error: 'Could not load RT damage reports. Please try again.' });
  }
});

app.get('/api/rt-damage/export', async (req, res) => {
  const damageDate = normalizeDeliveryDate(req.query.date);
  if (!damageDate) {
    return res.status(400).json({ error: 'Choose a valid date to export RT damage reports.' });
  }
  try {
    const reports = await req.app.locals.db.all(
      `SELECT r.id, r.rt_number AS rtNumber, r.outlet_name AS outletName,
              r.agent_name AS agentName, r.damage_date AS damageDate,
              r.approval_status AS approvalStatus, r.rt_entry_month AS rtEntryMonth,
              r.reviewed_at AS reviewedAt,
              r.review_note AS reviewNote, length(r.photo_data) > 0 AS hasPhoto,
              COALESCE(submitter.full_name, 'Former team member') AS submittedBy,
              COALESCE(reviewer.full_name, '') AS reviewedBy, r.created_at AS createdAt
       FROM rt_damage_reports r
       LEFT JOIN users AS submitter ON submitter.id = r.user_id
       LEFT JOIN users AS reviewer ON reviewer.id = r.reviewed_by
       WHERE r.company_id = ? AND r.damage_date = ?
       ORDER BY r.created_at, r.id`,
      [req.user.companyId, damageDate]
    );
    if (!reports.length) {
      return res.status(404).json({ error: `There are no RT damage reports for ${formatSalesDate(damageDate)} to export.` });
    }
    const rows = [[
      'RT Date', 'RT Number', 'Outlet Name', 'Delivery Agent', 'Submitted By',
      'RT Entry Month', 'Approval Status', 'Reviewed By', 'Reviewed At', 'Review Note',
      'Submitted At', 'Photo URL'
    ], ...reports.map(report => [
      report.damageDate,
      report.rtNumber,
      report.outletName,
      report.agentName,
      report.submittedBy,
      report.rtEntryMonth || '',
      report.approvalStatus,
      report.reviewedBy,
      report.reviewedAt || '',
      report.reviewNote,
      report.createdAt,
      report.hasPhoto ? `${req.protocol}://${req.get('host')}/api/rt-damage/${report.id}/photo` : ''
    ])];
    const workbook = createWorkbook([{
      name: 'RT Damage Reports',
      rows,
      autoFilterRow: 1
    }]);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="RT-Damage-${damageDate}.xlsx"`,
      'Content-Length': workbook.length,
      'Cache-Control': 'no-store'
    });
    res.send(Buffer.from(workbook));
  } catch (error) {
    console.error('Could not export RT damage reports:', error);
    res.status(500).json({ error: 'Could not export RT damage reports. Please try again.' });
  }
});

app.get('/api/rt-damage/:id/photo', async (req, res) => {
  const reportId = Number(req.params.id);
  if (!Number.isSafeInteger(reportId) || reportId < 1) {
    return res.status(400).json({ error: 'Choose a valid RT damage report.' });
  }
  try {
    const photo = await req.app.locals.db.get(
      `SELECT photo_mime_type AS mimeType, photo_data AS data
       FROM rt_damage_reports WHERE id = ? AND company_id = ?`,
      [reportId, req.user.companyId]
    );
    if (!photo || !photo.data?.length) return res.status(404).json({ error: 'RT damage photo not found.' });
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': photo.mimeType,
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(photo.data);
  } catch (error) {
    console.error('Could not load RT damage photo:', error);
    res.status(500).json({ error: 'Could not load the RT damage photo. Please try again.' });
  }
});

app.post('/api/rt-damage', damageReportFormData.none(), async (req, res) => {
  const rtNumber = String(req.body.rtNumber || '').trim();
  const outletName = String(req.body.outletName || '').trim();
  const damageDate = normalizeDeliveryDate(req.body.damageDate);
  if (!rtNumber || rtNumber.length > 64 || /[\u0000-\u001f\u007f]/.test(rtNumber)) {
    return res.status(400).json({ error: 'Enter an RT number of up to 64 characters.' });
  }
  if (!outletName || outletName.length > 200 || /[\u0000-\u001f\u007f]/.test(outletName)) {
    return res.status(400).json({ error: 'Enter an outlet name of up to 200 characters.' });
  }
  if (!damageDate) {
    return res.status(400).json({ error: 'Choose a valid date for the RT damage report.' });
  }
  try {
    const result = await req.app.locals.db.run(
      `INSERT INTO rt_damage_reports
         (company_id, user_id, rt_number, outlet_name, agent_name, damage_date, photo_mime_type, photo_data)
       VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', X'')`,
      [req.user.companyId, req.user.id, rtNumber, outletName, req.user.fullName, damageDate]
    );
    res.status(201).json({ message: 'RT damage report submitted for manager approval.', id: result.lastID });
  } catch (error) {
    console.error('Could not save RT damage report:', error);
    res.status(500).json({ error: 'Could not save the RT damage report. Please try again.' });
  }
});

app.put('/api/rt-damage/:id', damageReportFormData.none(), async (req, res) => {
  const reportId = Number(req.params.id);
  const rtNumber = String(req.body.rtNumber || '').trim();
  const outletName = String(req.body.outletName || '').trim();
  const damageDate = normalizeDeliveryDate(req.body.damageDate);
  if (!Number.isSafeInteger(reportId) || reportId < 1) {
    return res.status(400).json({ error: 'Choose a valid RT damage report.' });
  }
  if (!rtNumber || rtNumber.length > 64 || /[\u0000-\u001f\u007f]/.test(rtNumber)) {
    return res.status(400).json({ error: 'Enter an RT number of up to 64 characters.' });
  }
  if (!outletName || outletName.length > 200 || /[\u0000-\u001f\u007f]/.test(outletName)) {
    return res.status(400).json({ error: 'Enter an outlet name of up to 200 characters.' });
  }
  if (!damageDate) {
    return res.status(400).json({ error: 'Choose a valid date for the RT damage report.' });
  }
  try {
    const result = await req.app.locals.db.run(
      `UPDATE rt_damage_reports
       SET rt_number = ?, outlet_name = ?, agent_name = ?, damage_date = ?
       WHERE id = ? AND company_id = ? AND user_id = ? AND approval_status = 'Pending'`,
      [rtNumber, outletName, req.user.fullName, damageDate, reportId, req.user.companyId, req.user.id]
    );
    if (!result.changes) {
      return res.status(409).json({ error: 'Only your pending RT damage report can be edited. Ask an admin to reopen an approved or rejected report.' });
    }
    res.json({ message: 'RT damage report updated and remains pending manager approval.' });
  } catch (error) {
    console.error('Could not update RT damage report:', error);
    res.status(500).json({ error: 'Could not update the RT damage report. Please try again.' });
  }
});

app.post('/api/rt-damage/:id/review', async (req, res) => {
  if (req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Only a manager can approve or reject RT damage reports.' });
  }
  const reportId = Number(req.params.id);
  const decision = String(req.body.decision || '');
  const rtEntryMonth = String(req.body.rtEntryMonth || '').trim();
  const reviewNote = String(req.body.reviewNote || '').trim();
  if (!Number.isSafeInteger(reportId) || reportId < 1 || !['Approved', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Choose a valid RT damage report and approval decision.' });
  }
  if (reviewNote.length > 500) {
    return res.status(400).json({ error: 'The review note must be 500 characters or fewer.' });
  }
  if (decision === 'Approved' && !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(rtEntryMonth)) {
    return res.status(400).json({ error: 'Choose the month when this RT was entered.' });
  }
  try {
    const result = await req.app.locals.db.run(
      `UPDATE rt_damage_reports
       SET approval_status = ?, rt_entry_month = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE id = ? AND company_id = ? AND approval_status = 'Pending'`,
      [decision, decision === 'Approved' ? rtEntryMonth : null, req.user.id, new Date().toISOString(), reviewNote, reportId, req.user.companyId]
    );
    if (!result.changes) {
      return res.status(409).json({ error: 'This report is no longer pending manager review.' });
    }
    res.json({ message: `RT damage report ${decision.toLowerCase()}.`, approvalStatus: decision });
  } catch (error) {
    console.error('Could not review RT damage report:', error);
    res.status(500).json({ error: 'Could not review the RT damage report. Please try again.' });
  }
});

app.post('/api/rt-damage/:id/reopen', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can reopen an RT damage report.' });
  }
  const reportId = Number(req.params.id);
  if (!Number.isSafeInteger(reportId) || reportId < 1) {
    return res.status(400).json({ error: 'Choose a valid RT damage report.' });
  }
  try {
    const result = await req.app.locals.db.run(
      `UPDATE rt_damage_reports
       SET approval_status = 'Pending', rt_entry_month = NULL,
           reviewed_by = NULL, reviewed_at = NULL, review_note = ''
       WHERE id = ? AND company_id = ? AND approval_status IN ('Approved', 'Rejected')`,
      [reportId, req.user.companyId]
    );
    if (!result.changes) {
      return res.status(409).json({ error: 'This report is already pending or does not exist.' });
    }
    res.json({ message: 'RT damage report reopened. The submitting agent can now correct it before manager review.' });
  } catch (error) {
    console.error('Could not reopen RT damage report:', error);
    res.status(500).json({ error: 'Could not reopen the RT damage report. Please try again.' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const user = validateUserDetails({ ...req.body, companyName: req.user.companyName });
    const password = await hashPassword(user.password);
    const result = await req.app.locals.db.run(
      `INSERT INTO users (full_name, position, company_id, company_name, email, user_id, password_salt, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.fullName, user.position, req.user.companyId, req.user.companyName, user.email, user.userId, password.salt, password.hash, user.role]
    );
    res.status(201).json({ message: 'User created successfully.', id: result.lastID });
  } catch (error) {
    if (error.message.startsWith('SQLITE_CONSTRAINT')) {
      const message = error.message.includes('users.email')
        ? 'That email address is already in use.'
        : 'That user ID is already in use.';
      return res.status(409).json({ error: message });
    }
    if (/Enter |User ID|Password|role|email/i.test(error.message)) {
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

const ORDER_STATUSES = ['New', 'Confirmed', 'Delivered', 'Cancelled'];
const ORDER_CHANNELS = ['HORECA', 'ISS'];
const isOrderManager = user => ['admin', 'manager'].includes(user.role);

function requireOrderAccess(req, res, next) {
  if (!isOrderManager(req.user) && req.user.role !== 'horeca_iss_ds') {
    return res.status(403).json({ error: 'You do not have access to order taking.' });
  }
  next();
}

function requireOrderManager(req, res, next) {
  if (!isOrderManager(req.user)) {
    return res.status(403).json({ error: 'Only administrators and managers can approve and export orders.' });
  }
  next();
}

function requireOrderSalesman(req, res, next) {
  if (req.user.role !== 'horeca_iss_ds') {
    return res.status(403).json({ error: 'Only salesmen can record weekly shop visits.' });
  }
  next();
}

function requireOrderAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only administrators can upload or view the master data.' });
  }
  next();
}

function pickColumn(headers, aliases) {
  return headers.findIndex(header => aliases.includes(normalizeHeader(header)));
}

function findOrderHeaderRow(rows, requiredGroups) {
  return rows.findIndex(row => {
    const headers = row.map(normalizeHeader);
    return requiredGroups.every(group => group.some(alias => headers.includes(alias)));
  });
}

const STOCK_NAME_ALIASES = ['itemname', 'item', 'productname', 'product', 'description', 'itemdescription', 'skuname'];
const STOCK_CODE_ALIASES = ['itemcode', 'productcode', 'sku', 'code', 'itemid'];
const STOCK_RATE_ALIASES = ['rate', 'price', 'sellingprice', 'unitprice', 'mrp', 'pts', 'ptr', 'salesrate'];
const STOCK_QTY_ALIASES = ['stock', 'stockqty', 'quantity', 'qty', 'availableqty', 'availablestock', 'closingstock', 'balance'];

app.post('/api/orders/stock', requireOrderAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose the price list file to upload.' });
  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    const rows = await readTabularFile(req.file);
    const headerIndex = findOrderHeaderRow(rows, [STOCK_CODE_ALIASES, STOCK_NAME_ALIASES]);
    if (headerIndex === -1) {
      return res.status(400).json({ error: 'Could not find the Item Code and Item Description columns.' });
    }
    if ((rows[headerIndex] || []).length < 20) {
      return res.status(400).json({ error: 'The price list needs the rate columns O, Q, R and T.' });
    }
    // Price list layout: E item code, F description, O basic rate per M, Q CGST, R SGST, T net rate per M.
    const items = new Map();
    rows.slice(headerIndex + 1).forEach((row, index) => {
      const itemName = String(row[5] ?? '').trim();
      const itemCode = String(row[4] ?? '').trim();
      if (!itemName && !itemCode) return;
      const rowNumber = headerIndex + index + 2;
      if (!itemName || itemName.length > 200) throw new Error(`Row ${rowNumber} has a missing or too long item description.`);
      const baseRate = parseAmount(row[14], 'basic rate (column O)', rowNumber);
      const cgst = parseAmount(row[16], 'CGST (column Q)', rowNumber);
      const sgst = parseAmount(row[17], 'SGST (column R)', rowNumber);
      const netRate = parseAmount(row[19], 'net rate (column T)', rowNumber);
      if (baseRate < 0 || cgst < 0 || sgst < 0 || netRate < 0) {
        throw new Error(`Row ${rowNumber} has a negative price.`);
      }
      items.set(itemName.toLowerCase(), {
        itemName,
        itemCode: itemCode.slice(0, 100),
        baseRate,
        gstAmount: cgst + sgst,
        netRate
      });
    });
    if (!items.size) return res.status(400).json({ error: 'The file has no item rows.' });

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    await db.run('DELETE FROM order_stock WHERE company_id = ?', [req.user.companyId]);
    for (const item of items.values()) {
      await db.run(
        'INSERT INTO order_stock (company_id, item_code, item_name, rate, base_rate, gst_amount, stock_qty) VALUES (?, ?, ?, ?, ?, ?, 0)',
        [req.user.companyId, item.itemCode, item.itemName, item.netRate, item.baseRate, item.gstAmount]
      );
    }
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ count: items.size });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK').catch(() => {});
    if (/^Row |Could not find|The price list/.test(error.message)) return res.status(400).json({ error: error.message });
    console.error('Could not import price list:', error);
    res.status(500).json({ error: 'Could not import the price list. Please try again.' });
  }
});

const CUSTOMER_NAME_ALIASES = ['customername', 'customer', 'outletname', 'outlet', 'name', 'storename'];
const CUSTOMER_SALESMAN_ALIASES = ['salesman', 'salesmanname', 'salesperson', 'salesrep', 'dsname', 'ds'];
const CUSTOMER_CHANNEL_ALIASES = ['channel', 'channeltype', 'type', 'segment'];
const CUSTOMER_CODE_ALIASES = ['customercode', 'outletcode', 'outletid', 'customerid', 'retailercode'];
const CUSTOMER_ADDRESS_ALIASES = ['address', 'location', 'area'];
const CUSTOMER_BEAT_ALIASES = ['beat', 'beatname', 'route', 'routename'];

app.delete('/api/orders/stock', requireOrderAdmin, async (req, res) => {
  try {
    const result = await req.app.locals.db.run('DELETE FROM order_stock WHERE company_id = ?', [req.user.companyId]);
    res.json({ removed: result.changes });
  } catch (error) {
    console.error('Could not clear stock:', error);
    res.status(500).json({ error: 'Could not remove the item master.' });
  }
});

app.delete('/api/orders/customers', requireOrderAdmin, async (req, res) => {
  try {
    const result = await req.app.locals.db.run('DELETE FROM order_customers WHERE company_id = ?', [req.user.companyId]);
    res.json({ removed: result.changes });
  } catch (error) {
    console.error('Could not clear customers:', error);
    res.status(500).json({ error: 'Could not remove the customer master.' });
  }
});

app.get('/api/orders/customers', requireOrderAdmin, async (req, res) => {
  try {
    const customers = await req.app.locals.db.all(
      `SELECT id, beat, name, channel, salesman, address,
              location_lat IS NOT NULL AND location_lng IS NOT NULL AS locationCaptured,
              location_lat IS NOT NULL OR location_lng IS NOT NULL AS locationNeedsReset,
              location_accuracy_m AS locationAccuracyMeters
       FROM order_customers
       WHERE company_id = ? ORDER BY beat COLLATE NOCASE, name COLLATE NOCASE`,
      [req.user.companyId]
    );
    res.json({ customers });
  } catch (error) {
    console.error('Could not load customer master:', error);
    res.status(500).json({ error: 'Could not load the customer master.' });
  }
});

app.delete('/api/orders/customers/:id/location', requireOrderAdmin, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isSafeInteger(customerId) || customerId < 1) {
    return res.status(400).json({ error: 'Choose a valid outlet.' });
  }
  try {
    const result = await req.app.locals.db.run(
      `UPDATE order_customers
       SET location_lat = NULL, location_lng = NULL, location_accuracy_m = NULL,
           location_captured_at = NULL, location_captured_by = NULL
       WHERE id = ? AND company_id = ?
         AND (location_lat IS NOT NULL OR location_lng IS NOT NULL)`,
      [customerId, req.user.companyId]
    );
    if (!result.changes) return res.status(404).json({ error: 'This outlet has no saved location to reset.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Could not reset outlet location:', error);
    res.status(500).json({ error: 'Could not reset this outlet location.' });
  }
});

app.post('/api/orders/customers', requireOrderAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a customer file to upload.' });
  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    const rows = await readTabularFile(req.file);
    const headerIndex = findOrderHeaderRow(rows, [
      CUSTOMER_NAME_ALIASES,
      [...CUSTOMER_BEAT_ALIASES, ...CUSTOMER_SALESMAN_ALIASES, ...CUSTOMER_CHANNEL_ALIASES, ...CUSTOMER_ADDRESS_ALIASES]
    ]);
    if (headerIndex === -1) return res.status(400).json({ error: 'Could not find a Customer Name column with Beat or Salesman columns.' });
    const headers = rows[headerIndex];
    const statusCol = pickColumn(headers, ['customerstatus', 'status']);
    const nameCol = pickColumn(headers, CUSTOMER_NAME_ALIASES);
    const salesmanCol = pickColumn(headers, CUSTOMER_SALESMAN_ALIASES);
    const channelCol = pickColumn(headers, CUSTOMER_CHANNEL_ALIASES);
    const addressCol = pickColumn(headers, CUSTOMER_ADDRESS_ALIASES);
    const beatCol = pickColumn(headers, CUSTOMER_BEAT_ALIASES);
    const codeCol = pickColumn(headers, CUSTOMER_CODE_ALIASES);

    const customers = new Map();
    rows.slice(headerIndex + 1).forEach((row, index) => {
      const name = String(row[nameCol] ?? '').trim();
      if (!name) return;
      if (statusCol !== -1 && String(row[statusCol] ?? '').trim().toLowerCase() === 'inactive') return;
      const rowNumber = headerIndex + index + 2;
      const channel = channelCol === -1 ? '' : String(row[channelCol] ?? '').trim().toUpperCase();
      if (name.length > 200 || !['', ...ORDER_CHANNELS].includes(channel)) {
        throw new Error(`Row ${rowNumber} has an invalid customer name or channel (use HORECA or ISS).`);
      }
      const beat = beatCol === -1 ? '' : String(row[beatCol] ?? '').trim().slice(0, 100);
      customers.set(`${name.toLowerCase()}|${channel}`, {
        name,
        channel,
        beat,
        code: codeCol === -1 ? '' : String(row[codeCol] ?? '').trim().slice(0, 50),
        salesman: salesmanCol === -1 ? '' : String(row[salesmanCol] ?? '').trim().slice(0, 100),
        address: addressCol === -1 ? '' : String(row[addressCol] ?? '').trim().slice(0, 300)
      });
    });
    if (!customers.size) return res.status(400).json({ error: 'The file has no customer rows.' });

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const retainedCustomerIds = new Set();
    for (const customer of customers.values()) {
      const existing = await db.get(
        'SELECT id FROM order_customers WHERE company_id = ? AND name = ? AND channel = ?',
        [req.user.companyId, customer.name, customer.channel]
      );
      if (existing) {
        await db.run(
          'UPDATE order_customers SET salesman = ?, address = ?, beat = ?, customer_code = ? WHERE id = ?',
          [customer.salesman, customer.address, customer.beat, customer.code, existing.id]
        );
        retainedCustomerIds.add(existing.id);
      } else {
        const result = await db.run(
          'INSERT INTO order_customers (company_id, name, channel, salesman, address, beat, customer_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.user.companyId, customer.name, customer.channel, customer.salesman, customer.address, customer.beat, customer.code]
        );
        retainedCustomerIds.add(result.lastID);
      }
    }
    const existingCustomers = await db.all(
      'SELECT id FROM order_customers WHERE company_id = ?',
      [req.user.companyId]
    );
    for (const existing of existingCustomers) {
      if (!retainedCustomerIds.has(existing.id)) {
        await db.run('DELETE FROM order_customers WHERE id = ?', [existing.id]);
      }
    }
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ count: customers.size });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK').catch(() => {});
    if (/^Row |Could not find/.test(error.message)) return res.status(400).json({ error: error.message });
    console.error('Could not import customers:', error);
    res.status(500).json({ error: 'Could not import the customer file. Please try again.' });
  }
});

async function getVisibleCustomers(db, user, channel) {
  const params = channel === 'ALL' ? [user.companyId] : [user.companyId, channel];
  const channelFilter = channel === 'ALL' ? '' : "AND channel IN ('', ?)";
  let salesmanFilter = '';
  if (user.role === 'horeca_iss_ds') {
    salesmanFilter = 'AND (salesman = ? OR salesman = ?)';
    params.push(user.fullName, user.userId);
  }
  return db.all(
    `SELECT id, name, address, beat, channel, customer_code AS code,
            location_lat AS locationLat, location_lng AS locationLng,
            location_accuracy_m AS locationAccuracyMeters,
            location_lat IS NOT NULL AND location_lng IS NOT NULL AS locationCaptured
     FROM order_customers WHERE company_id = ? ${channelFilter} ${salesmanFilter}
     ORDER BY name COLLATE NOCASE`,
    params
  );
}

function isValidOrderWeek(weekKey) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return false;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const date = new Date(monday);
  date.setUTCDate(monday.getUTCDate() + 3);
  return date.getUTCFullYear() === year;
}

function isoWeekKeyForDate(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) return '';
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const VISIT_RADIUS_METERS = 150;
const MAX_VISIT_LOCATION_ACCURACY_METERS = 50;

function distanceInMeters(lat1, lng1, lat2, lng2) {
  const toRad = degrees => degrees * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

async function getVisitReportRows(db, companyId, date, channel, salesman = '') {
  const params = [companyId, date];
  let extraFilter = '';
  if (channel !== 'ALL') {
    extraFilter += " AND c.channel IN ('', ?)";
    params.push(channel);
  }
  if (salesman) {
    extraFilter += ' AND u.full_name = ? COLLATE NOCASE';
    params.push(salesman);
  }
  return db.all(
    `SELECT c.id AS customerId, c.name AS customerName, c.customer_code AS customerCode, c.beat, c.channel,
            c.salesman AS assignedSalesman, c.location_lat IS NOT NULL AS locationCaptured,
            c.location_lat AS shopLat, c.location_lng AS shopLng,
            v.outcome, v.outstanding_amount AS outstandingAmount, v.updated_at AS visitedAt,
            v.visit_lat AS visitLat, v.visit_lng AS visitLng, v.distance_m AS distanceMeters,
            v.location_status AS locationStatus, u.full_name AS visitedBy
     FROM order_store_visits v
     JOIN order_customers c ON c.id = v.customer_id AND c.company_id = v.company_id
     JOIN users u ON u.id = v.user_id
     WHERE v.company_id = ? AND v.visit_date = ? ${extraFilter}
     ORDER BY u.full_name COLLATE NOCASE, v.updated_at, c.name COLLATE NOCASE`,
    params
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/orders/visits/report', requireOrderManager, async (req, res) => {
  const date = String(req.query.date || '');
  const channel = String(req.query.channel || 'ALL');
  if (!ISO_DATE.test(date)) return res.status(400).json({ error: 'Choose a valid date.' });
  if (!['ALL', ...ORDER_CHANNELS].includes(channel)) return res.status(400).json({ error: 'Choose HORECA, ISS or all channels.' });
  try {
    const rows = await getVisitReportRows(req.app.locals.db, req.user.companyId, date, channel);
    res.json({
      date,
      radiusMeters: VISIT_RADIUS_METERS,
      visits: rows.map(({ shopLat, shopLng, visitLat, visitLng, ...row }) => ({
        ...row,
        shopMapUrl: shopLat === null ? '' : `https://www.google.com/maps?q=${shopLat},${shopLng}`,
        visitMapUrl: visitLat === null || visitLat === undefined ? '' : `https://www.google.com/maps?q=${visitLat},${visitLng}`
      }))
    });
  } catch (error) {
    console.error('Could not load shop check-in report:', error);
    res.status(500).json({ error: 'Could not load shop check-ins.' });
  }
});

app.get('/api/orders/visits/export', requireOrderManager, async (req, res) => {
  const weekKey = String(req.query.date || '');
  const salesman = String(req.query.salesman || '');
  if (!ISO_DATE.test(weekKey)) return res.status(400).json({ error: 'Choose a valid date.' });
  try {
    const data = await getVisitReportRows(req.app.locals.db, req.user.companyId, weekKey, 'ALL', salesman);
    const outcomeLabels = { order_taken: 'Order taken', outstanding_not_cleared: 'Outstanding not cleared', order_not_given: 'Order not given' };
    const locationLabels = { first_capture: 'Location captured (first visit)', at_shop: 'At shop', away: 'Not at shop' };
    const rows = [
      ['Date', 'Beat', 'Outlet ID', 'Outlet Name', 'Channel', 'Salesman', 'Visited', 'Outcome', 'Outstanding Amount', 'Location Check', 'Distance from Shop (m)', 'Visit Time (UTC)', 'Visit Map'],
      ...data.map(row => [
        weekKey, row.beat, row.customerCode, row.customerName, row.channel,
        row.visitedBy || row.assignedSalesman, row.outcome ? 'Yes' : 'No',
        outcomeLabels[row.outcome] || '', row.outcome === 'outstanding_not_cleared' ? row.outstandingAmount : '',
        row.outcome ? (locationLabels[row.locationStatus] || 'Not recorded') : '',
        row.outcome && row.locationStatus === 'away' ? Math.round(row.distanceMeters) : '',
        row.visitedAt || '',
        row.visitLat === null || row.visitLat === undefined ? '' : `https://www.google.com/maps?q=${row.visitLat},${row.visitLng}`
      ])
    ];
    const workbook = createWorkbook([{ name: 'Shop Check-ins', rows, autoFilterRow: 1 }]);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Shop-Checkins-${weekKey}.xlsx"`,
      'Content-Length': workbook.length,
      'Cache-Control': 'no-store'
    });
    res.send(Buffer.from(workbook));
  } catch (error) {
    console.error('Could not export shop check-ins:', error);
    res.status(500).json({ error: 'Could not export shop check-ins.' });
  }
});

app.get('/api/orders/visits', requireOrderAccess, requireOrderSalesman, async (req, res) => {
  const weekKey = String(req.query.week || '');
  const channel = String(req.query.channel || '');
  if (!isValidOrderWeek(weekKey)) return res.status(400).json({ error: 'Choose a valid week.' });
  if (!['ALL', ...ORDER_CHANNELS].includes(channel)) return res.status(400).json({ error: 'Choose HORECA, ISS or all channels.' });
  try {
    const db = req.app.locals.db;
    const customers = await getVisibleCustomers(db, req.user, channel);
    const visits = await db.all(
      `SELECT customer_id AS customerId, outcome, outstanding_amount AS outstandingAmount, updated_at AS updatedAt,
              location_status AS locationStatus, distance_m AS distanceMeters
       FROM order_store_visits WHERE company_id = ? AND user_id = ? AND week_key = ?`,
      [req.user.companyId, req.user.id, weekKey]
    );
    const visitByCustomer = new Map(visits.map(visit => [visit.customerId, visit]));
    res.json({
      week: weekKey,
      customers: customers.map(({ locationLat, locationLng, ...customer }) => ({ ...customer, visit: visitByCustomer.get(customer.id) || null }))
    });
  } catch (error) {
    console.error('Could not load weekly shop visits:', error);
    res.status(500).json({ error: 'Could not load weekly shop visits.' });
  }
});

app.post('/api/orders/customers/:id/location', requireOrderAccess, requireOrderSalesman, async (req, res) => {
  const customerId = Number(req.params.id);
  const latitude = req.body?.latitude;
  const longitude = req.body?.longitude;
  const accuracyMeters = req.body?.accuracy;
  if (!Number.isSafeInteger(customerId) || customerId < 1) {
    return res.status(400).json({ error: 'Choose a valid outlet.' });
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'The captured location is invalid. Please try again.' });
  }
  if (typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters) ||
      accuracyMeters <= 0 || accuracyMeters > MAX_VISIT_LOCATION_ACCURACY_METERS) {
    return res.status(400).json({
      error: `GPS accuracy must be ${MAX_VISIT_LOCATION_ACCURACY_METERS} m or better. Move to an open area and try again.`
    });
  }

  try {
    const db = req.app.locals.db;
    const customer = (await getVisibleCustomers(db, req.user, 'ALL')).find(row => row.id === customerId);
    if (!customer) return res.status(400).json({ error: 'Choose one of your assigned outlets.' });
    const result = await db.run(
      `UPDATE order_customers
       SET location_lat = ?, location_lng = ?, location_accuracy_m = ?,
           location_captured_at = CURRENT_TIMESTAMP, location_captured_by = ?
       WHERE id = ? AND company_id = ? AND (location_lat IS NULL OR location_lng IS NULL)`,
      [latitude, longitude, accuracyMeters, req.user.id, customerId, req.user.companyId]
    );
    if (!result.changes) {
      return res.status(409).json({ error: 'This outlet already has a saved location. Refresh outlets to check its status.' });
    }
    res.json({ ok: true, locationCaptured: true, accuracyMeters });
  } catch (error) {
    console.error('Could not capture outlet location:', error);
    res.status(500).json({ error: 'Could not capture this outlet location.' });
  }
});

app.post('/api/orders/visits', requireOrderAccess, requireOrderSalesman, async (req, res) => {
  const customerId = Number(req.body?.customerId);
  const visitDate = String(req.body?.date || '');
  const weekKey = isoWeekKeyForDate(visitDate);
  const channel = String(req.body?.channel || '');
  const outcome = String(req.body?.outcome || '');
  const amountInput = req.body?.outstandingAmount;
  const outstandingAmount = amountInput === '' || amountInput === null || amountInput === undefined
    ? NaN : Number(amountInput);
  const locationLat = typeof req.body?.latitude === 'number' ? req.body.latitude : null;
  const locationLng = typeof req.body?.longitude === 'number' ? req.body.longitude : null;
  const locationAccuracy = typeof req.body?.accuracy === 'number' ? req.body.accuracy : null;
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: 'Choose a customer.' });
  if (!weekKey) return res.status(400).json({ error: 'Choose a valid date.' });
  if (visitDate > new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'The visit date cannot be in the future.' });
  }
  if (!['ALL', ...ORDER_CHANNELS].includes(channel)) return res.status(400).json({ error: 'Choose HORECA, ISS or all channels.' });
  if (!['order_taken', 'outstanding_not_cleared', 'order_not_given'].includes(outcome)) {
    return res.status(400).json({ error: 'Choose a visit outcome.' });
  }
  if (outcome === 'outstanding_not_cleared' && (!Number.isFinite(outstandingAmount) || outstandingAmount <= 0 || outstandingAmount > 1000000000)) {
    return res.status(400).json({ error: 'Enter an outstanding amount greater than zero.' });
  }
  if (outcome !== 'outstanding_not_cleared' && Number.isFinite(outstandingAmount) && outstandingAmount !== 0) {
    return res.status(400).json({ error: 'Only enter an amount when outstanding is not cleared.' });
  }
  if ((locationLat !== null || locationLng !== null) &&
      (!Number.isFinite(locationLat) || !Number.isFinite(locationLng) || locationLat < -90 || locationLat > 90 || locationLng < -180 || locationLng > 180)) {
    return res.status(400).json({ error: 'The captured location is invalid. Please try again.' });
  }
  if (locationAccuracy === null || !Number.isFinite(locationAccuracy) ||
      locationAccuracy <= 0 || locationAccuracy > MAX_VISIT_LOCATION_ACCURACY_METERS) {
    return res.status(400).json({
      error: `GPS accuracy must be ${MAX_VISIT_LOCATION_ACCURACY_METERS} m or better. Move to an open area and try again.`
    });
  }

  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    const customer = (await getVisibleCustomers(db, req.user, channel)).find(row => row.id === customerId);
    if (!customer) return res.status(400).json({ error: 'Choose one of your assigned customers.' });
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (locationLat === null || locationLng === null) {
      throw Object.assign(new Error('Allow location access so your visit can be verified at the shop.'), { client: true });
    }
    const lockedLocation = await db.get(
      `SELECT location_lat AS latitude, location_lng AS longitude
       FROM order_customers WHERE id = ? AND company_id = ?`,
      [customerId, req.user.companyId]
    );
    if (lockedLocation?.latitude === null || lockedLocation?.latitude === undefined ||
        lockedLocation?.longitude === null || lockedLocation?.longitude === undefined) {
      throw Object.assign(new Error('Capture this outlet’s shop location before saving the visit.'), { client: true });
    }
    const distanceMeters = distanceInMeters(
      lockedLocation.latitude, lockedLocation.longitude, locationLat, locationLng
    );
    const locationStatus = distanceMeters > VISIT_RADIUS_METERS ? 'away' : 'at_shop';
    await db.run(
      `INSERT INTO order_store_visits (company_id, customer_id, user_id, week_key, outcome, outstanding_amount,
                                       visit_lat, visit_lng, distance_m, location_status, visit_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, customer_id, user_id, week_key) DO UPDATE SET
         outcome = excluded.outcome, outstanding_amount = excluded.outstanding_amount,
         visit_lat = excluded.visit_lat, visit_lng = excluded.visit_lng,
         distance_m = excluded.distance_m, location_status = excluded.location_status,
         visit_date = excluded.visit_date, updated_at = CURRENT_TIMESTAMP`,
      [req.user.companyId, customerId, req.user.id, weekKey, outcome,
        outcome === 'outstanding_not_cleared' ? outstandingAmount : 0,
        locationLat, locationLng, distanceMeters, locationStatus, visitDate]
    );
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ ok: true, locationCaptured: true, locationStatus });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK').catch(() => {});
    if (error.client) return res.status(400).json({ error: error.message });
    console.error('Could not save weekly shop visit:', error);
    res.status(500).json({ error: 'Could not save this shop visit.' });
  }
});

app.get('/api/orders/lookups', requireOrderAccess, async (req, res) => {
  const channel = String(req.query.channel || '');
  if (!ORDER_CHANNELS.includes(channel)) return res.status(400).json({ error: 'Choose HORECA or ISS.' });
  try {
    const db = req.app.locals.db;
    const customers = await getVisibleCustomers(db, req.user, channel);
    const stock = await db.all(
      `SELECT id, item_code AS itemCode, item_name AS itemName, rate, base_rate AS baseRate, gst_amount AS gstAmount
       FROM order_stock WHERE company_id = ? ORDER BY item_name COLLATE NOCASE`,
      [req.user.companyId]
    );
    res.json({ customers, stock, canUpload: req.user.role === 'admin' });
  } catch (error) {
    console.error('Could not load order lookups:', error);
    res.status(500).json({ error: 'Could not load customers and stock.' });
  }
});

app.get('/api/orders', requireOrderAccess, async (req, res) => {
  const date = String(req.query.date || '');
  const channel = String(req.query.channel || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Choose a valid date.' });
  }
  if (channel !== 'ALL' && !ORDER_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'Choose HORECA or ISS.' });
  }
  try {
    const db = req.app.locals.db;
    const params = [req.user.companyId, date];
    let channelFilter = '';
    if (channel !== 'ALL') {
      channelFilter = 'AND channel = ?';
      params.push(channel);
    }
    let ownerFilter = '';
    if (req.user.role === 'horeca_iss_ds') {
      ownerFilter = 'AND created_by = ?';
      params.push(req.user.id);
    }
    const orders = await db.all(
      `SELECT id, channel, outlet_name AS outletName, salesman, order_date AS orderDate, status, notes, created_at AS createdAt
       FROM sales_orders WHERE company_id = ? AND order_date = ? ${channelFilter} ${ownerFilter} ORDER BY id DESC`,
      params
    );
    let grandTotal = 0;
    for (const order of orders) {
      order.items = await db.all(
        'SELECT id, item_name AS itemName, qty, rate FROM sales_order_items WHERE order_id = ? ORDER BY id',
        [order.id]
      );
      order.total = order.items.reduce((sum, item) => sum + item.qty * item.rate, 0);
      if (order.status !== 'Cancelled') grandTotal += order.total;
    }
    res.json({
      orders,
      summary: { count: orders.filter(order => order.status !== 'Cancelled').length, total: grandTotal }
    });
  } catch (error) {
    console.error('Could not load orders:', error);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

app.post('/api/orders', requireOrderAccess, async (req, res) => {
  const customerId = Number(req.body?.customerId);
  const notes = String(req.body?.notes || '').trim();
  const orderDate = String(req.body?.orderDate || '');
  const channel = String(req.body?.channel || '');
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!ORDER_CHANNELS.includes(channel)) return res.status(400).json({ error: 'Choose HORECA or ISS.' });
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: 'Select a customer.' });
  if (notes.length > 500) return res.status(400).json({ error: 'Notes are too long.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) return res.status(400).json({ error: 'Choose a valid order date.' });
  if (!items.length || items.length > 200) return res.status(400).json({ error: 'Add at least one item.' });

  const quantities = new Map();
  for (const item of items) {
    const stockId = Number(item?.stockId);
    const qty = Math.round(Number(item?.qty) * 1000) / 1000;
    if (!Number.isInteger(stockId) || !Number.isFinite(qty) || qty < 0.001 || qty > 100000) {
      return res.status(400).json({ error: 'Each item needs a valid product and a quantity in M of at least 0.001.' });
    }
    quantities.set(stockId, Math.round(((quantities.get(stockId) || 0) + qty) * 1000) / 1000);
  }

  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    const customer = (await getVisibleCustomers(db, req.user, channel)).find(row => row.id === customerId);
    if (!customer) return res.status(400).json({ error: 'Select one of your customers.' });

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const lines = [];
    for (const [stockId, qty] of quantities) {
      const stock = await db.get(
        'SELECT id, item_code AS itemCode, item_name AS itemName, rate FROM order_stock WHERE id = ? AND company_id = ?',
        [stockId, req.user.companyId]
      );
      if (!stock) throw Object.assign(new Error('An item is no longer in the price list. Refresh and try again.'), { client: true });
      lines.push({ itemCode: stock.itemCode, itemName: stock.itemName, rate: stock.rate, qty });
    }
    const salesman = req.user.role === 'horeca_iss_ds' ? req.user.fullName : String(req.body?.salesman || '').trim().slice(0, 100);
    const result = await db.run(
      `INSERT INTO sales_orders (company_id, channel, outlet_name, outlet_code, salesman, order_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, channel, customer.name, customer.code, salesman, orderDate, notes, req.user.id]
    );
    for (const line of lines) {
      await db.run(
        'INSERT INTO sales_order_items (order_id, item_code, item_name, qty, rate) VALUES (?, ?, ?, ?, ?)',
        [result.lastID, line.itemCode, line.itemName, line.qty, line.rate]
      );
    }
    await db.exec('COMMIT');
    transactionOpen = false;
    res.status(201).json({ id: result.lastID, total: lines.reduce((sum, line) => sum + line.qty * line.rate, 0) });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK').catch(() => {});
    if (error.client) return res.status(400).json({ error: error.message });
    console.error('Could not save order:', error);
    res.status(500).json({ error: 'Could not save the order. Please try again.' });
  }
});

app.get('/api/orders/export', requireOrderManager, async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Choose a valid date.' });
  }
  try {
    const lines = await req.app.locals.db.all(
      `SELECT o.id, o.status, o.channel, o.outlet_code AS outletCode, o.outlet_name AS outletName, o.salesman,
              i.item_code AS itemCode, i.item_name AS itemName, i.qty
       FROM sales_orders o JOIN sales_order_items i ON i.order_id = o.id
       WHERE o.company_id = ? AND o.order_date = ?
       ORDER BY o.channel, o.outlet_name COLLATE NOCASE, o.id, i.id`,
      [req.user.companyId, date]
    );
    if (!lines.length) {
      return res.status(404).json({ error: 'There are no orders for this date to export.' });
    }
    const statusLabels = { New: 'Pending approval', Confirmed: 'Approved', Delivered: 'Delivered', Cancelled: 'Rejected / Cancelled' };
    const rows = [
      ['Order No', 'Order Date', 'Channel', 'Status', 'Salesman', 'Outlet ID', 'Outlet Name', 'Item Code', 'Item Name', 'Qty (M)'],
      ...lines.map(line => [line.id, date, line.channel, statusLabels[line.status] || line.status, line.salesman, line.outletCode, line.outletName, line.itemCode, line.itemName, line.qty])
    ];
    const workbook = createWorkbook([{ name: 'Orders', rows, autoFilterRow: 1 }]);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Orders-${date}.xlsx"`,
      'Content-Length': workbook.length,
      'Cache-Control': 'no-store'
    });
    res.send(Buffer.from(workbook));
  } catch (error) {
    console.error('Could not export orders:', error);
    res.status(500).json({ error: 'Could not export orders. Please try again.' });
  }
});

app.get('/api/orders/comparison', requireOrderManager, async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Choose a valid date.' });
  }
  try {
    const db = req.app.locals.db;
    const ordered = await db.all(
      `SELECT o.channel, o.outlet_code AS outletCode, o.outlet_name AS outletName, i.item_code AS itemCode,
              i.item_name AS itemName, SUM(i.qty) AS qty
       FROM sales_orders o JOIN sales_order_items i ON i.order_id = o.id
       WHERE o.company_id = ? AND o.order_date = ? AND o.status != 'Cancelled'
       GROUP BY lower(trim(o.outlet_name)), lower(trim(i.item_code)), i.item_name`,
      [req.user.companyId, date]
    );
    if (!ordered.length) return res.status(404).json({ error: 'There are no orders for this date to compare.' });
    const billed = await db.all(
      `SELECT outlet_name AS outletName, item_code AS itemCode, item_name AS itemName, SUM(quantity) AS qty
       FROM profitability_sales WHERE company_id = ? AND sales_date = ? AND quantity > 0
         AND lower(trim(item_code)) IN (SELECT lower(trim(item_code)) FROM order_stock WHERE company_id = ? AND item_code != '')
       GROUP BY lower(trim(outlet_name)), lower(trim(item_code)), item_name`,
      [req.user.companyId, date, req.user.companyId]
    );
    const key = (outlet, code) => `${outlet.trim().toLowerCase()}|${code.trim().toLowerCase()}`;
    const lines = new Map();
    for (const row of ordered) {
      lines.set(key(row.outletName, row.itemCode), { ...row, orderedQty: row.qty, billedQty: 0 });
    }
    const orderedOutlets = new Set(ordered.map(row => row.outletName.trim().toLowerCase()));
    for (const row of billed) {
      if (!orderedOutlets.has(row.outletName.trim().toLowerCase())) continue;
      const k = key(row.outletName, row.itemCode);
      if (lines.has(k)) lines.get(k).billedQty += row.qty;
      else lines.set(k, { outletCode: '', outletName: row.outletName, itemCode: row.itemCode, itemName: row.itemName, orderedQty: 0, billedQty: row.qty });
    }
    const round = value => Math.round(value * 1000) / 1000;
    const rows = [
      ['Date', 'Channel', 'Outlet ID', 'Outlet Name', 'Item Code', 'Item Name', 'Ordered Qty (M)', 'Billed Qty (M)', 'Difference (M)', 'Remark'],
      ...[...lines.values()]
        .sort((a, b) => a.outletName.localeCompare(b.outletName) || a.itemName.localeCompare(b.itemName))
        .map(line => {
          const difference = round(line.billedQty - line.orderedQty);
          const remark = !line.orderedQty ? 'Billed, not ordered'
            : !line.billedQty ? 'Not billed'
            : difference === 0 ? 'Fully billed'
            : difference < 0 ? 'Short billed' : 'Over billed';
          return [date, line.channel || '', line.outletCode, line.outletName, line.itemCode, line.itemName, round(line.orderedQty), round(line.billedQty), difference, remark];
        })
    ];
    const workbook = createWorkbook([{ name: 'Ordered vs Billed', rows, autoFilterRow: 1 }]);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Ordered-vs-Billed-${date}.xlsx"`,
      'Content-Length': workbook.length,
      'Cache-Control': 'no-store'
    });
    res.send(Buffer.from(workbook));
  } catch (error) {
    console.error('Could not export comparison:', error);
    res.status(500).json({ error: 'Could not export the comparison. Please try again.' });
  }
});

app.patch('/api/orders/:id/items', requireOrderManager, async (req, res) => {
  const updates = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!updates.length) return res.status(400).json({ error: 'No quantities to update.' });
  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    const order = await db.get('SELECT id FROM sales_orders WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    for (const update of updates) {
      const itemId = Number(update?.id);
      const qty = Math.round(Number(update?.qty) * 1000) / 1000;
      if (!Number.isInteger(itemId) || !Number.isFinite(qty) || qty < 0 || qty > 100000) {
        throw Object.assign(new Error('Enter valid quantities in M (0 removes an item).'), { client: true });
      }
      if (qty === 0) await db.run('DELETE FROM sales_order_items WHERE id = ? AND order_id = ?', [itemId, order.id]);
      else await db.run('UPDATE sales_order_items SET qty = ? WHERE id = ? AND order_id = ?', [qty, itemId, order.id]);
    }
    const remaining = await db.get('SELECT COUNT(*) AS count FROM sales_order_items WHERE order_id = ?', [order.id]);
    if (!remaining.count) throw Object.assign(new Error('An order needs at least one item. Cancel the order instead.'), { client: true });
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ ok: true });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK').catch(() => {});
    if (error.client) return res.status(400).json({ error: error.message });
    console.error('Could not update order quantities:', error);
    res.status(500).json({ error: 'Could not update the quantities.' });
  }
});

app.patch('/api/orders/:id/status', requireOrderManager, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Choose a valid status.' });
  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const order = await db.get('SELECT id, status FROM sales_orders WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (!order) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(404).json({ error: 'Order not found.' });
    }
    const approving = ['Confirmed', 'Delivered'].includes(status);
    await db.run(
      'UPDATE sales_orders SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?',
      [status, approving ? req.user.id : null, approving ? new Date().toISOString() : null, order.id]
    );
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ ok: true });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK').catch(() => {});
    if (error.client) return res.status(400).json({ error: error.message });
    console.error('Could not update order:', error);
    res.status(500).json({ error: 'Could not update the order.' });
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

app.patch('/api/bills/assignments', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only administrators and managers can assign deliveries.' });
  }

  const billIds = req.body.billIds;
  const partnerId = Number(req.body.partnerId);
  if (
    !Array.isArray(billIds) ||
    billIds.length < 1 ||
    billIds.length > 500 ||
    billIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1) ||
    new Set(billIds.map(Number)).size !== billIds.length ||
    !Number.isSafeInteger(partnerId) ||
    partnerId < 1
  ) {
    return res.status(400).json({ error: 'Choose one or more valid bills and a delivery partner.' });
  }

  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const partner = await db.get(
      "SELECT id FROM users WHERE id = ? AND company_id = ? AND role = 'delivery_partner'",
      [partnerId, req.user.companyId]
    );
    if (!partner) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'Choose an active delivery partner from your workspace.' });
    }

    const placeholders = billIds.map(() => '?').join(', ');
    const matchingBills = await db.all(
      `SELECT id FROM bills WHERE company_id = ? AND id IN (${placeholders})`,
      [req.user.companyId, ...billIds.map(Number)]
    );
    if (matchingBills.length !== billIds.length) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(404).json({ error: 'One or more selected bills were not found in your workspace.' });
    }

    await db.run(
      `UPDATE bills SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP
       WHERE company_id = ? AND id IN (${placeholders})`,
      [partnerId, req.user.companyId, ...billIds.map(Number)]
    );
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ message: `${billIds.length} ${billIds.length === 1 ? 'bill' : 'bills'} assigned successfully.`, assignedCount: billIds.length });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK');
    console.error('Could not bulk assign deliveries:', error);
    res.status(500).json({ error: 'Could not assign the selected deliveries. Please try again.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const normalizeHeader = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const profitabilityExcludedItemsByDate = new Map([
  ['2026-10-06', new Set(['pfdso0544', '12863'])]
]);
const headerAliases = {
  billno: ['billno', 'billnumber', 'invoiceno', 'invoicenumber', 'orderid', 'purchaseinvoiceno', 'supplierinvoiceno'],
  outletname: ['outletname', 'outlet', 'customername', 'storename', 'recipient'],
  address: ['address', 'deliveryaddress', 'location'],
  salesman: ['salesman', 'salesmanname', 'salesperson', 'salespersonname', 'salesrep', 'salesrepresentative', 'representative', 'dsname'],
  itemname: ['itemname', 'item', 'productname', 'product'],
  category: ['category', 'cagetory', 'productcategory', 'itemcategory'],
  itemcode: ['itemcode', 'productcode', 'sku', 'marketsku', 'itemid'],
  quantity: ['quantity', 'qty', 'qtyordered', 'orderedquantity', 'invoiceqty', 'purchaseqty', 'qtypurchased', 'receivedqty'],
  salesReturnQty: ['salesreturnqty', 'salesreturnquantity', 'salesreturnqnty', 'returnqty', 'returnquantity', 'returnedqty', 'srqty'],
  invoiceDate: ['invoicedate', 'invoicesrdate', 'invoicesalesdate', 'salesdate', 'billdate', 'date', 'purchasedate', 'purchaseregisterdate'],
  grossAmount: ['grossamount', 'pretaxamount', 'taxablevalue', 'taxableamount', 'assessablevalue'],
  totalAmount: ['total'],
  rfaAmount: ['totaldiscount', 'discountamount', 'claimamount', 'rfa', 'rfaamount'],
  outputTax: ['taxgroupamount', 'outputtax', 'outputgst', 'gstamount', 'taxamount'],
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

function roundCurrencyAmount(value) {
  const sign = Math.sign(value);
  return sign * Math.round((Math.abs(value) + 1e-9) * 100) / 100;
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

function createWorkbook(sheets) {
  const sheetOverrides = sheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  const workbookSheets = sheets.map((sheet, index) =>
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join('');
  const workbookRelationships = sheets.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('');
  const worksheetFiles = Object.fromEntries(sheets.map((sheet, index) => [
    `xl/worksheets/sheet${index + 1}.xml`,
    createWorksheet(sheet.rows, { autoFilterRow: sheet.autoFilterRow })
  ]));
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        ${sheetOverrides}
      </Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>${workbookSheets}</sheets>
      </workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${workbookRelationships}
      </Relationships>`,
    ...worksheetFiles
  };

  return zipSync(Object.fromEntries(
    Object.entries(files).map(([name, contents]) => [name, strToU8(contents)])
  ));
}

function createDeliveryWorkbook(summaryRows, itemRows) {
  return createWorkbook([
    { name: 'Daily Summary', rows: summaryRows, autoFilterRow: 14 },
    { name: 'Delivery Items', rows: itemRows, autoFilterRow: 1 }
  ]);
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

async function readTabularFile(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.csv') {
    const options = { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true };
    try {
      return parse(file.buffer, options);
    } catch (error) {
      if (!String(error.code || '').includes('QUOTE')) throw error;
      const lines = file.buffer.toString('utf8').split(/\r\n|\n|\r/);
      const headerLineIndex = lines.findIndex(line => {
        const normalizedLine = normalizeHeader(line);
        return ['billno', 'quantity', 'invoiceDate', 'grossAmount'].every(field =>
          headerAliases[field].some(alias => normalizedLine.includes(alias))
        );
      });
      if (headerLineIndex === -1) throw error;
      return parse(lines.slice(headerLineIndex).join('\n'), {
        ...options,
        relax_quotes: true
      });
    }
  }
  const worksheets = await readXlsxFile(Readable.from([file.buffer]));
  return worksheets[0]?.data || [];
}

async function readTabularWorksheets(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.csv') {
    return [{
      name: path.basename(file.originalname),
      data: parse(file.buffer, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true })
    }];
  }
  return readXlsxFile(Readable.from([file.buffer]));
}

function parseAmount(value, fieldName, rowNumber) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text) {
    throw new Error(`Row ${rowNumber} is missing ${fieldName}.`);
  }
  const amount = Number(text);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1e12) {
    throw new Error(`Row ${rowNumber} has an invalid ${fieldName}.`);
  }
  return amount;
}

function findReportHeaderIndex(sheetRows, requiredAliases) {
  return sheetRows.findIndex(row => {
    const available = new Set(row.map(normalizeHeader));
    return requiredAliases.every(field =>
      headerAliases[field].some(alias => available.has(normalizeHeader(alias)))
    );
  });
}

async function parseDeliveryRows(file) {
  const sheetRows = await readTabularFile(file);

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

function parseBillNumber(billNo) {
  const match = /^(.*?)(\d+)$/.exec(String(billNo || '').trim());
  return match ? { prefix: match[1], number: Number(match[2]), width: match[2].length } : null;
}

const BILL_TRACKERS = {
  profitability: {
    settings: 'bill_tracker_settings',
    ignored: 'bill_tracker_ignored',
    billsSql: 'SELECT bill_no, MIN(sales_date) AS salesDate FROM profitability_sales WHERE company_id = ? AND bill_no LIKE ? GROUP BY bill_no'
  },
  deliveries: {
    settings: 'delivery_bill_tracker_settings',
    ignored: 'delivery_bill_tracker_ignored',
    billsSql: "SELECT bill_no, MIN(COALESCE(NULLIF(delivery_date, ''), substr(created_at, 1, 10))) AS salesDate FROM bills WHERE company_id = ? AND bill_no LIKE ? GROUP BY bill_no"
  }
};

function getBillTracker(source) {
  return BILL_TRACKERS[source === 'deliveries' ? 'deliveries' : 'profitability'];
}

async function buildBillTracker(db, companyId, source) {
  const tracker = getBillTracker(source);
  const setting = await db.get(`SELECT start_bill FROM ${tracker.settings} WHERE company_id = ?`, [companyId]);
  const start = setting ? parseBillNumber(setting.start_bill) : null;
  if (!start) return { configured: false };

  const present = new Map();
  const bills = await db.all(
    tracker.billsSql,
    [companyId, `${start.prefix.replace(/[%_]/g, '')}%`]
  );
  for (const bill of bills) {
    const parsed = parseBillNumber(bill.bill_no);
    if (parsed && parsed.prefix.toLowerCase() === start.prefix.toLowerCase() && parsed.number >= start.number) {
      present.set(parsed.number, bill.salesDate);
    }
  }
  const ignored = new Set((await db.all(`SELECT bill_no FROM ${tracker.ignored} WHERE company_id = ?`, [companyId]))
    .map(row => String(row.bill_no).toLowerCase()));

  const numbers = [...present.keys()].sort((a, b) => a - b);
  const last = numbers.length ? numbers[numbers.length - 1] : start.number;
  const format = number => `${start.prefix}${String(number).padStart(start.width, '0')}`;
  const missing = [];
  const ignoredList = [];
  let lastDateSeen = '';
  for (let number = start.number; number <= last && number - start.number <= 50000; number += 1) {
    if (present.has(number)) {
      lastDateSeen = present.get(number);
      continue;
    }
    if (ignored.has(format(number).toLowerCase())) {
      ignoredList.push(format(number));
    } else {
      missing.push({ billNo: format(number), afterDate: lastDateSeen });
    }
  }
  return {
    configured: true,
    startBill: format(start.number),
    lastBill: numbers.length ? format(last) : '',
    lastDate: numbers.length ? present.get(last) : '',
    importedCount: numbers.length,
    ignoredCount: ignoredList.length,
    ignoredList: ignoredList.slice(0, 500),
    missingCount: missing.length,
    missing: missing.slice(0, 500)
  };
}

app.get('/api/profitability/bill-tracker', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied.' });
  try {
    res.json(await buildBillTracker(req.app.locals.db, req.user.companyId, req.query.source));
  } catch (error) {
    console.error('Bill tracker failed:', error);
    res.status(500).json({ error: 'Could not check bill numbers.' });
  }
});

app.put('/api/profitability/bill-tracker', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied.' });
  const startBill = String(req.body?.startBill || '').trim();
  if (!parseBillNumber(startBill) || startBill.length > 60) {
    return res.status(400).json({ error: 'Enter the first bill number to track, for example I/26-27/010400.' });
  }
  const db = req.app.locals.db;
  const tracker = getBillTracker(req.body?.source);
  await db.run(
    `INSERT INTO ${tracker.settings} (company_id, start_bill) VALUES (?, ?)
     ON CONFLICT(company_id) DO UPDATE SET start_bill = excluded.start_bill`,
    [req.user.companyId, startBill]
  );
  res.json(await buildBillTracker(db, req.user.companyId, req.body?.source));
});

app.post('/api/profitability/bill-tracker/ignore', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can ignore or restore bill numbers.' });
  const billNo = String(req.body?.billNo || '').trim();
  if (!parseBillNumber(billNo) || billNo.length > 60 || typeof req.body?.ignored !== 'boolean') {
    return res.status(400).json({ error: 'Choose a valid bill number.' });
  }
  const db = req.app.locals.db;
  const tracker = getBillTracker(req.body?.source);
  if (req.body.ignored) {
    await db.run(`INSERT OR IGNORE INTO ${tracker.ignored} (company_id, bill_no) VALUES (?, ?)`, [req.user.companyId, billNo]);
  } else {
    await db.run(`DELETE FROM ${tracker.ignored} WHERE company_id = ? AND bill_no = ?`, [req.user.companyId, billNo]);
  }
  res.json(await buildBillTracker(db, req.user.companyId, req.body?.source));
});
const UPLOAD_LOCK_DAYS = 3;

function getIndiaToday() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

async function getUploadLock(db, companyId) {
  const today = getIndiaToday();
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - UPLOAD_LOCK_DAYS * 86400000).toISOString().slice(0, 10);
  const bills = await db.all(
    `SELECT bill_no AS billNo, outlet_name AS outletName, status,
            CASE WHEN status = 'Not supplied' AND NULLIF(not_supplied_from_date, '') IS NOT NULL
                 THEN not_supplied_from_date
                 ELSE COALESCE(NULLIF(delivery_date, ''), substr(created_at, 1, 10)) END AS billDate
     FROM bills
     WHERE company_id = ?
       AND status NOT IN ('Completed', 'Returned', 'Cancelled')
       AND (CASE WHEN status = 'Not supplied' AND NULLIF(not_supplied_from_date, '') IS NOT NULL
                 THEN not_supplied_from_date
                 ELSE COALESCE(NULLIF(delivery_date, ''), substr(created_at, 1, 10)) END) < ?
     ORDER BY billDate, bill_no`,
    [companyId, cutoff]
  );
  const count = bills.length;
  return {
    locked: count > 0,
    days: UPLOAD_LOCK_DAYS,
    count,
    bills: bills.slice(0, 50),
    message: count
      ? `Sales uploads are disabled: ${count} deliver${count === 1 ? 'y has' : 'ies have'} been pending for more than ${UPLOAD_LOCK_DAYS} days (oldest bill dated ${bills[0].billDate}). Complete, return or cancel them to continue.`
      : ''
  };
}

async function rejectIfUploadLocked(req, res) {
  const lock = await getUploadLock(req.app.locals.db, req.user.companyId);
  if (lock.locked) {
    res.status(423).json({ error: lock.message });
    return true;
  }
  return false;
}

app.get('/api/upload-lock', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.json({ locked: false, count: 0, bills: [], message: '' });
  res.json(await getUploadLock(req.app.locals.db, req.user.companyId));
});

app.post('/api/profitability/sales', upload.single('file'), async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required to import the sales register.' });
  }
  if (await rejectIfUploadLocked(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'Choose a sales register file to upload.' });

  let transactionOpen = false;
  try {
    const selectedDate = normalizeDeliveryDate(req.body.deliveryDate);
    if (!selectedDate) return res.status(400).json({ error: 'Choose a valid sales date before importing.' });

    const sheetRows = await readTabularFile(req.file);
    const headerIndex = findReportHeaderIndex(sheetRows, ['billno', 'quantity', 'invoiceDate', 'grossAmount']);
    if (headerIndex === -1) {
      return res.status(400).json({
        error: 'The sales register must include Invoice No., Invoice / SR Date, Invoice Qty, Gross Amount, and Item Name or Item Code.'
      });
    }

    const headers = sheetRows[headerIndex];
    const normalizedHeaders = new Set(headers.map(normalizeHeader));
    const hasItem = ['itemname', 'itemcode'].some(field =>
      headerAliases[field].some(alias => normalizedHeaders.has(normalizeHeader(alias)))
    );
    const hasOutputTax = headerAliases.outputTax.some(alias =>
      normalizedHeaders.has(normalizeHeader(alias))
    );
    if (!hasItem || !hasOutputTax) {
      return res.status(400).json({
        error: 'The sales register must include an Item Name or Item Code column and a Tax Group Amount / output tax column.'
      });
    }

    const aggregated = new Map();
    for (const [index, sourceRow] of sheetRows.slice(headerIndex + 1).entries()) {
      if (!sourceRow.some(value => String(value ?? '').trim())) continue;
      const rowNumber = headerIndex + index + 2;
      const row = mapRow(headers, sourceRow);
      const salesDate = normalizeDeliveryDate(row.invoiceDate);
      if (!salesDate) throw new Error(`Row ${rowNumber} has an invalid or missing invoice date.`);
      if (salesDate !== selectedDate) continue;
      if (!row.billno || !row.itemname && !row.itemcode) {
        throw new Error(`Row ${rowNumber} is missing an invoice number or item name/code.`);
      }
      const quantity = row.quantity === '' ? 0 : parseAmount(row.quantity, 'invoice quantity', rowNumber);
      const salesReturnQty = row.salesReturnQty === '' ? 0 : Math.abs(parseAmount(row.salesReturnQty, 'sales return quantity', rowNumber));
      const grossAmount = row.grossAmount === '' ? 0 : parseAmount(row.grossAmount, 'Gross Amount', rowNumber);
      const totalAmount = row.totalAmount === '' ? null : parseAmount(row.totalAmount, 'Total', rowNumber);
      const rfaAmount = row.rfaAmount === '' ? 0 : parseAmount(row.rfaAmount, 'Total Discount / RFA', rowNumber);
      const outputTax = row.outputTax === '' ? 0 : parseAmount(row.outputTax, 'Tax Group Amount / output tax', rowNumber);
      if (quantity === 0 && salesReturnQty === 0 && grossAmount === 0 && rfaAmount === 0 && outputTax === 0) continue;

      const itemCode = row.itemcode.trim();
      const itemName = row.itemname.trim() || itemCode;
      const category = row.category.trim() || 'Uncategorized';
      const key = [
        salesDate,
        row.billno.trim().toLocaleLowerCase(),
        itemCode.toLocaleLowerCase(),
        itemName.toLocaleLowerCase()
      ].join('\u0000');
      const existing = aggregated.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.salesReturnQty += salesReturnQty;
        existing.grossAmount += grossAmount;
        if (totalAmount !== null) existing.totalAmount = (existing.totalAmount ?? 0) + totalAmount;
        existing.rfaAmount += rfaAmount;
        existing.outputTax += outputTax;
      } else {
        aggregated.set(key, {
          salesDate,
          billNo: row.billno.trim(),
          outletName: row.outletname.trim(),
          itemCode,
          itemName,
          category,
          quantity,
          salesReturnQty,
          grossAmount,
          totalAmount,
          rfaAmount,
          outputTax
        });
      }
    }

    const rows = [...aggregated.values()];
    if (!rows.length) {
      return res.status(400).json({
        error: `The sales register has no sales lines for ${selectedDate}. No other dates were imported.`
      });
    }
    const db = req.app.locals.db;

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    await db.run(
      'DELETE FROM profitability_sales WHERE company_id = ? AND sales_date = ?',
      [req.user.companyId, selectedDate]
    );
    for (const row of rows) {
      await db.run(
        `INSERT INTO profitability_sales
          (company_id, sales_date, bill_no, outlet_name, item_code, item_name, quantity, sales_return_qty, sales_category, gross_amount, rfa_amount, output_tax, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, sales_date, bill_no, item_code, item_name)
         DO UPDATE SET outlet_name = excluded.outlet_name, quantity = excluded.quantity,
           sales_return_qty = excluded.sales_return_qty,
           sales_category = excluded.sales_category,
           gross_amount = excluded.gross_amount, rfa_amount = excluded.rfa_amount, output_tax = excluded.output_tax,
           total_amount = excluded.total_amount`,
        [
          req.user.companyId, row.salesDate, row.billNo, row.outletName, row.itemCode, row.itemName,
          row.quantity, row.salesReturnQty, row.category, row.grossAmount, row.rfaAmount, row.outputTax, row.totalAmount
        ]
      );
    }
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({
      message: `Imported ${rows.length} item lines for ${selectedDate}.`,
      importedLines: rows.length,
      salesDate: selectedDate
    });
  } catch (error) {
    if (transactionOpen) await req.app.locals.db.exec('ROLLBACK');
    if (error.message.startsWith('Row ')) return res.status(400).json({ error: error.message });
    if (String(error.code || '').includes('QUOTE')) {
      return res.status(400).json({
        error: `The sales-register CSV has invalid quoting near line ${error.lines || 'unknown'}. Re-export it as CSV or upload the Excel workbook.`
      });
    }
    console.error('Could not import profitability sales data:', error);
    res.status(500).json({ error: 'Could not import the sales register. Please check the file and try again.' });
  }
});

app.post('/api/profitability/product-costs', upload.single('file'), async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required to import profitability product costs.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Choose a SKU purchase-cost file to upload.' });

  let transactionOpen = false;
  try {
    const worksheets = await readTabularWorksheets(req.file);
    const costAliases = {
      itemCode: ['sku', 'itemcode', 'productcode', 'marketsku', 'itemid'],
      itemName: ['itemname', 'productname', 'productdescription', 'item', 'product'],
      purchaseCost: ['purchaseprice', 'purchaseunitcost', 'unitpurchaseprice', 'costprice', 'costperunit'],
      gstRate: ['gstpercentage', 'gstpercent', 'gstrate', 'gst'],
      netPts: ['netpts', 'netpt', 'netptrs', 'netptprice', 'netpurchaseprice'],
      originalPts: ['originalpts', 'originalpt', 'originalptrs'],
      invoiceDiscount: ['invdisc', 'invdiscpercent', 'invoicedisc', 'invoicediscpercent', 'invoicediscount', 'invoicediscountpercent'],
      sgstRate: ['sgst', 'sgstpercentage', 'sgstpercent', 'sgstrate', 'sgstutgstrate'],
      cgstRate: ['cgst', 'cgstpercentage', 'cgstpercent', 'cgstrate'],
      igstRate: ['igst', 'igstpercentage', 'igstpercent', 'igstrate'],
      invoiceDate: ['invoicedate', 'purchasedate', 'purchaseinvoicedate', 'date'],
      invoiceRef: ['invoicerefno', 'invoicerefnumber', 'invoiceno', 'invoicenumber'],
      priceIncludingGst: [
        'netpriceperpcincludinggst',
        'netpriceperpieceincludinggst',
        'netpriceperpcinclgst',
        'priceperpcincludinggst',
        'unitpriceincludinggst'
      ]
    };
    const matchingWorksheets = [];
    for (const worksheet of worksheets) {
      const headerIndex = worksheet.data.findIndex(row => {
        const headers = row.map(normalizeHeader);
        const indexes = {
          itemCode: headers.findIndex(header => costAliases.itemCode.includes(header)),
          itemName: headers.findIndex(header => costAliases.itemName.includes(header)),
          purchaseCost: headers.findIndex(header => costAliases.purchaseCost.includes(header)),
          gstRate: headers.findIndex(header => costAliases.gstRate.includes(header)),
          priceIncludingGst: headers.findIndex(header => costAliases.priceIncludingGst.includes(header)),
          netPts: headers.findIndex(header => costAliases.netPts.includes(header)),
          originalPts: headers.findIndex(header => costAliases.originalPts.includes(header)),
          invoiceDiscount: headers.findIndex(header => costAliases.invoiceDiscount.includes(header)),
          sgstRate: headers.findIndex(header => costAliases.sgstRate.includes(header)),
          cgstRate: headers.findIndex(header => costAliases.cgstRate.includes(header)),
          igstRate: headers.findIndex(header => costAliases.igstRate.includes(header)),
          invoiceDate: headers.findIndex(header => costAliases.invoiceDate.includes(header)),
          invoiceRef: headers.findIndex(header => costAliases.invoiceRef.includes(header))
        };
        const hasItemCode = indexes.itemCode !== -1;
        const hasPreTaxPurchasePrice = indexes.purchaseCost !== -1;
        const hasGrossUnitPriceAndGst = indexes.priceIncludingGst !== -1 && indexes.gstRate !== -1;
        const hasPtsAndTaxRates = (indexes.originalPts !== -1 || indexes.netPts !== -1) &&
          indexes.invoiceDiscount !== -1 &&
          ((indexes.sgstRate !== -1 && indexes.cgstRate !== -1) || indexes.igstRate !== -1);
        if (hasItemCode && (hasPreTaxPurchasePrice || hasGrossUnitPriceAndGst || hasPtsAndTaxRates)) {
          return indexes;
        }
        return false;
      });
      if (headerIndex !== -1) {
        const headerIndexes = worksheet.data[headerIndex].map(normalizeHeader);
        matchingWorksheets.push({
          sheetName: String(worksheet.sheet || worksheet.name || 'Worksheet'),
          sheetRows: worksheet.data,
          headerIndex,
          headerIndexes: {
            itemCode: headerIndexes.findIndex(header => costAliases.itemCode.includes(header)),
            itemName: headerIndexes.findIndex(header => costAliases.itemName.includes(header)),
            purchaseCost: headerIndexes.findIndex(header => costAliases.purchaseCost.includes(header)),
            gstRate: headerIndexes.findIndex(header => costAliases.gstRate.includes(header)),
            priceIncludingGst: headerIndexes.findIndex(header => costAliases.priceIncludingGst.includes(header)),
            netPts: headerIndexes.findIndex(header => costAliases.netPts.includes(header)),
            originalPts: headerIndexes.findIndex(header => costAliases.originalPts.includes(header)),
            invoiceDiscount: headerIndexes.findIndex(header => costAliases.invoiceDiscount.includes(header)),
            sgstRate: headerIndexes.findIndex(header => costAliases.sgstRate.includes(header)),
            cgstRate: headerIndexes.findIndex(header => costAliases.cgstRate.includes(header)),
            igstRate: headerIndexes.findIndex(header => costAliases.igstRate.includes(header)),
            invoiceDate: headerIndexes.findIndex(header => costAliases.invoiceDate.includes(header)),
            invoiceRef: headerIndexes.findIndex(header => costAliases.invoiceRef.includes(header))
          }
        });
      }
    }
    const worksheetsWithProducts = matchingWorksheets.filter(({ sheetRows, headerIndex }) =>
      sheetRows.slice(headerIndex + 1).some(row => row.some(value => String(value ?? '').trim()))
    );
    if (!worksheetsWithProducts.length) {
      if (!matchingWorksheets.length) {
        return res.status(400).json({
          error: 'No worksheet contains the required product-code and purchase-price columns. Check that the selected worksheet has the column headers and SKU data.'
        });
      }
      return res.status(400).json({ error: 'The purchase worksheet contains no SKU rows.' });
    }
    if (worksheetsWithProducts.length > 1) {
      return res.status(400).json({
        error: `More than one worksheet contains purchase data (${worksheetsWithProducts.map(sheet => sheet.sheetName).join(', ')}). Keep the purchase list on one worksheet or upload only the intended worksheet.`
      });
    }
    const { sheetName, sheetRows, headerIndex, headerIndexes } = worksheetsWithProducts[0];
    const productsBySku = new Map();
    let skippedNonProductRows = 0;
    for (const [index, sourceRow] of sheetRows.slice(headerIndex + 1).entries()) {
      if (!sourceRow.some(value => String(value ?? '').trim())) continue;
      const rowNumber = headerIndex + index + 2;
      const itemCode = String(sourceRow[headerIndexes.itemCode] ?? '').trim();
      if (!itemCode) {
        skippedNonProductRows += 1;
        continue;
      }
      const skuKey = itemCode.toLocaleLowerCase();

      let purchaseUnitCost;
      let inputGstRate = null;
      let purchaseDate = '';
      let invoiceRef = '';
      if (
        (headerIndexes.originalPts !== -1 || headerIndexes.netPts !== -1) &&
        headerIndexes.invoiceDiscount !== -1 &&
        ((headerIndexes.sgstRate !== -1 && headerIndexes.cgstRate !== -1) || headerIndexes.igstRate !== -1)
      ) {
        const ptsIndex = headerIndexes.originalPts !== -1 ? headerIndexes.originalPts : headerIndexes.netPts;
        const ptsLabel = headerIndexes.originalPts !== -1 ? 'Original PTS' : 'NET PTS';
        const pts = parseAmount(sourceRow[ptsIndex], ptsLabel, rowNumber);
        const discountRate = parseAmount(sourceRow[headerIndexes.invoiceDiscount], 'Inv Disc%', rowNumber);
        if (pts < 0) throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has a negative ${ptsLabel}.`);
        if (discountRate > 100) throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has an invalid Inv Disc% value.`);
        let gstRate = 0;
        if (headerIndexes.igstRate !== -1) {
          gstRate = parseAmount(sourceRow[headerIndexes.igstRate], 'IGST percentage', rowNumber);
          if (gstRate === 0 && headerIndexes.sgstRate !== -1 && headerIndexes.cgstRate !== -1) {
            const sgstRate = parseAmount(sourceRow[headerIndexes.sgstRate], 'SGST percentage', rowNumber);
            const cgstRate = parseAmount(sourceRow[headerIndexes.cgstRate], 'CGST percentage', rowNumber);
            gstRate = sgstRate + cgstRate;
          }
        } else {
          const sgstRate = parseAmount(sourceRow[headerIndexes.sgstRate], 'SGST percentage', rowNumber);
          const cgstRate = parseAmount(sourceRow[headerIndexes.cgstRate], 'CGST percentage', rowNumber);
          gstRate = sgstRate + cgstRate;
        }
        if (gstRate < 0 || gstRate > 100) {
          throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has an invalid GST percentage.`);
        }
        const discountedPrice = pts * (1 - discountRate / 100);
        if (discountedPrice < 0) throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has a negative discounted purchase price.`);
        const purchasePriceIncludingGst = discountedPrice * (1 + gstRate / 100);
        purchaseUnitCost = purchasePriceIncludingGst / (1 + gstRate / 100);
        inputGstRate = gstRate;
        if (headerIndexes.invoiceDate !== -1) {
          purchaseDate = normalizeDeliveryDate(sourceRow[headerIndexes.invoiceDate]);
          if (!purchaseDate) {
            throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has an invalid or missing Invoice Date.`);
          }
        } else if (headerIndexes.invoiceRef !== -1) {
          throw new Error(`The purchase worksheet "${sheetName}" needs an Invoice Date column to select the latest price for each SKU.`);
        }
        if (headerIndexes.invoiceRef !== -1) {
          invoiceRef = String(sourceRow[headerIndexes.invoiceRef] ?? '').trim();
        }
      } else if (headerIndexes.priceIncludingGst !== -1 && headerIndexes.gstRate !== -1) {
        const priceIncludingGst = parseAmount(
          sourceRow[headerIndexes.priceIncludingGst],
          'net price per piece including GST',
          rowNumber
        );
        inputGstRate = parseAmount(sourceRow[headerIndexes.gstRate], 'GST percentage', rowNumber);
        if (priceIncludingGst < 0) throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has a negative net price per piece.`);
        if (inputGstRate < 0 || inputGstRate > 100) throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has an invalid GST percentage.`);
        purchaseUnitCost = priceIncludingGst / (1 + inputGstRate / 100);
      } else {
        purchaseUnitCost = parseAmount(
          sourceRow[headerIndexes.purchaseCost],
          'purchase price',
          rowNumber
        );
        if (purchaseUnitCost < 0) throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has a negative purchase price.`);
        if (headerIndexes.gstRate !== -1) {
          inputGstRate = parseAmount(sourceRow[headerIndexes.gstRate], 'GST percentage', rowNumber);
          if (inputGstRate < 0 || inputGstRate > 100) {
            throw new Error(`Row ${rowNumber} in worksheet "${sheetName}" has an invalid GST percentage.`);
          }
        }
      }
      const itemName = String(sourceRow[headerIndexes.itemName] ?? '').trim() || itemCode;
      const product = { itemCode, itemName, purchaseUnitCost, inputGstRate, purchaseDate, invoiceRef };
      const existing = productsBySku.get(skuKey);
      if (!existing || purchaseDate > existing.purchaseDate ||
        (purchaseDate === existing.purchaseDate &&
          invoiceRef.localeCompare(existing.invoiceRef, undefined, { numeric: true }) >= 0)) {
        productsBySku.set(skuKey, product);
      }
    }
    const products = [...productsBySku.values()];
    if (!products.length) return res.status(400).json({ error: 'The file contains no SKU purchase-cost rows.' });

    const db = req.app.locals.db;
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const existingProducts = await db.all(
      'SELECT item_code FROM profitability_product_costs WHERE company_id = ?',
      [req.user.companyId]
    );
    const existingSkus = new Set(existingProducts.map(product => String(product.item_code).toLocaleLowerCase()));
    let addedCount = 0;
    let updatedCount = 0;
    for (const product of products) {
      if (existingSkus.has(product.itemCode.toLocaleLowerCase())) updatedCount += 1;
      else addedCount += 1;
      await db.run(
        `INSERT INTO profitability_product_costs
          (company_id, item_code, item_name, purchase_unit_cost, input_gst_rate)
         VALUES (?, ?, ?, ?, COALESCE(?, 0))
         ON CONFLICT(company_id, item_code) WHERE item_code <> '' DO UPDATE SET
           item_name = excluded.item_name,
           purchase_unit_cost = excluded.purchase_unit_cost,
           input_gst_rate = COALESCE(?, profitability_product_costs.input_gst_rate),
           updated_at = CURRENT_TIMESTAMP`,
        [
          req.user.companyId,
          product.itemCode,
          product.itemName,
          product.purchaseUnitCost,
          product.inputGstRate,
          product.inputGstRate
        ]
      );
    }
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({
      message: `Worksheet "${sheetName}" processed using the latest purchase record: ${addedCount} new ${addedCount === 1 ? 'SKU' : 'SKUs'} added and ${updatedCount} existing ${updatedCount === 1 ? 'SKU' : 'SKUs'} updated.`,
      importedCount: products.length,
      addedCount,
      updatedCount,
      skippedNonProductRows
    });
  } catch (error) {
    if (transactionOpen) await req.app.locals.db.exec('ROLLBACK');
    if (error.message.startsWith('Row ')) return res.status(400).json({ error: error.message });
    console.error('Could not import profitability product costs:', error);
    res.status(500).json({ error: 'Could not import SKU purchase costs. Please check the file and try again.' });
  }
});

// All 2 kg atta packs are the same stock regardless of variant or code.
const AT_EXTRA_PRODUCTS = [
  { category: 'AT', itemCode: '', itemName: 'ATTA SELECT 5KG' },
  { category: 'AT', itemCode: '', itemName: 'ATTA MULTIGRAINS 5KG' },
  { category: 'BC', itemCode: '', itemName: 'GRAM FLOUR 200G' },
  { category: 'AT', itemCode: '', itemName: 'ATTA SRC 1KG' }
];

function canonicalAtProduct(product) {
  const name = String(product.itemName || '').toUpperCase();
  if (/GRAM FLOUR|BESAN/.test(name) && (getAtPackWeightKg(product.itemName) === 0.2 || product.itemName === 'GRAM FLOUR 200G')) {
    return { ...product, category: 'BC', itemCode: '', itemName: 'GRAM FLOUR 200G' };
  }
  if (product.category !== 'AT') return product;
  const weight = getAtPackWeightKg(product.itemName);
  const merged = itemName => ({ ...product, itemCode: '', itemName });
  if (weight === 2) return merged('ATTA 2KG');
  if (weight === 5 && /SELECT/.test(name)) return merged('ATTA SELECT 5KG');
  if (weight === 5 && /MULTIGRAIN/.test(name)) return merged('ATTA MULTIGRAINS 5KG');
  if (/\bSRC\b|SUGAR RELEASE|SUGRA RELEASE/.test(name)) return merged('ATTA SRC 1KG');
  return product;
}

const atProductKey = row => {
  const product = canonicalAtProduct(row);
  return `${product.category}\u0000${String(product.itemCode || '').trim().toLowerCase()}\u0000${String(product.itemName || '').trim().toLowerCase()}`;
};

async function loadAtAssignmentRows(db, companyId, date) {
  return db.all(
    `SELECT agentId, agentName, category, itemCode, itemName, SUM(quantity) AS quantity,
            COUNT(DISTINCT billNo) AS billCount, MAX(assigned) AS assigned
     FROM (
       SELECT bills.assigned_to AS agentId, COALESCE(users.full_name, 'Unassigned') AS agentName,
              CASE WHEN UPPER(ps.sales_category) LIKE '%06 ATTA%' THEN 'AT' ELSE 'BC' END AS category,
              TRIM(ps.item_code) AS itemCode, TRIM(ps.item_name) AS itemName,
              ps.quantity AS quantity, ps.bill_no AS billNo,
              COALESCE((SELECT s.assigned FROM at_assignment_status s
                        WHERE s.company_id = ps.company_id AND s.assign_date = ps.sales_date
                          AND s.agent_key = COALESCE(bills.assigned_to, 0)
                          AND s.sales_category = CASE WHEN UPPER(ps.sales_category) LIKE '%06 ATTA%' THEN 'AT' ELSE 'BC' END
                          AND s.item_code = TRIM(ps.item_code) AND s.item_name = TRIM(ps.item_name)), 0) AS assigned
       FROM profitability_sales ps
       LEFT JOIN bills ON bills.company_id = ps.company_id AND bills.bill_no = ps.bill_no
       LEFT JOIN users ON users.id = bills.assigned_to
       WHERE ps.company_id = ? AND ps.sales_date = ? AND (UPPER(ps.sales_category) LIKE '%06 ATTA%' OR UPPER(ps.sales_category) LIKE '%50 BREAKFAST CEREAL%')
     )
     GROUP BY agentId, category, itemCode, itemName
     HAVING SUM(quantity) <> 0`,
    [companyId, date]
  );
}

// An item is locked for managers once its stock is tallied and every agent's assignment is confirmed.
async function getLockedAtProducts(db, companyId, date) {
  const tallied = await db.all(
    `SELECT UPPER(TRIM(sales_category)) AS category, TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName
     FROM at_stock_daily WHERE company_id = ? AND stock_date = ? AND tallied = 1`,
    [companyId, date]
  );
  const assignmentRows = await loadAtAssignmentRows(db, companyId, date);
  const state = new Map();
  for (const row of assignmentRows) {
    const key = atProductKey(row);
    const current = state.get(key) || { count: 0, assigned: 0 };
    current.count += 1;
    current.assigned += row.assigned ? 1 : 0;
    state.set(key, current);
  }
  const locked = new Set();
  for (const row of tallied) {
    const key = atProductKey(row);
    const current = state.get(key);
    if (current && current.count === current.assigned) locked.add(key);
  }
  return locked;
}

// Old per-variant rows for a merged 2 kg product are folded into the canonical row.
async function clearAtVariantRows(db, companyId, date, product, clearOpening = true) {
  if (product.itemName !== 'ATTA 2KG' && product.itemName !== 'GRAM FLOUR 200G') return;
  const rows = await db.all(
    `SELECT item_code AS itemCode, item_name AS itemName FROM at_stock_daily
     WHERE company_id = ? AND stock_date = ? AND UPPER(TRIM(sales_category)) = 'AT'`,
    [companyId, date]
  );
  for (const row of rows) {
    if (product.category === 'AT' && row.itemName === product.itemName && row.itemCode === product.itemCode) continue;
    if (atProductKey({ category: 'AT', ...row }) !== atProductKey(product)) continue;
    await db.run(
      `UPDATE at_stock_daily SET ${clearOpening ? 'opening_qty = NULL, ' : ''}purchase_qty = 0, damaged_qty = 0, tallied = 0
       WHERE company_id = ? AND stock_date = ? AND sales_category = ? AND item_code = ? AND item_name = ?`,
      [companyId, date, 'AT', row.itemCode, row.itemName]
    );
  }
}

app.get('/api/profitability/at-stock', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required for AT stock.' });
  }
  const selectedDate = normalizeDeliveryDate(req.query.date);
  if (!selectedDate) {
    return res.status(400).json({ error: 'Choose a valid AT stock date.' });
  }

  try {
    const products = await req.app.locals.db.all(
      `SELECT DISTINCT CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName
       FROM profitability_sales
       WHERE company_id = ? AND CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END IS NOT NULL
       UNION
       SELECT DISTINCT UPPER(TRIM(sales_category)) AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName
       FROM at_stock_daily
       WHERE company_id = ?`,
      [req.user.companyId, req.user.companyId]
    );
    const salesRows = await req.app.locals.db.all(
      `SELECT sales_date AS stockDate, CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName,
              SUM(quantity) AS salesQty, SUM(sales_return_qty) AS returnQty
       FROM profitability_sales
       WHERE company_id = ? AND sales_date <= ?
         AND CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END IS NOT NULL
       GROUP BY sales_date, CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END, TRIM(item_code), TRIM(item_name)`,
      [req.user.companyId, selectedDate]
    );
    const stockRows = await req.app.locals.db.all(
      `SELECT stock_date AS stockDate, UPPER(TRIM(sales_category)) AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName,
              opening_qty AS openingQty, purchase_qty AS purchaseQty, damaged_qty AS damagedQty, tallied,
              opening_bags_input AS openingBags, opening_pcs_input AS openingPcs
       FROM at_stock_daily
       WHERE company_id = ? AND stock_date <= ?`,
      [req.user.companyId, selectedDate]
    );

    const getProductKey = atProductKey;
    const salesByProduct = new Map();
    for (const row of salesRows) {
      const key = getProductKey(row);
      if (!salesByProduct.has(key)) salesByProduct.set(key, new Map());
      const byDate = salesByProduct.get(key);
      const existing = byDate.get(row.stockDate);
      if (existing) {
        existing.salesQty = Number(existing.salesQty || 0) + Number(row.salesQty || 0);
        existing.returnQty = Number(existing.returnQty || 0) + Number(row.returnQty || 0);
      } else {
        byDate.set(row.stockDate, { ...row, salesQty: Number(row.salesQty || 0), returnQty: Number(row.returnQty || 0) });
      }
    }
    const stockByProduct = new Map();
    for (const rawRow of stockRows) {
      // Gram flour used to be stored as AT in kg; it is now a BC product counted in pieces.
      const row = rawRow.category === 'AT' && canonicalAtProduct(rawRow).category === 'BC'
        ? {
            ...rawRow,
            openingQty: rawRow.openingQty === null ? null : rawRow.openingQty / 0.2,
            purchaseQty: rawRow.purchaseQty / 0.2,
            damagedQty: rawRow.damagedQty / 0.2,
            openingBags: null,
            openingPcs: null
          }
        : rawRow;
      const key = getProductKey(row);
      if (!stockByProduct.has(key)) stockByProduct.set(key, new Map());
      const byDate = stockByProduct.get(key);
      const existing = byDate.get(row.stockDate);
      if (existing) {
        if (row.openingQty !== null && row.openingQty !== undefined) {
          existing.openingQty = Number(existing.openingQty || 0) + Number(row.openingQty);
        }
        existing.purchaseQty = Number(existing.purchaseQty || 0) + Number(row.purchaseQty || 0);
        existing.damagedQty = Number(existing.damagedQty || 0) + Number(row.damagedQty || 0);
        existing.tallied = existing.tallied || row.tallied;
      } else {
        byDate.set(row.stockDate, { ...row });
      }
    }

    const lockedProducts = await getLockedAtProducts(req.app.locals.db, req.user.companyId, selectedDate);
    const uniqueProducts = new Map();
    for (const product of [...products, ...AT_EXTRA_PRODUCTS]) {
      const canonical = canonicalAtProduct(product);
      uniqueProducts.set(atProductKey(canonical), canonical);
    }
    const rows = [...uniqueProducts.values()].map(product => {
      const key = getProductKey(product);
      const sales = salesByProduct.get(key) || new Map();
      const stock = stockByProduct.get(key) || new Map();
      const dates = [...new Set([...sales.keys(), ...stock.keys(), selectedDate])]
        .filter(date => date <= selectedDate)
        .sort();
      // Tracking starts on the first date the admin enters an opening balance.
      let onHand = null;
      let selectedDay;
      for (const date of dates) {
        const sale = sales.get(date);
        const stockEntry = stock.get(date);
        const hasOpening = stockEntry?.openingQty !== null && stockEntry?.openingQty !== undefined;
        if (!hasOpening && onHand === null && date !== selectedDate) continue;
        const opening = hasOpening ? Number(stockEntry.openingQty) : onHand ?? 0;
        const unitWeight = product.category === 'AT' ? (getAtPackWeightKg(product.itemName) || 1) : 1;
        const salesQty = Number(sale?.salesQty || 0) * unitWeight;
        const returnQty = Number(sale?.returnQty || 0) * unitWeight;
        const purchaseQty = Number(stockEntry?.purchaseQty || 0);
        const damagedQty = Number(stockEntry?.damagedQty || 0);
        onHand = opening + purchaseQty + returnQty - salesQty - damagedQty;
        if (date === selectedDate) {
          const unitForInput = product.category === 'AT' ? (getAtPackWeightKg(product.itemName) || 1) : 1;
          const rawMatches = hasOpening && stockEntry.openingBags !== null && stockEntry.openingBags !== undefined &&
            Math.abs(stockEntry.openingBags * 30 + stockEntry.openingPcs * unitForInput - opening) < 0.001;
          selectedDay = {
            openingQty: opening, purchaseQty, damagedQty, salesQty, returnQty, closingQty: onHand,
            tallied: Boolean(stockEntry?.tallied),
            openingInput: rawMatches ? { bags: stockEntry.openingBags, pcs: stockEntry.openingPcs } : null
          };
        }
      }
      const packWeightKg = product.category === 'AT' ? getAtPackWeightKg(product.itemName) : null;
      return {
        ...product,
        ...selectedDay,
        locked: lockedProducts.has(atProductKey(product)),
        packWeightKg,
        displayName: product.category === 'AT' ? getAtDisplayName(product.itemName, packWeightKg) : product.itemName
      };
    }).sort((a, b) => a.category.localeCompare(b.category) || a.itemName.localeCompare(b.itemName));

    if (req.query.format === 'xlsx') {
      return sendXlsx(res, createWorkbook([{
        name: 'AT Stock',
        rows: [
          ['Category', 'Product', 'Opening', 'Sales', 'Sales return', 'Purchase', 'Damaged', 'Closing', 'Tallied'],
          ...rows.map(row => [
            row.category, row.displayName,
            formatAtQuantity(row, row.openingQty), formatAtQuantity(row, row.salesQty),
            formatAtQuantity(row, row.returnQty), formatAtQuantity(row, row.purchaseQty),
            formatAtQuantity(row, row.damagedQty), formatAtQuantity(row, row.closingQty),
            row.tallied ? 'Yes' : 'No'
          ])
        ],
        autoFilterRow: 1
      }]), `AT-Stock-${selectedDate}.xlsx`);
    }
    res.json({ date: selectedDate, rows });
  } catch (error) {
    console.error('AT stock report failed:', error);
    res.status(500).json({ error: 'Unable to load AT stock for this date.' });
  }
});

async function loadDamageWarehouse(db, companyId, toDate) {
  const damaged = await db.all(
    `SELECT UPPER(TRIM(sales_category)) AS category, TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName, SUM(damaged_qty) AS qty
     FROM at_stock_daily WHERE company_id = ? AND stock_date <= ? AND damaged_qty > 0
     GROUP BY UPPER(TRIM(sales_category)), TRIM(item_code), TRIM(item_name)`,
    [companyId, toDate]
  );
  const removals = await db.all(
    `SELECT id, stock_date AS date, UPPER(TRIM(sales_category)) AS category, TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName,
            qty, remarks, created_by AS createdBy
     FROM at_stock_removals WHERE company_id = ? AND stock_date <= ? ORDER BY stock_date DESC, id DESC`,
    [companyId, toDate]
  );
  const products = new Map();
  const entryFor = row => {
    const product = canonicalAtProduct({ category: row.category, itemCode: row.itemCode, itemName: row.itemName });
    const key = atProductKey(product);
    if (!products.has(key)) {
      const packWeightKg = product.category === 'AT' ? getAtPackWeightKg(product.itemName) : null;
      products.set(key, {
        category: product.category, itemCode: product.itemCode, itemName: product.itemName, packWeightKg,
        displayName: product.category === 'AT' ? getAtDisplayName(product.itemName, packWeightKg) : product.itemName,
        damagedQty: 0, removedQty: 0, removals: []
      });
    }
    return products.get(key);
  };
  for (const row of damaged) {
    const rawGramFlourInKg = row.category === 'AT' && canonicalAtProduct(row).category === 'BC';
    entryFor(row).damagedQty += Number(row.qty) / (rawGramFlourInKg ? 0.2 : 1);
  }
  for (const row of removals) {
    const entry = entryFor(row);
    entry.removedQty += Number(row.qty);
    entry.removals.push({ id: row.id, date: row.date, quantity: Number(row.qty), remarks: row.remarks, createdBy: row.createdBy });
  }
  return [...products.values()].map(entry => {
    const format = quantity => formatAtQuantity(entry, quantity);
    return {
      ...entry,
      balanceQty: Math.max(0, entry.damagedQty - entry.removedQty),
      damagedDisplay: format(entry.damagedQty),
      removedDisplay: format(entry.removedQty),
      balanceDisplay: format(Math.max(0, entry.damagedQty - entry.removedQty)),
      removals: entry.removals.map(removal => ({ ...removal, display: format(removal.quantity) }))
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName));
}

app.post('/api/profitability/at-stock/removals', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can remove stock from the warehouse.' });
  }
  const selectedDate = normalizeDeliveryDate(req.body?.date);
  const category = String(req.body?.category || '').trim().toUpperCase();
  const itemCode = String(req.body?.itemCode || '').trim();
  const itemName = String(req.body?.itemName || '').trim();
  const quantity = req.body?.quantity;
  const remarks = String(req.body?.remarks || '').trim();
  if (!selectedDate || !['AT', 'BC'].includes(category) || !itemName || itemName.length > 300 || itemCode.length > 100 ||
      typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000000 || remarks.length > 500) {
    return res.status(400).json({ error: 'Enter a product, a quantity greater than zero and remarks up to 500 characters.' });
  }
  const product = canonicalAtProduct({ category, itemCode, itemName });
  if (product.category === 'AT' && !getAtPackWeightKg(product.itemName)) {
    return res.status(400).json({ error: 'This product needs a pack size in its name before stock can be removed.' });
  }
  try {
    const warehouse = await loadDamageWarehouse(req.app.locals.db, req.user.companyId, selectedDate);
    const match = warehouse.find(entry => atProductKey(entry) === atProductKey(product));
    if (!match || quantity > match.balanceQty + 0.0001) {
      return res.status(400).json({ error: `Only ${match ? match.balanceDisplay : '0'} is available in the damaged warehouse for this product.` });
    }
    await req.app.locals.db.run(
      `INSERT INTO at_stock_removals (company_id, stock_date, sales_category, item_code, item_name, qty, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, selectedDate, product.category, product.itemCode, product.itemName, quantity, remarks, req.user.fullName || req.user.username || '']
    );
    res.json({ message: 'Stock removed from the warehouse.' });
  } catch (error) {
    console.error('AT stock removal failed:', error);
    res.status(500).json({ error: 'Unable to remove this stock. Please try again.' });
  }
});

app.delete('/api/profitability/at-stock/removals/:id', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can undo a stock removal.' });
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Choose a valid removal.' });
  const result = await req.app.locals.db.run('DELETE FROM at_stock_removals WHERE id = ? AND company_id = ?', [id, req.user.companyId]);
  if (!result.changes) return res.status(404).json({ error: 'This removal no longer exists.' });
  res.json({ message: 'Stock removal undone.' });
});

app.put('/api/profitability/at-stock/:date', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required for AT stock.' });
  }
  const selectedDate = normalizeDeliveryDate(req.params.date);
  if (!selectedDate) return res.status(400).json({ error: 'Choose a valid AT stock date.' });
  if (!req.body || !Array.isArray(req.body.entries) || req.body.entries.length > 5000) {
    return res.status(400).json({ error: 'Provide a valid list of AT stock entries.' });
  }
  const canEditOpening = req.user.role === 'admin';
  const entries = [];
  for (const entry of req.body.entries) {
    const category = String(entry.category || '').trim().toUpperCase();
    const itemCode = String(entry.itemCode || '').trim();
    const itemName = String(entry.itemName || '').trim();
    if (!['AT', 'BC'].includes(category) || !itemName || itemName.length > 300 || itemCode.length > 100) {
      return res.status(400).json({ error: 'An AT stock entry contains invalid product information.' });
    }
    const openingQty = canEditOpening ? entry.openingQty : null;
    const purchaseQty = entry.purchaseQty;
    const damagedQty = entry.damagedQty;
    if (
      (canEditOpening && openingQty !== null && (typeof openingQty !== 'number' || !Number.isFinite(openingQty) || openingQty < 0 || openingQty > 1000000000)) ||
      (typeof purchaseQty !== 'number' || !Number.isFinite(purchaseQty) || purchaseQty < 0 || purchaseQty > 1000000000) ||
      (typeof damagedQty !== 'number' || !Number.isFinite(damagedQty) || damagedQty < 0 || damagedQty > 1000000000)
    ) {
      return res.status(400).json({ error: 'Opening stock and purchases must be valid non-negative quantities.' });
    }
    const product = canonicalAtProduct({ category, itemCode, itemName });
    const validInput = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000000;
    const openingInput = canEditOpening && category === 'AT' && validInput(entry.openingBags) && validInput(entry.openingPcs)
      ? { bags: entry.openingBags, pcs: entry.openingPcs }
      : null;
    entries.push({ ...product, openingQty, purchaseQty, damagedQty, openingInput });
  }

  try {
    const db = req.app.locals.db;
    const knownProducts = await db.all(
      `SELECT DISTINCT CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName
       FROM profitability_sales
       WHERE company_id = ? AND CASE WHEN UPPER(item_name) LIKE '%GRAM FLOUR%' OR UPPER(item_name) LIKE '%BESAN%' THEN 'BC' WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' WHEN UPPER(sales_category) LIKE '%50 BREAKFAST CEREAL%' THEN 'BC' END IS NOT NULL
       UNION
       SELECT DISTINCT UPPER(TRIM(sales_category)) AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName
       FROM at_stock_daily
       WHERE company_id = ?`,
      [req.user.companyId, req.user.companyId]
    );
    const productKey = atProductKey;
    const knownProductKeys = new Set([...knownProducts, ...AT_EXTRA_PRODUCTS].map(productKey));
    const lockedProducts = req.user.role === 'admin' ? new Set() : await getLockedAtProducts(db, req.user.companyId, selectedDate);
    for (const entry of entries) {
      if (lockedProducts.has(atProductKey(entry))) continue;
      if (!knownProductKeys.has(productKey(entry))) {
        return res.status(400).json({ error: 'An AT stock product is not in the uploaded sales data.' });
      }
      const packWeightKg = entry.category === 'AT' ? getAtPackWeightKg(entry.itemName) : null;
      if (entry.category === 'AT' && !packWeightKg) {
        return res.status(400).json({ error: `The item name "${entry.itemName}" must include a pack weight up to 30 kg.` });
      }
      // The client already sends AT quantities in kg.
      const openingBaseQty = entry.openingQty;
      const purchaseBaseQty = entry.purchaseQty;
      const damagedBaseQty = entry.damagedQty;
      await db.run(
        `INSERT INTO at_stock_daily
           (company_id, stock_date, sales_category, item_code, item_name, opening_qty, purchase_qty, damaged_qty, opening_bags_input, opening_pcs_input)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, stock_date, sales_category, item_code, item_name)
         DO UPDATE SET
           opening_qty = COALESCE(excluded.opening_qty, at_stock_daily.opening_qty),
           opening_bags_input = CASE WHEN excluded.opening_qty IS NULL THEN at_stock_daily.opening_bags_input ELSE excluded.opening_bags_input END,
           opening_pcs_input = CASE WHEN excluded.opening_qty IS NULL THEN at_stock_daily.opening_pcs_input ELSE excluded.opening_pcs_input END,
           purchase_qty = excluded.purchase_qty,
           damaged_qty = excluded.damaged_qty`,
        [
          req.user.companyId, selectedDate, entry.category, entry.itemCode, entry.itemName,
          openingBaseQty, purchaseBaseQty, damagedBaseQty,
          entry.openingInput?.bags ?? null, entry.openingInput?.pcs ?? null
        ]
      );
      await clearAtVariantRows(db, req.user.companyId, selectedDate, entry, entry.openingQty !== null);
    }
    res.json({ message: 'AT stock updated.' });
  } catch (error) {
    console.error('AT stock update failed:', error);
    res.status(500).json({ error: 'Unable to save AT stock changes.' });
  }
});

app.patch('/api/profitability/at-stock/:date/tallied', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required for AT stock.' });
  }
  const selectedDate = normalizeDeliveryDate(req.params.date);
  const category = String(req.body?.category || '').trim().toUpperCase();
  const itemCode = String(req.body?.itemCode || '').trim();
  const itemName = String(req.body?.itemName || '').trim();
  if (!selectedDate || !['AT', 'BC'].includes(category) || !itemName || itemName.length > 300 || itemCode.length > 100 || typeof req.body?.tallied !== 'boolean') {
    return res.status(400).json({ error: 'Provide a valid product and tallied status.' });
  }
  try {
    const db = req.app.locals.db;
    const known = (await db.all(
      `SELECT DISTINCT CASE WHEN UPPER(sales_category) LIKE '%06 ATTA%' THEN 'AT' ELSE 'BC' END AS category,
              TRIM(item_code) AS itemCode, TRIM(item_name) AS itemName
       FROM profitability_sales WHERE company_id = ?`,
      [req.user.companyId]
    )).concat(AT_EXTRA_PRODUCTS).some(row => atProductKey(row) === atProductKey({ category, itemCode, itemName }));
    if (!known) return res.status(400).json({ error: 'This product is not in the uploaded sales data.' });
    const product = canonicalAtProduct({ category, itemCode, itemName });
    if (req.user.role !== 'admin') {
      const locked = await getLockedAtProducts(db, req.user.companyId, selectedDate);
      if (locked.has(atProductKey({ category, itemCode, itemName }))) {
        return res.status(403).json({ error: 'This item is assigned and tallied. Only an administrator can change it.' });
      }
    }
    await db.run(
      `INSERT INTO at_stock_daily (company_id, stock_date, sales_category, item_code, item_name, tallied)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, stock_date, sales_category, item_code, item_name)
       DO UPDATE SET tallied = excluded.tallied`,
      [req.user.companyId, selectedDate, product.category, product.itemCode, product.itemName, req.body.tallied ? 1 : 0]
    );
    await clearAtVariantRows(db, req.user.companyId, selectedDate, product, false);
    res.json({ tallied: req.body.tallied });
  } catch (error) {
    console.error('AT tallied update failed:', error);
    res.status(500).json({ error: 'Unable to update the tallied status.' });
  }
});

app.patch('/api/profitability/at-assignment/:date/assigned', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required for AT assignment.' });
  }
  const selectedDate = normalizeDeliveryDate(req.params.date);
  const category = String(req.body?.category || '').trim().toUpperCase();
  const itemCode = String(req.body?.itemCode || '').trim();
  const itemName = String(req.body?.itemName || '').trim();
  const agentKey = req.body?.agentId === null || req.body?.agentId === undefined ? 0 : Number(req.body.agentId);
  if (!selectedDate || !['AT', 'BC'].includes(category) || !itemName || itemName.length > 300 || itemCode.length > 100 ||
      !Number.isInteger(agentKey) || agentKey < 0 || typeof req.body?.assigned !== 'boolean') {
    return res.status(400).json({ error: 'Provide a valid assignment and status.' });
  }
  try {
    const db = req.app.locals.db;
    const rows = await loadAtAssignmentRows(db, req.user.companyId, selectedDate);
    const exists = rows.some(row => (row.agentId || 0) === agentKey && atProductKey(row) === atProductKey({ category, itemCode, itemName }));
    if (!exists) return res.status(400).json({ error: 'This assignment is not in the sales data for this date.' });
    if (req.user.role !== 'admin') {
      const locked = await getLockedAtProducts(db, req.user.companyId, selectedDate);
      if (locked.has(atProductKey({ category, itemCode, itemName }))) {
        return res.status(403).json({ error: 'This item is assigned and tallied. Only an administrator can change it.' });
      }
    }
    await db.run(
      `INSERT INTO at_assignment_status (company_id, assign_date, agent_key, sales_category, item_code, item_name, assigned)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, assign_date, agent_key, sales_category, item_code, item_name)
       DO UPDATE SET assigned = excluded.assigned`,
      [req.user.companyId, selectedDate, agentKey, category, itemCode, itemName, req.body.assigned ? 1 : 0]
    );
    res.json({ assigned: req.body.assigned });
  } catch (error) {
    console.error('AT assignment update failed:', error);
    res.status(500).json({ error: 'Unable to update the assignment status.' });
  }
});

app.get('/api/profitability/at-assignment', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required for AT assignment.' });
  }
  const selectedDate = normalizeDeliveryDate(req.query.date);
  if (!selectedDate) return res.status(400).json({ error: 'Choose a valid assignment date.' });
  try {
    const rows = await loadAtAssignmentRows(req.app.locals.db, req.user.companyId, selectedDate);
    const lockedProducts = await getLockedAtProducts(req.app.locals.db, req.user.companyId, selectedDate);
    const agents = new Map();
    for (const row of rows) {
      const key = row.agentId ?? 'none';
      if (!agents.has(key)) agents.set(key, { agentId: row.agentId, agentName: row.agentName, items: [] });
      const packWeightKg = row.category === 'AT' ? getAtPackWeightKg(row.itemName) : null;
      agents.get(key).items.push({
        category: row.category,
        itemCode: row.itemCode,
        itemName: row.itemName,
        displayName: row.category === 'AT' ? getAtDisplayName(row.itemName, packWeightKg) : row.itemName,
        packWeightKg,
        quantity: Number(row.quantity),
        billCount: row.billCount,
        assigned: Boolean(row.assigned),
        locked: lockedProducts.has(atProductKey(row))
      });
    }
    const result = [...agents.values()]
      .map(agent => ({ ...agent, items: agent.items.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName)) }))
      .sort((a, b) => (a.agentId === null) - (b.agentId === null) || a.agentName.localeCompare(b.agentName));
    if (req.query.format === 'xlsx') {
      return sendXlsx(res, createWorkbook([{
        name: 'AT Assignment',
        rows: [
          ['Delivery agent', 'Category', 'Product', 'Quantity', 'Bills'],
          ...result.flatMap(agent => agent.items.map(item => [
            agent.agentName, item.category, item.displayName,
            formatAtQuantity(item, item.quantity, false), item.billCount
          ]))
        ],
        autoFilterRow: 1
      }]), `AT-Assignment-${selectedDate}.xlsx`);
    }
    res.json({ date: selectedDate, agents: result });
  } catch (error) {
    console.error('AT assignment report failed:', error);
    res.status(500).json({ error: 'Unable to load the AT assignment for this date.' });
  }
});

app.get('/api/profitability/damages', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator or manager access is required for damages.' });
  }
  const fromDate = normalizeDeliveryDate(req.query.fromDate);
  const toDate = normalizeDeliveryDate(req.query.toDate);
  if (!fromDate || !toDate || fromDate > toDate) {
    return res.status(400).json({ error: 'Choose a valid from and to date.' });
  }
  try {
    const rows = await req.app.locals.db.all(
      `SELECT stock_date AS date, UPPER(TRIM(sales_category)) AS category, TRIM(item_name) AS itemName, damaged_qty AS damagedQty
       FROM at_stock_daily
       WHERE company_id = ? AND stock_date BETWEEN ? AND ? AND damaged_qty > 0
       ORDER BY stock_date DESC, category, item_name`,
      [req.user.companyId, fromDate, toDate]
    );
    const entries = rows.map(row => {
      const packWeightKg = row.category === 'AT' ? getAtPackWeightKg(row.itemName) : null;
      const item = { category: row.category, packWeightKg };
      return {
        date: row.date,
        category: row.category,
        itemName: row.itemName,
        displayName: row.category === 'AT' ? getAtDisplayName(row.itemName, packWeightKg) : row.itemName,
        quantity: Number(row.damagedQty),
        display: formatAtQuantity(item, Number(row.damagedQty))
      };
    });
    const warehouse = await loadDamageWarehouse(req.app.locals.db, req.user.companyId, toDate);
    if (req.query.format === 'xlsx') {
      return sendXlsx(res, createWorkbook([{
        name: 'Damages',
        rows: [
          ['Date', 'Category', 'Product', 'Damaged quantity'],
          ...entries.map(entry => [entry.date, entry.category, entry.displayName, entry.display])
        ],
        autoFilterRow: 1
      }, {
        name: 'Damaged warehouse',
        rows: [
          ['Category', 'Product', 'Total damaged', 'Removed', 'Balance', 'Removal date', 'Removed quantity', 'Remarks', 'Removed by'],
          ...warehouse.flatMap(item => item.removals.length
            ? item.removals.map(removal => [item.category, item.displayName, item.damagedDisplay, item.removedDisplay, item.balanceDisplay, removal.date, removal.display, removal.remarks, removal.createdBy])
            : [[item.category, item.displayName, item.damagedDisplay, item.removedDisplay, item.balanceDisplay, '', '', '', '']])
        ],
        autoFilterRow: 1
      }]), `Damages-${fromDate}-to-${toDate}.xlsx`);
    }
    res.json({ fromDate, toDate, entries, warehouse });
  } catch (error) {
    console.error('Damages report failed:', error);
    res.status(500).json({ error: 'Unable to load damaged stock.' });
  }
});

app.get('/api/profitability/report', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required to view profitability reports.' });
  }

  const selectedDate = normalizeDeliveryDate(req.query.date);
  if (!selectedDate) {
    return res.status(400).json({ error: 'Choose a valid profitability report date.' });
  }

  try {
    const db = req.app.locals.db;
    const sales = await db.all(
      `SELECT * FROM profitability_sales
       WHERE company_id = ? AND sales_date = ?
       ORDER BY bill_no, item_name`,
      [req.user.companyId, selectedDate]
    );
    const excludedCodes = profitabilityExcludedItemsByDate.get(selectedDate) || new Set();
    const excludedSales = sales.filter(sale =>
      excludedCodes.has(String(sale.item_code || '').trim().toLocaleLowerCase())
    );
    const excludedSaleIds = new Set(excludedSales.map(sale => sale.id));
    const reportSales = sales.filter(sale => !excludedSaleIds.has(sale.id));
    const productCosts = await db.all(
      `SELECT item_code, item_name, purchase_unit_cost, input_gst_rate
       FROM profitability_product_costs
       WHERE company_id = ?
       ORDER BY CASE WHEN item_code = '' THEN 1 ELSE 0 END, item_code, item_name`,
      [req.user.companyId]
    );

    const costsByCode = new Map();
    const costsByName = new Map();
    let inputGst = 0;
    for (const productCost of productCosts) {
      const cost = Number(productCost.purchase_unit_cost);
      const gstRate = Number(productCost.input_gst_rate);
      if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) continue;
      const value = { purchaseUnitCost: cost, inputGstRate: gstRate };
      const code = String(productCost.item_code || '').trim().toLocaleLowerCase();
      const name = String(productCost.item_name || '').trim().toLocaleLowerCase();
      if (code) costsByCode.set(code, value);
      else if (name) costsByName.set(name, value);
    }

    const groupedBills = new Map();
    const groupedItems = new Map();
    const missingItems = new Map();
    let grossAmount = 0;
    let rfaAmount = 0;
    let outputTax = 0;
    let cogs = 0;
    for (const sale of reportSales) {
      const key = `${sale.sales_date}\u0000${sale.bill_no.toLocaleLowerCase()}`;
      let bill = groupedBills.get(key);
      if (!bill) {
        bill = {
          salesDate: sale.sales_date,
          billNo: sale.bill_no,
          outletName: sale.outlet_name,
          grossAmount: 0,
          rfaAmount: 0,
          outputTax: 0,
          inputGst: 0,
          cogs: 0,
          missingCostItems: []
        };
        groupedBills.set(key, bill);
      }

      const lineGross = Number(sale.gross_amount);
      const lineRfa = Number(sale.rfa_amount);
      const lineTax = Number(sale.output_tax);
      const quantity = Number(sale.quantity) - Number(sale.sales_return_qty || 0);
      const codeKey = String(sale.item_code || '').trim().toLocaleLowerCase();
      const nameKey = String(sale.item_name || '').trim().toLocaleLowerCase();
      const productCost = (codeKey && costsByCode.has(codeKey) ? costsByCode.get(codeKey) : undefined) ??
        costsByName.get(nameKey);
      const itemKey = [
        sale.bill_no.toLocaleLowerCase(),
        codeKey || nameKey,
        nameKey
      ].join('\u0000');
      let item = groupedItems.get(itemKey);
      if (!item) {
        item = {
          billNo: sale.bill_no,
          itemCode: sale.item_code || '',
          itemName: sale.item_name || sale.item_code,
          grossAmount: 0,
          rfaAmount: 0,
          outputTax: 0,
          quantity: 0,
          cogs: 0,
          inputGst: 0,
          missingCost: false
        };
        groupedItems.set(itemKey, item);
      }
      grossAmount += lineGross;
      rfaAmount += lineRfa;
      outputTax += lineTax;
      bill.grossAmount += lineGross;
      bill.rfaAmount += lineRfa;
      bill.outputTax += lineTax;
      item.grossAmount += lineGross;
      item.rfaAmount += lineRfa;
      item.outputTax += lineTax;
      item.quantity += quantity;
      if (productCost === undefined) {
        const itemLabel = sale.item_name || sale.item_code;
        bill.missingCostItems.push(itemLabel);
        missingItems.set(itemLabel, true);
        item.missingCost = true;
      } else {
        const lineNetCost = quantity * productCost.purchaseUnitCost;
        const lineInputGst = lineNetCost * productCost.inputGstRate / 100;
        bill.cogs += lineNetCost;
        cogs += lineNetCost;
        bill.inputGst += lineInputGst;
        inputGst += lineInputGst;
        item.cogs += lineNetCost;
        item.inputGst += lineInputGst;
      }
    }

    const missingCostItems = [...missingItems.keys()].sort((left, right) => left.localeCompare(right));
    const missingQuantityItems = [];
    const items = [...groupedItems.values()].map(item => {
      const missingQuantity = item.quantity === 0 &&
        (item.grossAmount !== 0 || item.rfaAmount !== 0 || item.outputTax !== 0);
      if (missingQuantity) {
        missingQuantityItems.push(`${item.itemName} [${item.itemCode}]`);
      }
      const complete = !item.missingCost && !missingQuantity;
      const netProfitWithoutRfa = complete ? item.grossAmount - item.cogs : null;
      const netProfitWithRfa = complete ? item.grossAmount + item.rfaAmount - item.cogs : null;
      const purchaseCostWithGst = item.cogs + item.inputGst;
      return {
        billNo: item.billNo,
        itemCode: item.itemCode,
        itemName: item.itemName,
        purchaseCost: complete ? item.cogs : null,
        netSellingCost: item.grossAmount,
        gstPayable: complete ? roundCurrencyAmount(item.outputTax - item.inputGst) : null,
        netMarginBeforeRfa: complete && purchaseCostWithGst !== 0
          ? netProfitWithoutRfa / purchaseCostWithGst * 100
          : null,
        rfaAmount: item.rfaAmount,
        netMarginAfterRfa: complete && purchaseCostWithGst !== 0
          ? netProfitWithRfa / purchaseCostWithGst * 100
          : null,
        netProfitWithoutRfa,
        netProfitWithRfa,
        missingCost: item.missingCost,
        missingQuantity
      };
    });
    const profitabilityIncomplete = missingCostItems.length > 0 || missingQuantityItems.length > 0;
    const bills = [...groupedBills.values()].map(bill => ({
      ...bill,
      missingCostItems: [...new Set(bill.missingCostItems)],
      cogs: bill.missingCostItems.length ? null : bill.cogs,
      inputGst: bill.missingCostItems.length ? null : bill.inputGst,
      netProfitWithoutRfa: bill.missingCostItems.length ? null : bill.grossAmount - bill.cogs,
      netProfitWithRfa: bill.missingCostItems.length ? null : bill.grossAmount + bill.rfaAmount - bill.cogs
    }));
    const report = {
      salesDate: selectedDate,
      excludedItems: [...new Set(excludedSales.map(sale => sale.item_name || sale.item_code))],
      summary: {
        billCount: bills.length,
        grossAmount,
        rfaAmount,
        cogs: profitabilityIncomplete ? null : cogs,
        netProfitWithoutRfa: profitabilityIncomplete ? null : grossAmount - cogs,
        netProfitWithRfa: profitabilityIncomplete ? null : grossAmount + rfaAmount - cogs,
        outputTax,
        inputGst: profitabilityIncomplete ? null : inputGst,
        gstPayable: profitabilityIncomplete ? null : roundCurrencyAmount(outputTax - inputGst),
        missingCostItems,
        missingQuantityItems
      },
      bills,
      items
    };
    if (req.query.format === 'xlsx') {
      const summaryRows = [
        ['SKU Profitability Report'],
        ['Sales Date', selectedDate],
        [],
        ['Metric', 'Value'],
        ['Bill Count', report.summary.billCount],
        ['Gross Sales · Pre-tax', report.summary.grossAmount],
        ['Net Purchase Cost · Pre-tax', report.summary.cogs ?? 'Incomplete'],
        ['Net Profit · Before RFA', report.summary.netProfitWithoutRfa ?? 'Incomplete'],
        ['Net Profit · After RFA', report.summary.netProfitWithRfa ?? 'Incomplete'],
        ['RFA Amount', report.summary.rfaAmount],
        ['Output GST', report.summary.outputTax],
        ['Estimated Input GST', report.summary.inputGst ?? 'Incomplete'],
        ['GST Payable', report.summary.gstPayable ?? 'Incomplete'],
        ['Excluded Items', report.excludedItems.join(', ')],
        ['Missing Purchase Costs', report.summary.missingCostItems.join(', ')],
        ['Missing Quantities', report.summary.missingQuantityItems.join(', ')]
      ];
      const itemRows = [[
        'Bill Number',
        'SKU Code',
        'SKU Name',
        'Net Purchase Cost · Pre-tax',
        'Net Selling Cost · Pre-tax',
        'GST Payable',
        'Net Margin Before RFA (%)',
        'RFA Amount',
        'Net Margin After RFA (%)',
        'Status'
      ], ...items.map(item => [
        item.billNo,
        item.itemCode,
        item.itemName,
        item.purchaseCost,
        item.netSellingCost,
        item.gstPayable,
        item.netMarginBeforeRfa,
        item.rfaAmount,
        item.netMarginAfterRfa,
        item.missingQuantity ? 'Quantity unavailable' : item.missingCost ? 'Purchase cost missing' : ''
      ])];
      const workbook = createWorkbook([
        { name: 'Report Summary', rows: summaryRows },
        { name: 'SKU Profitability', rows: itemRows, autoFilterRow: 1 }
      ]);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="SKU-Profitability-${selectedDate}.xlsx"`,
        'Content-Length': workbook.length,
        'Cache-Control': 'no-store'
      });
      return res.send(Buffer.from(workbook));
    }
    res.json(report);
  } catch (error) {
    console.error('Could not create profitability report:', error);
    res.status(500).json({ error: 'Could not create the profitability report. Please try again.' });
  }
});

app.get('/api/profitability/rfa-report', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required to view RFA reports.' });
  }

  const fromDate = normalizeDeliveryDate(req.query.fromDate);
  const toDate = normalizeDeliveryDate(req.query.toDate);
  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'Choose valid from and to dates for the RFA report.' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'The from date must be on or before the to date.' });
  }

  try {
    const rows = await req.app.locals.db.all(
      `SELECT COALESCE(NULLIF(TRIM(sales_category), ''), 'Uncategorized') AS category,
              SUM(rfa_amount) AS netRfa
       FROM profitability_sales
       WHERE company_id = ? AND sales_date BETWEEN ? AND ?
       GROUP BY category COLLATE NOCASE
       ORDER BY category COLLATE NOCASE`,
      [req.user.companyId, fromDate, toDate]
    );
    const report = {
      fromDate,
      toDate,
      totalNetRfa: rows.reduce((total, row) => total + Number(row.netRfa), 0),
      rows
    };
    if (req.query.format === 'xlsx') {
      const workbook = createWorkbook([{
        name: 'Net RFA by Category',
        rows: [
          ['Net RFA Due from Company'],
          ['From Date', fromDate],
          ['To Date', toDate],
          ['Total Net RFA', report.totalNetRfa],
          [],
          ['Category', 'Net RFA Due'],
          ...rows.map(row => [row.category, Number(row.netRfa)])
        ],
        autoFilterRow: 6
      }]);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Net-RFA-${fromDate}-to-${toDate}.xlsx"`,
        'Content-Length': workbook.length,
        'Cache-Control': 'no-store'
      });
      return res.send(Buffer.from(workbook));
    }
    res.json(report);
  } catch (error) {
    console.error('Could not create RFA report:', error);
    res.status(500).json({ error: 'Could not create the RFA report. Please try again.' });
  }
});

const K4_STANDARD_RATE = 0.015;
const K4_SX_RATE = 0.02;

function k4WorkingDaysInMonth(year, monthIndex) {
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  let working = 0;
  for (let day = 1; day <= days; day += 1) {
    if (new Date(Date.UTC(year, monthIndex, day)).getUTCDay() !== 0) working += 1;
  }
  return working;
}

async function computeK4Costs(db, companyId, fromDate, toDate) {
  const settings = await db.all(
    'SELECT * FROM k4_staff_settings WHERE company_id = ? ORDER BY effective_from',
    [companyId]
  );
  const expenses = await db.all(
    'SELECT * FROM k4_daily_expenses WHERE company_id = ? AND expense_date BETWEEN ? AND ?',
    [companyId, fromDate, toDate]
  );
  let deliveryBoyCost = 0;
  let packerCost = 0;
  let workingDays = 0;
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  for (let day = start; day <= end; day = new Date(day.getTime() + 86400000)) {
    if (day.getUTCDay() === 0) continue;
    workingDays += 1;
    const dateKey = day.toISOString().slice(0, 10);
    let setting = null;
    for (const candidate of settings) {
      if (candidate.effective_from <= dateKey) setting = candidate;
      else break;
    }
    if (!setting) continue;
    const monthDays = k4WorkingDaysInMonth(day.getUTCFullYear(), day.getUTCMonth());
    deliveryBoyCost += Number(setting.delivery_boy_salary) / monthDays;
    packerCost += Number(setting.packer_salary) / monthDays;
  }
  const additionalExpense = expenses.reduce((sum, row) => sum + Number(row.additional_expense), 0);
  const vehiclesHired = expenses.reduce((sum, row) => sum + Number(row.vehicles_hired), 0);
  const vehicleAmount = expenses.reduce((sum, row) => sum + Number(row.vehicle_amount), 0);
  return {
    workingDays,
    deliveryBoyCost,
    packerCost,
    additionalExpense,
    vehiclesHired,
    vehicleAmount,
    totalSpent: deliveryBoyCost + packerCost + additionalExpense + vehicleAmount
  };
}

function parseK4Amount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100000000 ? number : null;
}

function parseK4Count(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 10000 ? number : null;
}

app.get('/api/profitability/k4-settings', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  const today = normalizeDeliveryDate(req.query.date) || new Date().toISOString().slice(0, 10);
  const history = await req.app.locals.db.all(
    `SELECT effective_from AS effectiveFrom, delivery_boy_count AS deliveryBoyCount, delivery_boy_salary AS deliveryBoySalary,
            packer_count AS packerCount, packer_salary AS packerSalary
     FROM k4_staff_settings WHERE company_id = ? ORDER BY effective_from DESC`,
    [req.user.companyId]
  );
  const current = history.find(row => row.effectiveFrom <= today) || history[history.length - 1] || null;
  res.json({ current, history });
});

app.put('/api/profitability/k4-settings', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  const effectiveFrom = normalizeDeliveryDate(req.body?.effectiveFrom);
  const deliveryBoyCount = parseK4Count(req.body?.deliveryBoyCount);
  const deliveryBoySalary = parseK4Amount(req.body?.deliveryBoySalary);
  const packerCount = parseK4Count(req.body?.packerCount);
  const packerSalary = parseK4Amount(req.body?.packerSalary);
  if (!effectiveFrom || deliveryBoyCount === null || deliveryBoySalary === null || packerCount === null || packerSalary === null) {
    return res.status(400).json({ error: 'Enter a valid date, staff counts and total salaries.' });
  }
  await req.app.locals.db.run(
    `INSERT INTO k4_staff_settings (company_id, effective_from, delivery_boy_count, delivery_boy_salary, packer_count, packer_salary)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, effective_from) DO UPDATE SET
       delivery_boy_count = excluded.delivery_boy_count, delivery_boy_salary = excluded.delivery_boy_salary,
       packer_count = excluded.packer_count, packer_salary = excluded.packer_salary`,
    [req.user.companyId, effectiveFrom, deliveryBoyCount, deliveryBoySalary, packerCount, packerSalary]
  );
  res.json({ message: `Staff costs saved from ${effectiveFrom}.` });
});

app.get('/api/profitability/k4-expenses/:date', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  const date = normalizeDeliveryDate(req.params.date);
  if (!date) return res.status(400).json({ error: 'Choose a valid date.' });
  const row = await req.app.locals.db.get(
    'SELECT additional_expense, vehicles_hired, vehicle_amount FROM k4_daily_expenses WHERE company_id = ? AND expense_date = ?',
    [req.user.companyId, date]
  );
  res.json({
    additionalExpense: Number(row?.additional_expense || 0),
    vehiclesHired: Number(row?.vehicles_hired || 0),
    vehicleAmount: Number(row?.vehicle_amount || 0)
  });
});

app.put('/api/profitability/k4-expenses/:date', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  const date = normalizeDeliveryDate(req.params.date);
  const additionalExpense = parseK4Amount(req.body?.additionalExpense);
  const vehiclesHired = parseK4Count(req.body?.vehiclesHired);
  const vehicleAmount = parseK4Amount(req.body?.vehicleAmount);
  if (!date || additionalExpense === null || vehiclesHired === null || vehicleAmount === null) {
    return res.status(400).json({ error: 'Enter a valid date, expense, vehicle count and vehicle amount.' });
  }
  await req.app.locals.db.run(
    `INSERT INTO k4_daily_expenses (company_id, expense_date, additional_expense, vehicles_hired, vehicle_amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(company_id, expense_date) DO UPDATE SET
       additional_expense = excluded.additional_expense, vehicles_hired = excluded.vehicles_hired, vehicle_amount = excluded.vehicle_amount`,
    [req.user.companyId, date, additionalExpense, vehiclesHired, vehicleAmount]
  );
  res.json({ message: `Expenses saved for ${date}.` });
});

app.get('/api/profitability/k4-report', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required to view the K4 report.' });
  }
  const fromDate = normalizeDeliveryDate(req.query.fromDate);
  const toDate = normalizeDeliveryDate(req.query.toDate);
  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'Choose valid from and to dates for the K4 report.' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'The from date must be on or before the to date.' });
  }

  if ((new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / 86400000 > 3660) {
    return res.status(400).json({ error: 'Choose a date range of 10 years or less.' });
  }

  try {
    const sales = await req.app.locals.db.all(
      `SELECT COALESCE(NULLIF(TRIM(sales_category), ''), 'Uncategorized') AS category,
              SUM(COALESCE(total_amount, gross_amount)) AS netSales,
              SUM(CASE WHEN total_amount IS NULL THEN 1 ELSE 0 END) AS rowsWithoutTotal
       FROM profitability_sales
       WHERE company_id = ? AND sales_date BETWEEN ? AND ?
       GROUP BY category COLLATE NOCASE
       ORDER BY category COLLATE NOCASE`,
      [req.user.companyId, fromDate, toDate]
    );
    const rows = sales.map(row => {
      const isSx = /(^|[^A-Z])SX([^A-Z]|$)|BINGO/i.test(row.category);
      const rate = isSx ? K4_SX_RATE : K4_STANDARD_RATE;
      const netSales = Number(row.netSales) || 0;
      return { category: row.category, netSales, ratePercent: rate * 100, receivable: netSales * rate };
    });
    const report = {
      fromDate,
      toDate,
      totalNetSales: rows.reduce((total, row) => total + row.netSales, 0),
      totalReceivable: rows.reduce((total, row) => total + row.receivable, 0),
      rowsWithoutTotal: sales.reduce((total, row) => total + Number(row.rowsWithoutTotal || 0), 0),
      rows
    };
    report.costs = await computeK4Costs(req.app.locals.db, req.user.companyId, fromDate, toDate);
    report.net = report.totalReceivable - report.costs.totalSpent;
    if (req.query.format === 'xlsx') {
      const workbook = createWorkbook([{
        name: 'K4 Delivery Receivable',
        rows: [
          ['K4 Delivery Amount Receivable from Company'],
          ['From Date', fromDate],
          ['To Date', toDate],
          ['Total Net Sales', report.totalNetSales],
          ['Total Delivery Amount Receivable', report.totalReceivable],
          ['Delivery Boy Salary', report.costs.deliveryBoyCost],
          ['Packer Salary', report.costs.packerCost],
          ['Additional Expense', report.costs.additionalExpense],
          [`Vehicle Amount (${report.costs.vehiclesHired} vehicles)`, report.costs.vehicleAmount],
          ['Total Spent', report.costs.totalSpent],
          ['Net (Claimed - Spent)', report.net],
          [],
          ['Category', 'Net Sales', 'Rate %', 'Delivery Amount Receivable'],
          ...rows.map(row => [row.category, row.netSales, row.ratePercent, row.receivable])
        ],
        autoFilterRow: 13
      }]);
      return sendXlsx(res, workbook, `K4-Delivery-Receivable-${fromDate}-to-${toDate}.xlsx`);
    }
    res.json(report);
  } catch (error) {
    console.error('Could not create K4 report:', error);
    res.status(500).json({ error: 'Could not create the K4 report. Please try again.' });
  }
});

app.post('/api/bills/upload', upload.single('file'), async (req, res) => {
  if (req.user.role === 'delivery_partner') {
    return res.status(403).json({ error: 'Only administrators and managers can import deliveries.' });
  }
  if (await rejectIfUploadLocked(req, res)) return;
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

    const salesmanByBillNumber = new Map();
    for (const row of rows) {
      if (!row.salesman) continue;
      const existingSalesman = salesmanByBillNumber.get(row.billno);
      if (existingSalesman && existingSalesman.toLowerCase() !== row.salesman.toLowerCase()) {
        return res.status(400).json({
          error: `Bill ${row.billno} has more than one salesman name. Check row ${row.rowNumber} and keep one salesman for each bill.`
        });
      }
      salesmanByBillNumber.set(row.billno, existingSalesman || row.salesman);
    }
    for (const row of rows) {
      row.salesman = salesmanByBillNumber.get(row.billno) || '';
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
    let salesmanMappingsUpdated = 0;
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
        if (row.salesman) {
          await req.app.locals.db.run(
            `UPDATE bills SET salesman = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND company_id = ? AND delivery_date = ?`,
            [row.salesman, bill.id, req.user.companyId, selectedDate]
          );
          salesmanMappingsUpdated += 1;
        }
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
        `INSERT INTO bills (company_id, bill_no, outlet_name, address, salesman, delivery_date)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, bill_no) DO UPDATE SET
           outlet_name = excluded.outlet_name,
           address = excluded.address,
           salesman = CASE WHEN excluded.salesman <> '' THEN excluded.salesman ELSE bills.salesman END,
           delivery_date = excluded.delivery_date,
           updated_at = CURRENT_TIMESTAMP
         WHERE bills.delivery_date = ''`,
        [req.user.companyId, row.billno, row.outletname, row.address, row.salesman, row.deliveryDate]
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
      salesmanMappingsUpdated,
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
      `SELECT bills.*, users.full_name AS assigned_partner_name
       FROM bills
       LEFT JOIN users ON users.id = bills.assigned_to
       WHERE bills.company_id = ? AND (
         bills.delivery_date = ?
         OR (bills.delivery_date = '' AND substr(bills.created_at, 1, 10) = ?)
         OR (bills.status = 'Not supplied' AND bills.not_supplied_from_date <= ?)
       )
       ORDER BY bills.bill_no`,
      [req.user.companyId, selectedDate, selectedDate, selectedDate]
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
    let cancelledBills = 0;
    const summaryRows = [
      ['TAF Disti Desk - Daily Delivery Report'],
      ['Sales Date', selectedDate],
      [],
      ['Daily Metric', 'Value']
    ];
    const itemRows = [[
      'Sales Date',
      'Bill Number',
      'Delivery Partner',
      'Outlet',
      'Delivery Area / Address',
      'Item',
      'Quantity Ordered',
      'Quantity Delivered',
      'Quantity Returned',
      'Return Reason',
      'Quantity Pending',
      'Bill Status'
    ]];
    const billSummaries = [];

    for (const bill of bills) {
      const items = await db.all(
        'SELECT * FROM bill_items WHERE bill_id = ? ORDER BY item_name',
        [bill.id]
      );
      const isCancelled = bill.status === 'Cancelled';
      // A cancelled bill's whole billed quantity comes back to us as a return.
      const quantities = items.reduce((totals, item) => {
        totals.ordered += Number(item.qty_ordered);
        totals.delivered += isCancelled ? 0 : Number(item.qty_delivered);
        totals.returned += isCancelled ? Number(item.qty_ordered) : Number(item.qty_returned);
        return totals;
      }, { ordered: 0, delivered: 0, returned: 0 });
      const remaining = isCancelled ? 0 : Math.max(0, quantities.ordered - quantities.delivered - quantities.returned);
      const status = isCancelled
        ? 'Cancelled'
        : bill.status === 'Not supplied' && remaining > 0
          ? 'Not supplied'
          : getBillStatus(quantities);
      const returnReasons = isCancelled ? 'Bill cancelled' : [...new Set(items
        .filter(item => Number(item.qty_returned) > 0 && item.return_type)
        .map(item => item.return_type))].join(', ');

      if (isCancelled) cancelledBills += 1;
      orderedUnits += quantities.ordered;
      deliveredUnits += quantities.delivered;
      returnedUnits += quantities.returned;
      pendingUnits += remaining;
      if (remaining > 0) billsWithPendingItems += 1;
      if (status === 'Completed' || status === 'Returned') completedBills += 1;

      billSummaries.push([
        bill.bill_no,
        bill.assigned_partner_name || '',
        bill.outlet_name,
        bill.address,
        status,
        returnReasons,
        items.length,
        quantities.ordered,
        quantities.delivered,
        quantities.returned,
        remaining
      ]);

      for (const item of items) {
        const ordered = Number(item.qty_ordered);
        const delivered = isCancelled ? 0 : Number(item.qty_delivered);
        const returned = isCancelled ? ordered : Number(item.qty_returned);
        itemRows.push([
          selectedDate,
          bill.bill_no,
          bill.assigned_partner_name || '',
          bill.outlet_name,
          bill.address,
          item.item_name,
          ordered,
          delivered,
          returned,
          isCancelled ? 'Bill cancelled' : returned > 0 ? item.return_type : '',
          status === 'Cancelled' ? 0 : Math.max(0, ordered - delivered - returned),
          status
        ]);
      }
    }

    summaryRows.push(
      ['Total Bills', bills.length],
      ['Bills With Pending Items', billsWithPendingItems],
      ['Completed Or Returned Bills', completedBills],
      ['Cancelled Bills', cancelledBills],
      ['Total Units Ordered', orderedUnits],
      ['Total Units Delivered', deliveredUnits],
      ['Total Units Returned', returnedUnits],
      ['Total Units Pending', pendingUnits],
      [],
      [],
      ['Bill Number', 'Delivery Partner', 'Outlet', 'Delivery Area / Address', 'Status', 'Return Reason', 'Item Lines', 'Units Ordered', 'Units Delivered', 'Units Returned', 'Units Pending'],
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

app.post('/api/bills/cancel', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an administrator or manager can cancel or restore an order.' });
  }
  const billId = Number(req.body?.billId);
  if (!Number.isSafeInteger(billId) || billId < 1 || typeof req.body?.cancelled !== 'boolean') {
    return res.status(400).json({ error: 'Choose a valid delivery.' });
  }

  const db = req.app.locals.db;
  try {
    const bill = await db.get('SELECT id, status FROM bills WHERE id = ? AND company_id = ?', [billId, req.user.companyId]);
    if (!bill) return res.status(404).json({ error: 'Delivery not found.' });

    if (req.body.cancelled) {
      await db.run(
        `UPDATE bills SET status = 'Cancelled', not_supplied_from_date = NULL,
           updated_at = CURRENT_TIMESTAMP, progress_updated_at = ?
         WHERE id = ? AND company_id = ?`,
        [new Date().toISOString(), billId, req.user.companyId]
      );
      return res.json({ message: 'Order marked as cancelled.', status: 'Cancelled' });
    }

    if (bill.status !== 'Cancelled') return res.json({ message: 'Order is not cancelled.', status: bill.status });
    const totals = await db.get(
      'SELECT SUM(qty_ordered) AS ordered, SUM(qty_delivered) AS delivered, SUM(qty_returned) AS returned FROM bill_items WHERE bill_id = ?',
      [billId]
    );
    const status = getBillStatus(totals);
    await db.run(
      'UPDATE bills SET status = ?, updated_at = CURRENT_TIMESTAMP, progress_updated_at = ? WHERE id = ? AND company_id = ?',
      [status, new Date().toISOString(), billId, req.user.companyId]
    );
    res.json({ message: 'Order restored.', status });
  } catch (error) {
    console.error('Could not update cancelled status:', error);
    res.status(500).json({ error: 'Could not update the order. Please try again.' });
  }
});

app.post('/api/bills/not-supplied', async (req, res) => {
  if (req.user.role === 'manager') {
    return res.status(403).json({ error: 'Only the assigned delivery partner or an administrator can mark a bill not supplied.' });
  }

  const billId = Number(req.body.billId);
  const carryoverDate = normalizeDeliveryDate(req.body.deliveryDate);
  if (!Number.isSafeInteger(billId) || billId < 1 || !carryoverDate) {
    return res.status(400).json({ error: 'Choose a valid delivery and date.' });
  }

  const db = req.app.locals.db;
  let transactionOpen = false;
  try {
    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const bill = req.user.role === 'delivery_partner'
      ? await db.get(
        'SELECT id, delivery_date, created_at, status FROM bills WHERE id = ? AND company_id = ? AND assigned_to = ?',
        [billId, req.user.companyId, req.user.id]
      )
      : await db.get(
        'SELECT id, delivery_date, created_at, status FROM bills WHERE id = ? AND company_id = ?',
        [billId, req.user.companyId]
      );
    if (!bill) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(404).json({ error: 'Delivery not found.' });
    }
    if (bill.status === 'Cancelled') {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'This order is cancelled. Restore it before changing its delivery status.' });
    }

    const billDate = bill.delivery_date || String(bill.created_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || carryoverDate < billDate) {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'The not-supplied date cannot be earlier than the bill date.' });
    }

    const totals = await db.get(
      'SELECT SUM(qty_ordered) AS ordered, SUM(qty_delivered) AS delivered, SUM(qty_returned) AS returned FROM bill_items WHERE bill_id = ?',
      [billId]
    );
    const status = getBillStatus(totals);
    const remaining = Math.max(
      0,
      (Number(totals.ordered) || 0) -
      (Number(totals.delivered) || 0) -
      (Number(totals.returned) || 0)
    );
    if (remaining === 0 || status === 'Completed' || status === 'Returned') {
      await db.exec('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'This bill has no outstanding quantity to carry forward.' });
    }

    const notSuppliedFromDate = await db.get(
      'SELECT not_supplied_from_date FROM bills WHERE id = ?',
      [billId]
    );
    const effectiveDate = notSuppliedFromDate.not_supplied_from_date || carryoverDate;
    await db.run(
      `UPDATE bills SET status = 'Not supplied', not_supplied_from_date = ?,
         updated_at = CURRENT_TIMESTAMP, progress_updated_at = ?
       WHERE id = ? AND company_id = ?`,
      [effectiveDate, new Date().toISOString(), billId, req.user.companyId]
    );
    await db.exec('COMMIT');
    transactionOpen = false;
    res.json({ message: 'Bill marked not supplied and carried forward until its outstanding quantity is resolved.', status: 'Not supplied', notSuppliedFromDate: effectiveDate });
  } catch (error) {
    if (transactionOpen) await db.exec('ROLLBACK');
    console.error('Could not mark delivery not supplied:', error);
    res.status(500).json({ error: 'Could not mark the delivery not supplied. Please try again.' });
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
        'SELECT id, status, not_supplied_from_date FROM bills WHERE id = ? AND company_id = ? AND assigned_to = ?',
        [Number(billId), req.user.companyId, req.user.id]
      )
      : await db.get(
        'SELECT id, status, not_supplied_from_date FROM bills WHERE id = ? AND company_id = ?',
        [Number(billId), req.user.companyId]
      );
    if (!bill) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Delivery not found.' });
    }
    if (bill.status === 'Cancelled') {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'This order is cancelled. A manager or administrator must restore it before progress can be updated.' });
    }

    for (const item of items) {
      const id = Number(item.id);
      const delivered = Number(item.qty_delivered);
      const returned = Number(item.qty_returned);
      const returnType = String(item.return_type || '');
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
        delivered + returned > currentItem.qty_ordered ||
        (returned > 0 && !['R', 'DA', 'DUE'].includes(returnType)) ||
        (returned === 0 && returnType !== '')
      ) {
        await db.exec('ROLLBACK');
        return res.status(400).json({ error: 'Enter valid whole-number quantities; returned stock must have a return type (R, DA, or DUE).' });
      }

      seenIds.add(id);
      await db.run(
        'UPDATE bill_items SET qty_delivered = ?, qty_returned = ?, return_type = ? WHERE id = ?',
        [delivered, returned, returnType, id]
      );
    }

    const totals = await db.get(
      'SELECT SUM(qty_ordered) AS ordered, SUM(qty_delivered) AS delivered, SUM(qty_returned) AS returned FROM bill_items WHERE bill_id = ?',
      [Number(billId)]
    );
    const status = getBillStatus(totals);
    const progressUpdatedAt = new Date().toISOString();
    const completed = status === 'Completed' || status === 'Returned';
    const finalStatus = !completed && bill.not_supplied_from_date ? 'Not supplied' : status;

    await db.run(
      `UPDATE bills SET status = ?, updated_at = CURRENT_TIMESTAMP,
         not_supplied_from_date = CASE WHEN ? THEN NULL ELSE not_supplied_from_date END,
         progress_started_at = COALESCE(progress_started_at, ?),
         progress_updated_at = ?,
         completed_at = CASE
           WHEN ? THEN COALESCE(completed_at, ?)
           ELSE NULL
         END
       WHERE id = ? AND company_id = ?`,
      [
        finalStatus,
        completed ? 1 : 0,
        progressUpdatedAt,
        progressUpdatedAt,
        completed ? 1 : 0,
        progressUpdatedAt,
        Number(billId),
        req.user.companyId
      ]
    );
    await db.exec('COMMIT');
    res.json({ message: 'Delivery progress saved.', status: finalStatus });
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error('Could not reconcile delivery:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const sizeError = req.path === '/api/rt-damage'
      ? 'Photos must be 8 MB or smaller.'
      : 'Files must be 10 MB or smaller.';
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? sizeError : error.message });
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
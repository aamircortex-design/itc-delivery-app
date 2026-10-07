# Deploy TAF Disti Desk to Render

## Before deploying

- Push the project code to a private GitHub repository. Do not commit `.env` files,
  `node_modules`, uploaded files, or `delivery.sqlite`.
- The Render Blueprint in `render.yaml` compiles `sqlite3` from source to match
  Render's system libraries, creates a Node web service, and mounts a
  persistent disk at `/var/data`. The app stores its SQLite database at
  `/var/data/delivery.sqlite`.
- SQLite data is lost when Render replaces an instance unless the service has
  that persistent disk attached. The app now refuses to start on Render when
  `DATABASE_PATH` is missing, the `/var/data` disk is not mounted, or the
  database path is outside that disk; it will not silently create a fresh
  database in the temporary application directory.
- The Blueprint uses a paid web-service plan because the SQLite database requires
  persistent storage. Review Render's current service and disk prices before you
  apply it.

## Create the service

1. In Render, choose **New → Blueprint** and connect the private GitHub repository.
2. Review the `taf-disti-desk` service, its persistent disk, and the estimated cost.
   If the service already exists, confirm in its **Disks** settings that the
   persistent disk is attached and mounted at `/var/data`, and in **Environment**
   that `DATABASE_PATH` is `/var/data/delivery.sqlite`. Do not delete or replace an
   existing disk when updating application code.
3. Apply the Blueprint and wait for the `/health` deployment check to pass.
4. Open the generated `https://...onrender.com` address. Complete first-time setup
   if the hosted database is empty, or sign in if you have migrated your accounts.
5. On Android, open the HTTPS address in Chrome and select **⋮ → Install app**.

The local SQLite database is intentionally excluded from Git and is not copied to
Render by deployment. A new Render disk starts with an empty database. Plan a separate
and verified database migration before switching live delivery work to the hosted
service; keep the local source database and a backup unchanged until the hosted copy
has been checked.

## Company workspaces

- Each company can create its own workspace from the sign-in page. The person who
  creates it enters the workspace name, their email address, and becomes its first
  administrator; that administrator adds the company's other users from **Manage users**.
- Users in a workspace share that company's delivery records. The server scopes
  delivery, assignment, export, and user-management operations to the signed-in user's
  workspace. Team accounts are assigned to the administrator's current workspace, rather
  than choosing a workspace themselves. User IDs and registered email addresses must be
  unique across the app.
- On an existing database, startup migration keeps the existing users and delivery
  records together in their current company workspace. Existing accounts need an email
  address added to their records before password recovery is available for them. Back
  up the persistent database before deploying schema changes.

## Password recovery email

Password recovery sends a single-use link that expires after 30 minutes; the app never
sends or reveals an existing password. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
and `SMTP_PASS` in the hosting environment; `EMAIL_FROM` is optional and defaults to
`SMTP_USER`. Set `APP_BASE_URL` to the
public HTTPS app URL so reset links point to the deployed service. SMTP port 465 uses
implicit TLS; other ports use the normal SMTP connection with Nodemailer authentication.

## RT damage reports

Delivery agents can submit an RT number and damaged-stock photo from the dashboard.
Reports are permanent and cannot be deleted through the app. They are shown to the
whole workspace, including managers, filtered by the dashboard's selected date.

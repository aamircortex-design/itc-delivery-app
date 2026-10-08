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
Admins and managers can filter the delivery list by assigned delivery agent;
completed deliveries are highlighted green.
The daily delivery Excel export includes the assigned delivery partner and each
returned item's return reason.

## Admin profitability report

The admin-only Profitability tab imports only the sales rows matching the selected
date. It reads `Invoice Qty` and optional `Sales Return Qty`, pre-tax `Gross
Amount`, `Total Discount` as the RFA claim, `Tax Group Amount` as output GST,
and `Category` (also accepts the source register's `Cagetory` spelling).
Sales return quantity is subtracted from invoice quantity for purchase-cost
calculation; the register should provide return amounts and tax as negative
values. Reimporting a date replaces that date's profitability sales rows without
changing other dates or delivery records.

Product costs can be uploaded from the admin Profitability tab using the purchase
price list CSV or Excel workbook. For the purchase file format, the importer finds
the worksheet containing the purchase data and then finds the header row. If
multiple worksheets contain purchase rows, the upload is rejected with their
names so the intended worksheet can be uploaded by itself. It reads `Product
Code`/`Item Code`, `Product Name`/`Product Description`, `Invoice Date`,
`Invoice Ref. No.`, `Original PTS` (preferred; `NET PTS` is only a fallback),
`Inv Disc%`, and GST-rate columns. It picks the newest invoice date per product
code, breaking same-date ties by the highest invoice reference. It calculates
pre-tax per-piece cost as
`Original PTS × (1 − Inv Disc% / 100)` and applies combined SGST/CGST (or IGST) to
calculate the GST-inclusive purchase price. The pre-tax cost and GST rate are
stored separately for profitability and input-GST estimates. The
importer also accepts pre-tax `Purchase Unit Cost` with an optional
`GST Percentage`, or `Item Code`, `Item Name`, `GST Percentage`, and `Net Price
per PC Including GST` by removing GST from the inclusive price. New SKUs are
added, existing SKUs are updated, and SKUs absent from an upload are left
unchanged. Each SKU should occur once per file. The simpler `SKU` plus pre-tax
`Purchase Price` file format is also accepted; when that format updates an
existing SKU, its GST rate is preserved, while a new SKU defaults to 0% input
GST if no GST Percentage is supplied. To manage costs directly in the database
instead, load one cost row per product into
`profitability_product_costs`, scoped to its workspace:

- `company_id`: the workspace ID from `companies`.
- `item_code`: the sales register's Item Code (preferred); use an empty string to
  match by item name instead.
- `item_name`: the sales register's Item Name.
- `purchase_unit_cost`: current pre-tax purchase cost for one unit.
- `input_gst_rate`: input GST percentage for that unit cost (for example, `18`).

For example, after connecting to the correct local or persistent Render database:

```sql
INSERT INTO profitability_product_costs
  (company_id, item_code, item_name, purchase_unit_cost, input_gst_rate)
SELECT id, 'SKU-001', 'Example Product', 100.00, 18
FROM companies
WHERE name = 'Your Workspace'
ON CONFLICT (company_id, item_code, item_name) DO UPDATE SET
  purchase_unit_cost = excluded.purchase_unit_cost,
  input_gst_rate = excluded.input_gst_rate,
  updated_at = CURRENT_TIMESTAMP;
```

The report matches by item code first and falls back to name only for cost rows
whose item code is blank. It estimates cost of goods sold and input GST for the
quantity sold that day. The selected-date report displays a row per bill and SKU
with pre-tax net purchase cost, net selling cost (pre-tax gross sales), GST
payable, margin before RFA, RFA amount, and margin after RFA. Profit amounts use
`pre-tax selling cost - pre-tax purchase cost`; input GST is calculated
separately and excluded from profit. Margin percentages use GST-inclusive
purchase cost (`pre-tax unit cost + input GST`) × net quantity as the denominator.
Margin before RFA is `profit before RFA / GST-inclusive purchase cost`; margin
after RFA includes RFA in profit and uses the same denominator. GST payable is
output GST less estimated input GST.
Verify tax-credit eligibility and final tax
calculations with your accountant.
For the local workspace, SKUs `PFDSO0544` and `12863` are excluded from the
2026-10-06 report only, as specifically requested; they remain included on other
report dates. Zero-invoice-quantity sales returns are included when a
`Sales Return Qty` column is present; reimport dates previously uploaded without
that field to populate their return quantities.
Product costs must be loaded separately into the local and hosted databases.
The Net RFA Due from Company tab has independent From and To date filters. It
groups `Total Discount` as net RFA by product category across the selected
inclusive period and displays the period total. Negative discounts on sales
returns reduce the RFA due. The shared profitability report date remains
dedicated to SKU profitability and the sales-register upload. GST payable is
output GST less estimated input GST and is rounded to the nearest paise.
Both the selected-day SKU report and the selected-period Net RFA report can be
exported as Excel workbooks from their respective tabs.

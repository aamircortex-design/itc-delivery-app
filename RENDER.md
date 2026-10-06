# Deploy TAF Disti Desk to Render

## Before deploying

- Push the project code to a private GitHub repository. Do not commit `.env` files,
  `node_modules`, uploaded files, or `delivery.sqlite`.
- The Render Blueprint in `render.yaml` compiles `sqlite3` from source to match
  Render's system libraries, creates a Node web service, and mounts a
  persistent disk at `/var/data`. The app stores its SQLite database at
  `/var/data/delivery.sqlite`.
- The Blueprint uses a paid web-service plan because the SQLite database requires
  persistent storage. Review Render's current service and disk prices before you
  apply it.

## Create the service

1. In Render, choose **New → Blueprint** and connect the private GitHub repository.
2. Review the `taf-disti-desk` service, its persistent disk, and the estimated cost.
3. Apply the Blueprint and wait for the `/health` deployment check to pass.
4. Open the generated `https://...onrender.com` address. Complete first-time setup
   if the hosted database is empty, or sign in if you have migrated your accounts.
5. On Android, open the HTTPS address in Chrome and select **⋮ → Install app**.

The local SQLite database is intentionally excluded from Git and is not copied to
Render by deployment. A new Render disk starts with an empty database. Plan a separate
and verified database migration before switching live delivery work to the hosted
service; keep the local source database and a backup unchanged until the hosted copy
has been checked.

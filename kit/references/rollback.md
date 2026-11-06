# Rollback

## What rolls back, and what doesn't

| Thing | Rolls back? | How |
|---|---|---|
| Code (the release) | Yes, in seconds | `current` points at the previous release again |
| Process config (PM2 file in the release) | Yes | copied from the release that becomes live |
| Database schema and data | **No** | migrations are kept; restore a dump only as a last resort |
| Env file, uploads, storage | No (shared) | they belong to production, not to a release |
| Build-time values baked into the frontend | Yes (they're in the release) | |

So rollback is safe exactly when **the previous release works with the current
schema**. That's the reason for the expand-then-contract rule in
`environment-and-database.md`.

## Automatic

When a deploy's health checks fail after the switch, the release manager:

1. switches `current` back to the release that was live,
2. reloads the processes,
3. checks the old release is healthy again (and warns loudly if it isn't),
4. renames the new release `<id>-failed` (the newest three are kept for reading),
5. fails the GitHub job, so nobody thinks it deployed.

A failure **before** the switch (unpack, checks, shared links, the dump,
migrations) never touches the live release.

## By hand

```bash
sudo <app>-deploy --status       # what's there, and which is live
sudo <app>-deploy --rollback     # the newest good release older than the live one
```

Or deploy an older commit through the pipeline (Actions → Deploy to Plesk → Run
workflow → `ref`). It's slower, but tested and recorded. Prefer `--rollback` for
speed during an incident, then fix forward through the pipeline.

After a rollback, check what you'd check after a deploy (`verification-checklist.md`, the "live application"
part). The public health URL should report the previous commit.

## When the database is the problem

1. **Stop the damage first**: roll back the code if the old code works with the
   new schema. Otherwise put the app in maintenance mode, or stop the processes
   that write.
2. **Prefer fixing forward**: a new migration that repairs the data or
   schema, through the pipeline.
3. **Restore only with the user's explicit decision**, and only after taking a
   dump of the current state. Restoring the pre-migration dump
   (`<BACKUP_DIR>/pre-<release>.dump`) loses every write since that deploy. Say
   how much that is before anyone decides.
   ```bash
   # PostgreSQL: into a NEW database first, to check it; never straight over production
   createdb -T template0 <db>_restore_check
   pg_restore --no-owner -d <db>_restore_check <BACKUP_DIR>/pre-<release>.dump
   ```
   Swapping it in is a planned, agreed step with the app stopped.

## Emergencies

- **Pipeline down, fix urgent:** Run workflow with `skip_tests`. Record why, and
  run the tests afterwards.
- **GitHub down:** `--rollback` still works on the server, because it needs
  nothing from outside.
- **Server unhealthy for reasons that have nothing to do with the release**
  (disk full, database down, certificate expired): rolling back won't help. Fix
  the cause. `df -h`, `systemctl status postgresql`, Plesk's domain logs.
- **The old checkout** that ran production before the first release-managed deploy is left in place. It's the
  way back if the release-managed setup itself fails during adoption: point PM2 back at it
  (`pm2 delete <names>; cd <old checkout> && pm2 start <its config>; pm2 save`). Remove it only with the
  user's agreement, after a few good deploys and one rollback drill.

## Keep it practised

Do one rollback drill after the first two deploys, and again after any change to
the release manager. Record how long it took. A rollback nobody has tried is a
plan, not a capability.

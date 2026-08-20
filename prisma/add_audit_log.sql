-- Privacy: Erase all stored IP addresses and device types from the users table.
-- Safe to run multiple times (UPDATE does nothing if values are already NULL).
UPDATE users
SET
  "lastIpAddress" = NULL,
  "deviceType"    = NULL
WHERE
  "lastIpAddress" IS NOT NULL
  OR "deviceType" IS NOT NULL;

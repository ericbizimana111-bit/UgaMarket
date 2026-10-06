-- UgaMarket has exactly ONE super admin (the owner). Only the owner manages
-- staff accounts and assigns roles (ADMIN / DISPATCHER).

-- 1. If several super admins exist, keep the earliest active one as owner and
--    turn the others into regular admins (nobody loses access).
WITH owner AS (
  SELECT id FROM "admins"
  WHERE "role" = 'SUPER_ADMIN'
  ORDER BY "is_active" DESC, "created_at" ASC
  LIMIT 1
)
UPDATE "admins" SET "role" = 'ADMIN'
WHERE "role" = 'SUPER_ADMIN' AND "id" NOT IN (SELECT id FROM owner);

-- 2. The database itself refuses a second super admin.
CREATE UNIQUE INDEX "admins_single_super_admin" ON "admins" ("role") WHERE "role" = 'SUPER_ADMIN';

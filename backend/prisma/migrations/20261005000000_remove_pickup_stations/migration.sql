-- UgaMarket is delivery-only: retire pickup stations completely.
-- Legacy pickup data (if any) is folded into the equivalent delivery states
-- before the enum values are dropped, so no history row is lost.

-- 1. Remap legacy rows ------------------------------------------------------
UPDATE "orders" SET "status" = 'READY_FOR_DELIVERY' WHERE "status" = 'READY_FOR_PICKUP';
UPDATE "orders" SET "status" = 'DELIVERED' WHERE "status" = 'PICKED_UP';
UPDATE "orders" SET "delivery_type" = 'HOME_DELIVERY' WHERE "delivery_type" = 'PICKUP_STATION';

UPDATE "order_status_history" SET "status_from" = 'READY_FOR_DELIVERY' WHERE "status_from" = 'READY_FOR_PICKUP';
UPDATE "order_status_history" SET "status_from" = 'DELIVERED' WHERE "status_from" = 'PICKED_UP';
UPDATE "order_status_history" SET "status_to" = 'READY_FOR_DELIVERY' WHERE "status_to" = 'READY_FOR_PICKUP';
UPDATE "order_status_history" SET "status_to" = 'DELIVERED' WHERE "status_to" = 'PICKED_UP';

UPDATE "deliveries" SET "status" = 'DELIVERED' WHERE "status" = 'PICKED_UP';
UPDATE "deliveries" SET "fulfillment_type" = 'HOME_DELIVERY' WHERE "fulfillment_type" = 'PICKUP_STATION';
UPDATE "deliveries" SET "failure_reason" = 'OTHER' WHERE "failure_reason" = 'PICKUP_STATION_ISSUE';

-- 2. Drop pickup columns and table -------------------------------------------
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_pickup_station_id_fkey";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "pickup_station_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "station_snapshot";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "station_snapshot";
DROP TABLE IF EXISTS "pickup_stations";

-- 3. Shrink enums (Postgres cannot drop enum values in place) ---------------
-- DeliveryType
ALTER TYPE "DeliveryType" RENAME TO "DeliveryType_old";
CREATE TYPE "DeliveryType" AS ENUM ('HOME_DELIVERY');
ALTER TABLE "orders" ALTER COLUMN "delivery_type" TYPE "DeliveryType" USING ("delivery_type"::text::"DeliveryType");
ALTER TABLE "deliveries" ALTER COLUMN "fulfillment_type" TYPE "DeliveryType" USING ("fulfillment_type"::text::"DeliveryType");
DROP TYPE "DeliveryType_old";

-- OrderStatus
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING_PAYMENT',
  'COMMITMENT_PAID',
  'CONFIRMED',
  'PREPARING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'BALANCE_PAID',
  'COMPLETED',
  'CANCELLED',
  'PAYMENT_FAILED',
  'DELIVERY_FAILED',
  'REFUNDED'
);
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::text::"OrderStatus");
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';
ALTER TABLE "order_status_history" ALTER COLUMN "status_from" TYPE "OrderStatus" USING ("status_from"::text::"OrderStatus");
ALTER TABLE "order_status_history" ALTER COLUMN "status_to" TYPE "OrderStatus" USING ("status_to"::text::"OrderStatus");
DROP TYPE "OrderStatus_old";

-- DeliveryStatus
ALTER TYPE "DeliveryStatus" RENAME TO "DeliveryStatus_old";
CREATE TYPE "DeliveryStatus" AS ENUM (
  'PENDING',
  'ASSIGNED',
  'READY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'CANCELLED'
);
ALTER TABLE "deliveries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "deliveries" ALTER COLUMN "status" TYPE "DeliveryStatus" USING ("status"::text::"DeliveryStatus");
ALTER TABLE "deliveries" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "DeliveryStatus_old";

-- DeliveryFailureReason
ALTER TYPE "DeliveryFailureReason" RENAME TO "DeliveryFailureReason_old";
CREATE TYPE "DeliveryFailureReason" AS ENUM (
  'CUSTOMER_UNAVAILABLE',
  'INVALID_ADDRESS',
  'DRIVER_UNABLE_TO_COMPLETE',
  'OTHER'
);
ALTER TABLE "deliveries" ALTER COLUMN "failure_reason" TYPE "DeliveryFailureReason" USING ("failure_reason"::text::"DeliveryFailureReason");
DROP TYPE "DeliveryFailureReason_old";

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- AlterTable
ALTER TABLE "call_sessions" ADD COLUMN     "direction" "CallDirection" NOT NULL DEFAULT 'INBOUND';


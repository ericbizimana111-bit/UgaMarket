-- JJuma Global becomes the active payment provider (hosted checkout for
-- MTN Mobile Money and Airtel Money). Additive only: existing payment rows
-- and the dormant FLUTTERWAVE value are untouched.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'JJUMA';

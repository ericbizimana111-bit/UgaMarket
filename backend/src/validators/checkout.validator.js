const { z } = require('zod');
const { deliveryOnlyMethod } = require('./order.validator');

const uuidSchema = z
  .string({ invalid_type_error: 'ID must be a string' })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'ID must be a valid UUID');

// Delivery-only checkout preview (see order.validator deliveryOnlyMethod).
const checkoutPreviewSchema = {
  body: z
    .object({
      fulfillmentMethod: deliveryOnlyMethod,
      addressId: uuidSchema.nullable().optional(),
      // Mass-assignment protection: client can never supply totals/prices/ids of other resources
      subtotalUgx: z.unknown().optional(),
      deliveryFeeUgx: z.unknown().optional(),
      totalUgx: z.unknown().optional(),
      commitmentUgx: z.unknown().optional(),
      remainingBalanceUgx: z.unknown().optional(),
      userId: z.unknown().optional(),
    })
    .transform((body) => ({
      fulfillmentMethod: 'HOME_DELIVERY',
      addressId: body.addressId ?? null,
    }))
    .refine((body) => !!body.addressId, {
      message: 'addressId is required: choose or add a delivery address',
      path: ['addressId'],
    }),
};

module.exports = {
  checkoutPreviewSchema,
};

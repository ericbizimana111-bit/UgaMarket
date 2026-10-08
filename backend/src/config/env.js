const { z } = require('zod');
const dotenv = require('dotenv');

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  // Bind address. 0.0.0.0 (all interfaces) is required for container
  // deployment; local development is unaffected since it also serves
  // localhost.
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ADMIN_JWT_SECRET: z.string().min(16, 'ADMIN_JWT_SECRET must be at least 16 characters'),
  ADMIN_JWT_EXPIRES_IN: z.string().default('1d'),
  
  // Initial admin credentials for seeding
  ADMIN_1_EMAIL: z.string().email().default('admin@ugandafood.market'),
  ADMIN_1_PASSWORD: z.string().min(8).default('AdminSecurePass123!'),
  ADMIN_1_NAME: z.string().default('Primary Admin'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://localhost:5173'),

  // Warehouse origin
  WAREHOUSE_LATITUDE: z.coerce.number().default(0.3136),
  WAREHOUSE_LONGITUDE: z.coerce.number().default(32.5811),

  // Payment
  PAYMENT_PROVIDER: z.enum(['MOCK', 'JJUMA', 'FLUTTERWAVE', 'MTN_MOMO', 'AIRTEL_MONEY']).default('MOCK'),
  // TEST (sandbox) | LIVE. Real credentials are only required in production
  // (validated in config/envValidation.js); tests never need them.
  PAYMENT_MODE: z.enum(['TEST', 'LIVE']).default('TEST'),
  // JJuma Global (active provider). Public key creates hosted-checkout
  // payments; secret key verifies them server-side; the webhook secret is the
  // dashboard signing secret (Dashboard > Tools > Webhooks). Empty defaults
  // keep development/test running without real credentials.
  JJUMA_API_BASE_URL: z.string().default('https://api.jjuma.com'),
  JJUMA_PUBLIC_KEY: z.string().default(''),
  JJUMA_SECRET_KEY: z.string().default(''),
  JJUMA_WEBHOOK_SECRET: z.string().default(''),
  // Flutterwave credentials (dormant; kept for a possible future switch).
  FLW_PUBLIC_KEY: z.string().default(''),
  FLW_SECRET_KEY: z.string().default(''),
  PAYMENT_WEBHOOK_SECRET: z.string().default('ufm_mock_webhook_secret_2026'),
  PAYMENT_ATTEMPT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  // Public URL of the customer shop: customers are sent back here after a
  // payment step (GET /api/payments/return). Defaults to the CRA dev server.
  FRONTEND_URL: z.string().default('http://localhost:3000'),

  // Image storage. When CLOUDINARY_URL is set (cloudinary://<key>:<secret>@<cloud>),
  // uploaded and sample photos are stored on Cloudinary's CDN; otherwise on
  // local disk under uploads/images (development, Docker with a volume).
  // Hosts with an ephemeral filesystem (e.g. Render free) MUST use Cloudinary.
  CLOUDINARY_URL: z.string().default(''),
  CLOUDINARY_FOLDER: z.string().default('ugamarket'),

  // Delivery Pricing
  DELIVERY_BASE_FEE: z.coerce.number().default(3000),
  DELIVERY_FREE_RADIUS_KM: z.coerce.number().default(3.0),
  DELIVERY_PER_KM_RATE: z.coerce.number().default(1200),
  DELIVERY_MINIMUM_FEE: z.coerce.number().default(3000),

  // Commitment
  COMMITMENT_RULE_TYPE: z.enum(['PERCENTAGE', 'FLAT', 'TIERED']).default('PERCENTAGE'),
  COMMITMENT_PERCENTAGE: z.coerce.number().default(30.0),
  COMMITMENT_MIN_AMOUNT: z.coerce.number().default(5000),

  // Location services. NONE disables network calls (tests default to NONE;
  // addresses are then validated offline against the Uganda district data).
  // NOMINATIM works with the public OpenStreetMap server (respect its usage
  // policy: <=1 req/s, identifying User-Agent) or a self-hosted instance.
  GEOCODER_PROVIDER: z.enum(['NOMINATIM', 'NONE']).optional(),
  NOMINATIM_URL: z.string().default('https://nominatim.openstreetmap.org'),
  // Contact sent in the User-Agent, required by the OSM usage policy.
  GEO_CONTACT_EMAIL: z.string().default('support@ugamarket.ug'),
  // Road routing for distance/ETA/route lines (OSRM public demo or self-hosted).
  ROUTING_PROVIDER: z.enum(['OSRM', 'NONE']).optional(),
  OSRM_URL: z.string().default('https://router.project-osrm.org'),
  // Straight-line distance x factor = estimated road distance when routing is off.
  ROAD_DISTANCE_FACTOR: z.coerce.number().min(1).max(3).default(1.35),

  // Automatic product/category/service name translation (English source).
  // MYMEMORY needs no key; LIBRETRANSLATE needs LIBRETRANSLATE_URL (+ key);
  // GOOGLE needs GOOGLE_TRANSLATE_API_KEY. Luganda support depends on provider.
  TRANSLATION_PROVIDER: z.enum(['GOOGLE', 'LIBRETRANSLATE', 'MYMEMORY', 'NONE']).optional(),
  GOOGLE_TRANSLATE_API_KEY: z.string().default(''),
  LIBRETRANSLATE_URL: z.string().default(''),
  LIBRETRANSLATE_API_KEY: z.string().default(''),
  MYMEMORY_EMAIL: z.string().default(''),

  // "Continue with Google": the OAuth 2.0 Web client ID (public, not a secret).
  // Google ID tokens are only accepted when issued for this client. Empty
  // disables Google sign-in (the endpoint answers 503).
  GOOGLE_CLIENT_ID: z.string().trim().default(''),
});

const { validateProductionConfig } = require('./envValidation');

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment configuration validation failed:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

// Environment-aware production hardening: production startup fails fast on
// missing or unsafe security configuration (see config/envValidation.js for
// the exact rules). Development and test keep their practical defaults so
// existing workflows and the test suite are unaffected. Messages identify
// variable names only — secret values are never printed.
if (parsed.data.NODE_ENV === 'production') {
  const problems = validateProductionConfig(parsed.data, process.env);
  if (problems.length > 0) {
    console.error('❌ Production environment configuration is invalid:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error('Fix the environment configuration and restart. Secret values are never shown.');
    process.exit(1);
  }
}

// External providers default to off under test so the suite never reaches
// the network; everywhere else they default to the free public services.
const isTest = parsed.data.NODE_ENV === 'test';
// Tests never call external services, whatever backend/.env says (individual
// tests switch a provider on explicitly and mock the network).
parsed.data.GEOCODER_PROVIDER = isTest ? 'NONE' : parsed.data.GEOCODER_PROVIDER || 'NOMINATIM';
parsed.data.ROUTING_PROVIDER = isTest ? 'NONE' : parsed.data.ROUTING_PROVIDER || 'OSRM';
parsed.data.TRANSLATION_PROVIDER = isTest ? 'NONE' : parsed.data.TRANSLATION_PROVIDER || 'MYMEMORY';
if (isTest) {
  // Never upload to a real Cloudinary account or charge through a real payment
  // provider from the test suite, even if backend/.env is configured for them.
  parsed.data.CLOUDINARY_URL = '';
  parsed.data.PAYMENT_PROVIDER = 'MOCK';
}

module.exports = parsed.data;

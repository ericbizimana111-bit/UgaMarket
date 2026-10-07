/**
 * Configuration validation tests (Phase 11 Step 2).
 *
 * These tests exercise config/envValidation.js PURELY: validateProductionConfig
 * takes a config object + raw env and returns problems. Nothing here touches
 * the database, spawns the app, or reads the real backend/.env.
 *
 * Note: we do NOT require('../config/env') in this file — requiring it would
 * bind the real environment at import time. The pure module is the unit under
 * test; env.js's wiring (exit on production problems) is intentionally thin.
 */

const {
  validateProductionConfig,
  PRODUCTION_MIN_SECRET_LENGTH,
} = require('../src/config/envValidation');

const LONG = 'a'.repeat(32);
const LONG2 = 'b'.repeat(32);

// A fully valid production configuration.
function validProductionConfig(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:password@db.example.com:5432/uganda_food_marketplace?schema=public',
    JWT_SECRET: LONG,
    JWT_EXPIRES_IN: '7d',
    ADMIN_JWT_SECRET: LONG2,
    ADMIN_JWT_EXPIRES_IN: '1d',
    ADMIN_1_EMAIL: 'admin@example.com',
    ADMIN_1_PASSWORD: 'Str0ngProductionPass!x',
    ADMIN_1_NAME: 'Primary Admin',
    CORS_ORIGIN: 'https://shop.example.com,https://admin.example.com',
    PAYMENT_PROVIDER: 'FLUTTERWAVE',
    PAYMENT_MODE: 'TEST',
    // Dashboard-shaped TEST credentials (NOT real secrets; safe in TEST mode
    // production while PAYMENT_MODE=TEST — see rule 7 in envValidation.js).
    FLW_PUBLIC_KEY: 'FLWPUBK_TEST-0123456789abcdef0123456789abcdef',
    FLW_SECRET_KEY: 'FLWSECK_TEST-0123456789abcdef0123456789abcdef',
    PAYMENT_WEBHOOK_SECRET: 'w'.repeat(32),
    PAYMENT_ATTEMPT_TTL_MINUTES: 30,
    ...overrides,
  };
}

describe('validateProductionConfig (production environment validation)', () => {
  describe('valid configuration passes', () => {
    test('accepts a fully valid production configuration', () => {
      expect(validateProductionConfig(validProductionConfig(), validProductionConfig())).toEqual([]);
    });

    test('accepts explicit CORS origins provided via raw env only', () => {
      const config = validProductionConfig();
      // Simulate CORS_ORIGIN coming only from the parsed schema default path
      // while being genuinely present in the raw environment.
      expect(validateProductionConfig(config, { ...config, CORS_ORIGIN: 'https://shop.example.com' })).toEqual([]);
    });
  });

  describe('required secrets must exist in production', () => {
    test('rejects missing PAYMENT_WEBHOOK_SECRET (no insecure default allowed)', () => {
      const config = validProductionConfig();
      const raw = { ...config };
      delete raw.PAYMENT_WEBHOOK_SECRET;
      const problems = validateProductionConfig(config, raw);
      expect(problems).toContainEqual(
        expect.stringContaining('PAYMENT_WEBHOOK_SECRET is required in production')
      );
    });

    test('rejects missing ADMIN_1_PASSWORD', () => {
      const config = validProductionConfig();
      const raw = { ...config };
      delete raw.ADMIN_1_PASSWORD;
      const problems = validateProductionConfig(config, raw);
      expect(problems.some((p) => p.includes('ADMIN_1_PASSWORD is required in production'))).toBe(true);
    });

    test('rejects blank-string secrets', () => {
      const config = validProductionConfig();
      const raw = { ...config, PAYMENT_WEBHOOK_SECRET: '   ' };
      const problems = validateProductionConfig(config, raw);
      expect(problems).toContainEqual(
        expect.stringContaining('PAYMENT_WEBHOOK_SECRET is required in production')
      );
    });
  });

  describe('insecure defaults and placeholders are rejected', () => {
    test('rejects the historical mock webhook secret default', () => {
      const config = validProductionConfig({ PAYMENT_WEBHOOK_SECRET: 'ufm_mock_webhook_secret_2026' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(
        expect.stringContaining('PAYMENT_WEBHOOK_SECRET is set to a known insecure placeholder/default')
      );
    });

    test('rejects .env.example placeholder webhook secret', () => {
      const config = validProductionConfig({ PAYMENT_WEBHOOK_SECRET: 'replace_with_webhook_signature_secret' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(
        expect.stringContaining('PAYMENT_WEBHOOK_SECRET is set to a known insecure placeholder/default')
      );
    });

    test('rejects historical insecure admin password defaults', () => {
      const config = validProductionConfig({
        ADMIN_1_PASSWORD: 'AdminSecurePass123!',
      });
      const problems = validateProductionConfig(config, config);
      expect(problems.some((p) => p.includes('ADMIN_1_PASSWORD is set to a known insecure placeholder/default'))).toBe(true);
    });

    test('rejects .env.example placeholder admin passwords', () => {
      const config = validProductionConfig({
        ADMIN_1_PASSWORD: 'change_this_admin_password_in_env',
      });
      const problems = validateProductionConfig(config, config);
      expect(problems.some((p) => p.includes('ADMIN_1_PASSWORD is set to a known insecure placeholder/default'))).toBe(true);
    });
  });

  describe('secret quality', () => {
    test('requires at least 32 characters for JWT/webhook secrets', () => {
      expect(PRODUCTION_MIN_SECRET_LENGTH).toBe(32);
      const config = validProductionConfig({
        JWT_SECRET: 'short_but_dev_ok_16ch',
        ADMIN_JWT_SECRET: 'also_short_16ch_x',
        PAYMENT_WEBHOOK_SECRET: 'x'.repeat(16),
      });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('JWT_SECRET must be at least 32 characters'));
      expect(problems).toContainEqual(expect.stringContaining('ADMIN_JWT_SECRET must be at least 32 characters'));
      expect(problems).toContainEqual(expect.stringContaining('PAYMENT_WEBHOOK_SECRET must be at least 32 characters'));
    });
  });

  describe('JWT secret separation', () => {
    test('rejects identical customer and admin JWT secrets', () => {
      const config = validProductionConfig({ JWT_SECRET: LONG, ADMIN_JWT_SECRET: LONG });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(
        expect.stringContaining('JWT_SECRET and ADMIN_JWT_SECRET must be different')
      );
    });
  });

  describe('CORS', () => {
    test('rejects missing CORS_ORIGIN in production', () => {
      const config = validProductionConfig();
      const raw = { ...config };
      delete raw.CORS_ORIGIN;
      const problems = validateProductionConfig(config, raw);
      expect(problems).toContainEqual(expect.stringContaining('CORS_ORIGIN is required in production'));
    });

    test('rejects wildcard CORS origin in production', () => {
      const config = validProductionConfig({ CORS_ORIGIN: '*' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('must not contain the wildcard'));
    });

    test('rejects wildcard inside a comma-separated list', () => {
      const config = validProductionConfig({ CORS_ORIGIN: 'https://shop.example.com, *' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('must not contain the wildcard'));
    });

    test('rejects an empty origin list', () => {
      const config = validProductionConfig({ CORS_ORIGIN: '  ,  ' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('at least one explicit origin'));
    });
  });

  describe('mock payment provider safety', () => {
    test('rejects PAYMENT_PROVIDER=MOCK in production', () => {
      const config = validProductionConfig({ PAYMENT_PROVIDER: 'MOCK' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('PAYMENT_PROVIDER=MOCK is not allowed in production'));
    });

    test('rejects lowercase mock value too', () => {
      const config = validProductionConfig({ PAYMENT_PROVIDER: 'mock' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('PAYMENT_PROVIDER=MOCK is not allowed in production'));
    });
  });

  describe('Flutterwave credentials (Phase 12 Step 2)', () => {
    test('accepts dashboard-shaped TEST keys in production while PAYMENT_MODE=TEST', () => {
      const problems = validateProductionConfig(validProductionConfig(), validProductionConfig());
      expect(problems).toEqual([]);
    });

    test('rejects missing FLW credentials in production with FLUTTERWAVE provider', () => {
      const config = validProductionConfig({ FLW_PUBLIC_KEY: '', FLW_SECRET_KEY: '' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('FLW_PUBLIC_KEY is required in production'));
      expect(problems).toContainEqual(expect.stringContaining('FLW_SECRET_KEY is required in production'));
    });

    test('rejects obvious placeholder FLW credentials', () => {
      const config = validProductionConfig({
        FLW_PUBLIC_KEY: 'replace_with_your_public_key',
        FLW_SECRET_KEY: 'xxxxxxxxxxxxxxxx',
      });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('FLW_PUBLIC_KEY is set to an obvious placeholder'));
      expect(problems).toContainEqual(expect.stringContaining('FLW_SECRET_KEY is set to an obvious placeholder'));
    });

    test('rejects TEST keys when PAYMENT_MODE=LIVE', () => {
      const config = validProductionConfig({ PAYMENT_MODE: 'LIVE' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toContainEqual(expect.stringContaining('FLW_PUBLIC_KEY looks like a TEST key'));
      expect(problems).toContainEqual(expect.stringContaining('FLW_SECRET_KEY looks like a TEST key'));
    });

    test('ACCEPTS TEST keys in LIVE mode check only via _TEST- marker — non-TEST LIVE keys pass', () => {
      const config = validProductionConfig({
        PAYMENT_MODE: 'LIVE',
        FLW_PUBLIC_KEY: 'FLWPUBK-0123456789abcdef0123456789',
        FLW_SECRET_KEY: 'FLWSECK-0123456789abcdef0123456789',
      });
      const problems = validateProductionConfig(config, config);
      expect(problems).toEqual([]);
    });

    test('does not enforce FLW credentials when provider is not FLUTTERWAVE', () => {
      // MOCK is separately rejected; a hypothetical other provider (e.g.
      // MTN_MOMO) must not be blocked by FLW rules — check via a provider the
      // schema allows besides MOCK/FLUTTERWAVE.
      const config = validProductionConfig({ PAYMENT_PROVIDER: 'MTN_MOMO', FLW_PUBLIC_KEY: '', FLW_SECRET_KEY: '' });
      const problems = validateProductionConfig(config, config);
      expect(problems).toEqual([]);
    });
  });

  describe('error message hygiene', () => {
    test('problem messages never contain secret values', () => {
      const secretValue = 'SUPER_SECRET_VALUE_never_print_9f8e7d6c';
      const config = validProductionConfig({
        JWT_SECRET: secretValue,
        ADMIN_JWT_SECRET: secretValue, // also triggers the equality rule
        PAYMENT_WEBHOOK_SECRET: 'x'.repeat(31), // triggers the length rule
      });
      const problems = validateProductionConfig(config, config);
      expect(problems.length).toBeGreaterThan(0);
      for (const problem of problems) {
        expect(problem).not.toContain(secretValue);
      }
    });
  });
  describe('automatic translation provider', () => {
    test('GOOGLE without an API key is rejected', () => {
      const config = validProductionConfig({ TRANSLATION_PROVIDER: 'GOOGLE', GOOGLE_TRANSLATE_API_KEY: '' });
      expect(validateProductionConfig(config, config)).toContain('TRANSLATION_PROVIDER=GOOGLE requires GOOGLE_TRANSLATE_API_KEY.');
    });

    test('LIBRETRANSLATE without a URL is rejected', () => {
      const config = validProductionConfig({ TRANSLATION_PROVIDER: 'LIBRETRANSLATE', LIBRETRANSLATE_URL: '' });
      expect(validateProductionConfig(config, config)).toContain('TRANSLATION_PROVIDER=LIBRETRANSLATE requires LIBRETRANSLATE_URL.');
    });

    test('a configured provider passes', () => {
      const config = validProductionConfig({ TRANSLATION_PROVIDER: 'GOOGLE', GOOGLE_TRANSLATE_API_KEY: 'AIza-test-key-value' });
      expect(validateProductionConfig(config, config)).toEqual([]);
    });
  });
});

describe('image storage on ephemeral hosts', () => {
  const { validateProductionConfig: validate } = require('../src/config/envValidation');
  const base = () => {
    const c = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/ugamarket',
      JWT_SECRET: 'j'.repeat(40),
      ADMIN_JWT_SECRET: 'a'.repeat(40),
      ADMIN_1_PASSWORD: 'Owner-Strong-Pass-2026',
      CORS_ORIGIN: 'https://ugamarket.vercel.app',
      PAYMENT_PROVIDER: 'FLUTTERWAVE',
      PAYMENT_MODE: 'TEST',
      FLW_PUBLIC_KEY: 'FLWPUBK_TEST-0123456789abcdef0123456789abcdef',
      FLW_SECRET_KEY: 'FLWSECK_TEST-0123456789abcdef0123456789abcdef',
      PAYMENT_WEBHOOK_SECRET: 'w'.repeat(32),
      PAYMENT_ATTEMPT_TTL_MINUTES: 30,
    };
    return c;
  };
  const cloudinaryProblems = (config, raw) => validate(config, raw).filter((p) => p.includes('CLOUDINARY_URL'));

  test('Render without Cloudinary is refused (photos would vanish on restart)', () => {
    const c = base();
    expect(cloudinaryProblems(c, { ...c, RENDER: 'true' })).toEqual([expect.stringContaining('required on Render')]);
  });

  test('Render with Cloudinary is accepted', () => {
    const c = { ...base(), CLOUDINARY_URL: 'cloudinary://123:abc@ugamarket' };
    expect(cloudinaryProblems(c, { ...c, RENDER: 'true' })).toEqual([]);
  });

  test('a malformed CLOUDINARY_URL is refused anywhere', () => {
    const c = { ...base(), CLOUDINARY_URL: 'https://cloudinary.com/console' };
    expect(cloudinaryProblems(c, c)).toEqual([expect.stringContaining('must look like')]);
  });

  test('Docker / VM hosts may keep photos on their persistent volume', () => {
    const c = base();
    expect(cloudinaryProblems(c, c)).toEqual([]);
  });
});

describe('template placeholders and admin password strength', () => {
  const { validateProductionConfig: validate } = require('../src/config/envValidation');
  const good = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.example.com:5432/ugamarket',
    JWT_SECRET: 'j'.repeat(40),
    ADMIN_JWT_SECRET: 'a'.repeat(40),
    ADMIN_1_PASSWORD: 'Owner-Strong-Pass-2026',
    CORS_ORIGIN: 'https://ugamarket.vercel.app',
    PAYMENT_PROVIDER: 'FLUTTERWAVE',
    PAYMENT_MODE: 'TEST',
    FLW_PUBLIC_KEY: 'FLWPUBK_TEST-0123456789abcdef0123456789abcdef',
    FLW_SECRET_KEY: 'FLWSECK_TEST-0123456789abcdef0123456789abcdef',
    PAYMENT_WEBHOOK_SECRET: 'w'.repeat(32),
    PAYMENT_ATTEMPT_TTL_MINUTES: 30,
  };

  test('a complete configuration has no placeholder/password problems', () => {
    expect(validate(good, good).filter((p) => /placeholder like|must be at least 10/.test(p))).toEqual([]);
  });

  test('values copied unfilled from the template are refused (any variable)', () => {
    const c = { ...good, ADMIN_1_PASSWORD: '<ADMIN_1_PASSWORD>', CORS_ORIGIN: 'https://<customer-domain>' };
    const problems = validate(c, c);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ADMIN_1_PASSWORD still contains a template placeholder'),
        expect.stringContaining('CORS_ORIGIN still contains a template placeholder'),
      ])
    );
  });

  test('a weak owner password is refused', () => {
    const c = { ...good, ADMIN_1_PASSWORD: 'password' };
    const problems = validate(c, c);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ADMIN_1_PASSWORD must be at least 10 characters'),
      ])
    );
  });
});

describe('JJuma Global production configuration', () => {
  const { validateProductionConfig: validate } = require('../src/config/envValidation');
  // Dashboard-shaped dummy keys (NOT real credentials).
  const jjuma = (overrides = {}) => ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.example.com:5432/ugamarket',
    JWT_SECRET: 'j'.repeat(40),
    ADMIN_JWT_SECRET: 'a'.repeat(40),
    ADMIN_1_PASSWORD: 'Owner-Strong-Pass-2026',
    CORS_ORIGIN: 'https://ugamarket.vercel.app,https://ugamarket-admin.vercel.app',
    FRONTEND_URL: 'https://ugamarket.vercel.app',
    PAYMENT_PROVIDER: 'JJUMA',
    PAYMENT_MODE: 'TEST',
    JJUMA_API_BASE_URL: 'https://api.jjuma.com',
    JJUMA_PUBLIC_KEY: 'bp_test_pub_0123456789abcdef0123',
    JJUMA_SECRET_KEY: 'bp_test_sec_0123456789abcdef0123',
    JJUMA_WEBHOOK_SECRET: 'jjuma_config_test_signing_secret_0123456789',
    PAYMENT_WEBHOOK_SECRET: 'w'.repeat(32),
    PAYMENT_ATTEMPT_TTL_MINUTES: 30,
    ...overrides,
  });
  const check = (c) => validate(c, c);

  test('a complete JJuma TEST configuration passes', () => {
    expect(check(jjuma())).toEqual([]);
  });

  test('a complete JJuma LIVE configuration passes', () => {
    expect(
      check(jjuma({ PAYMENT_MODE: 'LIVE', JJUMA_PUBLIC_KEY: 'bp_live_pub_0123456789abcdef', JJUMA_SECRET_KEY: 'bp_live_sec_0123456789abcdef' }))
    ).toEqual([]);
  });

  test('missing keys and webhook secret are refused', () => {
    const problems = check(jjuma({ JJUMA_PUBLIC_KEY: '', JJUMA_SECRET_KEY: '', JJUMA_WEBHOOK_SECRET: '' }));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('JJUMA_PUBLIC_KEY is required'),
        expect.stringContaining('JJUMA_SECRET_KEY is required'),
        expect.stringContaining('JJUMA_WEBHOOK_SECRET is required'),
      ])
    );
  });

  test('placeholders and non-JJuma-shaped keys are refused', () => {
    const problems = check(jjuma({ JJUMA_PUBLIC_KEY: 'replace_with_public_key', JJUMA_SECRET_KEY: 'sk_live_somethingelse_123' }));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('JJUMA_PUBLIC_KEY is set to an obvious placeholder'),
        expect.stringContaining('JJUMA_SECRET_KEY does not look like a JJuma API key'),
      ])
    );
  });

  test('TEST keys in LIVE mode, and LIVE keys in TEST mode, are refused', () => {
    expect(check(jjuma({ PAYMENT_MODE: 'LIVE' }))).toContainEqual(expect.stringContaining('JJUMA_PUBLIC_KEY is a TEST key'));
    expect(check(jjuma({ JJUMA_SECRET_KEY: 'bp_live_sec_0123456789abcdef' }))).toContainEqual(
      expect.stringContaining('JJUMA_SECRET_KEY is a LIVE key')
    );
  });

  test('FRONTEND_URL must be the public https shop URL', () => {
    const missing = jjuma();
    delete missing.FRONTEND_URL;
    expect(check(missing)).toContainEqual(expect.stringContaining('FRONTEND_URL is required'));
    expect(check(jjuma({ FRONTEND_URL: 'http://localhost:3000' }))).toContainEqual(
      expect.stringContaining('FRONTEND_URL must be the public https:// shop URL')
    );
  });

  test('localhost CORS origins are refused in production', () => {
    expect(check(jjuma({ CORS_ORIGIN: 'http://localhost,http://localhost:8080' }))).toContainEqual(
      expect.stringContaining('CORS_ORIGIN must not contain localhost origins')
    );
  });
});

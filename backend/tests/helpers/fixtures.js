const prisma = require('../../src/config/db');

/**
 * Shared test fixtures.
 *
 * UgaMarket is delivery-only and every address must be a validated Uganda
 * location with a map pin. Tests that need an order create one of these
 * directly in the database (bypassing the online geocoder).
 */

// Ntinda, Nakawa Division, Kampala (~5 km from the default dispatch point).
const KAMPALA_PIN = { latitude: 0.354, longitude: 32.615 };

async function createTestAddress(userId, overrides = {}) {
  return prisma.address.create({
    data: {
      userId,
      title: 'Home',
      region: 'CENTRAL',
      district: 'Kampala',
      division: 'Ntinda',
      streetAddress: 'Plot 12, Ntinda Road',
      landmark: 'Opposite the test supermarket',
      contactPhone: '+256772000111',
      formattedAddress: 'Plot 12, Ntinda Road, Ntinda, Kampala District, Uganda',
      isVerified: true,
      isDefault: true,
      ...KAMPALA_PIN,
      ...overrides,
    },
  });
}

// Required checkout consent (POST /api/orders): current Terms + Privacy versions.
const { LEGAL_VERSIONS } = require('../../src/services/consent.service');
const CHECKOUT_CONSENT = Object.freeze({
  acceptTerms: true,
  termsVersion: LEGAL_VERSIONS.terms,
  privacyVersion: LEGAL_VERSIONS.privacy,
});
// Service-level equivalent (orderService.createOrderFromCart).
const SERVICE_CONSENT = Object.freeze({
  consent: { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, marketingConsent: false },
});

module.exports = { KAMPALA_PIN, createTestAddress, CHECKOUT_CONSENT, SERVICE_CONSENT };

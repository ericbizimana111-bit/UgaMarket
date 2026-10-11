import { LEGAL_VERSIONS } from '../../utils/legal';

/**
 * Policy documents shown on /terms, /privacy, /security, /cookies and
 * /commitment-rules. Written for UgaMarket's actual operation (delivery-only
 * marketplace and home services in Uganda, deposit + balance on delivery,
 * mobile money through JJuma Global).
 *
 * IMPORTANT for the business owner: have these reviewed by a Ugandan lawyer
 * before launch and adjust refund/cancellation rules to your real policy.
 * Changing Terms or Privacy materially? Bump LEGAL_VERSIONS (frontend and
 * backend) so customers accept the new version at their next checkout.
 *
 * Body items: a string is a paragraph; { list: [...] } is a bullet list.
 */

export const LEGAL_DOCS = {
  terms: {
    title: 'Terms and Conditions',
    version: LEGAL_VERSIONS.terms,
    intro:
      'These Terms govern your use of UgaMarket (the website and services) and every order or service booking you make. By creating an account or placing an order you agree to them. Please read them carefully.',
    sections: [
      {
        id: 'about',
        heading: '1. About UgaMarket',
        body: [
          'UgaMarket is an online marketplace operating in Uganda that sells everyday products and arranges home services (such as plumbing, electrical work, cleaning and repairs). We deliver every order to the address you choose; pickup is not offered.',
          'All prices are in Uganda Shillings (UGX) and include applicable taxes unless stated otherwise.'
        ]
      },
      {
        id: 'account',
        heading: '2. Your account',
        body: [
          {
            list: [
              'You must be at least 18 years old, or use UgaMarket with the permission of a parent or guardian.',
              'You must give accurate information and verify your phone number or email address when asked.',
              'Keep your password and verification codes secret. UgaMarket staff will never ask for them.',
              'You are responsible for activity on your account. Tell us immediately if you suspect unauthorised use.'
            ]
          },
          'We may suspend accounts used for fraud, abuse of staff or other customers, or breach of these Terms.'
        ]
      },
      {
        id: 'orders',
        heading: '3. Orders, prices and stock',
        body: [
          'Product descriptions, photos and prices are provided in good faith. The price, delivery fee and deposit are confirmed by our server at checkout and shown before you place the order.',
          'An order is accepted when your commitment deposit is received. If an item becomes unavailable or a price was clearly wrong, we will contact you and you may cancel for a full refund of any amount paid for that item.'
        ]
      },
      {
        id: 'payment',
        heading: '4. Deposit and payment',
        body: [
          'Every order requires a commitment deposit paid by mobile money (MTN MoMo or Airtel Money) through our licensed payment partner. The remaining balance is paid on delivery, after you have inspected your order. See the Commitment Rules for details.',
          'We never ask for your mobile money PIN. Only approve payment prompts that you started on UgaMarket.'
        ]
      },
      {
        id: 'delivery',
        heading: '5. Delivery',
        body: [
          'The delivery fee is calculated from the road distance between our dispatch point and the location you pinned. Delivery times are estimates.',
          'Our rider will call the phone number on your address. If nobody is available to receive the order after reasonable attempts, the delivery may be marked as failed and rescheduled; repeated failed deliveries may be cancelled under the Commitment Rules.'
        ]
      },
      {
        id: 'inspection',
        heading: '6. Inspection, returns and refunds',
        body: [
          'Inspect your order when it arrives. If an item is damaged, wrong or not as described, refuse it at the door or contact us within 48 hours of delivery and we will replace it or refund it.',
          'Fresh food and perishable goods must be checked at delivery. Opened personal-care items cannot be returned for hygiene reasons unless faulty.',
          'Approved refunds are sent to the mobile money number used for payment, normally within 7 working days.'
        ]
      },
      {
        id: 'services',
        heading: '7. Home services',
        body: [
          'Service bookings are confirmed by our team. Where the price type is "inspection", the call-out fee covers the visit and the final job price is quoted on site; work only starts after you accept the quote.',
          'Please make sure an adult is present and the work area is safe and accessible at the booked time.'
        ]
      },
      {
        id: 'conduct',
        heading: '8. Acceptable use',
        body: [
          {
            list: [
              'Do not misuse the website, attempt to access other accounts or interfere with its security.',
              'Do not use chat or voice calls to harass, threaten or abuse our staff.',
              'Do not place orders you do not intend to receive.'
            ]
          }
        ]
      },
      {
        id: 'liability',
        heading: '9. Liability',
        body: [
          'We take reasonable care to provide accurate information and a reliable service. To the extent permitted by Ugandan law, we are not liable for indirect losses, and our total liability for an order is limited to the amount you paid for it. Nothing in these Terms limits your rights under the law of Uganda.'
        ]
      },
      {
        id: 'changes',
        heading: '10. Changes and governing law',
        body: [
          'We may update these Terms. The version and date are shown at the top; at your next checkout you will be asked to accept the current version.',
          'These Terms are governed by the laws of the Republic of Uganda. Contact us first to resolve any complaint; unresolved disputes may be referred to the courts of Uganda.'
        ]
      }
    ]
  },

  privacy: {
    title: 'Privacy Policy',
    version: LEGAL_VERSIONS.privacy,
    intro:
      'This policy explains what personal data UgaMarket collects, why, who we share it with and your rights under the Data Protection and Privacy Act, 2019 of Uganda.',
    sections: [
      {
        id: 'collect',
        heading: '1. Data we collect',
        body: [
          {
            list: [
              'Account details: name, phone number, email address (optional) and an encrypted password, plus whether your phone/email are verified.',
              'Delivery details: addresses, landmarks, contact phone and the map location you pin.',
              'Orders, payments and service bookings: items, amounts, payment status and references (we never see or store your mobile money PIN).',
              'Communications: chat messages with our team and a log of voice calls (time, duration, who answered). Calls are not recorded.',
              'Security data: sign-in and verification events, IP address and device type, used to protect your account.',
              'Your choices: consent to our Terms and Privacy Policy, marketing preferences and cookie settings.'
            ]
          }
        ]
      },
      {
        id: 'use',
        heading: '2. Why we use it',
        body: [
          {
            list: [
              'To create and secure your account and verify your contact details (contract and legitimate interest).',
              'To process, deliver and support your orders and bookings (contract).',
              'To calculate delivery fees and routes from your pinned location (contract).',
              'To prevent fraud and keep records required by law (legal obligation).',
              'To send offers and new-arrival news ONLY if you opted in (consent). You can withdraw at any time.'
            ]
          }
        ]
      },
      {
        id: 'share',
        heading: '3. Who we share it with',
        body: [
          'We do not sell your personal data. We share only what is needed with service providers who act on our instructions:',
          {
            list: [
              'Payment processing: JJuma Global (mobile money collections).',
              'SMS and email delivery for verification codes and notifications.',
              'Hosting, database and image storage providers.',
              'Map and routing services (OpenStreetMap-based) to validate addresses.',
              'Google, only if you choose "Continue with Google".',
              'Our delivery riders and technicians: your name, phone and address for your order.'
            ]
          },
          'We may disclose data where required by Ugandan law or a lawful request.'
        ]
      },
      {
        id: 'retention',
        heading: '4. How long we keep it',
        body: [
          'Account data is kept while your account is open. Order and payment records are kept for the period required by tax and accounting law (normally up to 10 years). Verification codes expire within minutes; security logs are kept for up to 2 years.'
        ]
      },
      {
        id: 'rights',
        heading: '5. Your rights',
        body: [
          {
            list: [
              'Access the personal data we hold about you and get a copy.',
              'Correct inaccurate data (you can update most details in your account).',
              'Ask us to delete data we no longer need.',
              'Object to or withdraw consent for marketing at any time (Account → Security, the unsubscribe link in emails, or by contacting us).',
              'Complain to the Personal Data Protection Office (PDPO) of Uganda.'
            ]
          },
          'To exercise these rights, message us from your account or use the contact details in the Help Center.'
        ]
      },
      {
        id: 'security',
        heading: '6. Security',
        body: ['We protect your data with encryption in transit, hashed passwords and verification codes, access controls and monitoring. See our Security page for details.']
      },
      {
        id: 'children',
        heading: '7. Children',
        body: ['UgaMarket is not directed at children under 18, and we do not knowingly collect their data without parental consent.']
      },
      {
        id: 'changes',
        heading: '8. Changes',
        body: ['We will post any update here with a new version date and, for material changes, ask for your acceptance at checkout.']
      }
    ]
  },

  security: {
    title: 'Security at UgaMarket',
    version: LEGAL_VERSIONS.privacy,
    intro: 'How we keep your account, payments and data safe — and how you can help.',
    sections: [
      {
        id: 'protect',
        heading: 'How we protect you',
        body: [
          {
            list: [
              'All traffic is encrypted with HTTPS.',
              'Passwords are stored only as strong one-way hashes; verification codes are stored hashed, expire after a few minutes, allow a limited number of attempts and can only be used once.',
              'New accounts verify their phone number or email with a one-time code. Password resets and contact changes require a code too, and a password reset signs out every other device.',
              'Payments are processed by a licensed mobile money partner. UgaMarket never sees your PIN.',
              'Voice calls with our team are encrypted end-to-end between your browser and the agent and are never recorded.',
              'Sign-in and verification attempts are rate-limited and monitored for abuse.'
            ]
          }
        ]
      },
      {
        id: 'you',
        heading: 'How you can stay safe',
        body: [
          {
            list: [
              'Never share your password, verification codes or mobile money PIN — not even with someone claiming to be UgaMarket.',
              'Only approve mobile money prompts for payments you started on UgaMarket.',
              'Use a strong password that you do not use on other websites.',
              'Check the address bar shows the real UgaMarket website before signing in.',
              'If you notice anything unusual, change your password and contact us immediately.'
            ]
          }
        ]
      },
      {
        id: 'report',
        heading: 'Report a problem',
        body: ['If you believe your account or a payment was misused, or you found a security issue on our website, contact us through the Help Center. We investigate every report.']
      }
    ]
  },

  cookies: {
    title: 'Cookie Policy',
    version: LEGAL_VERSIONS.privacy,
    intro: 'Cookies and similar browser storage help UgaMarket work and remember your choices. You decide which optional categories to allow, and can change your mind at any time with "Cookie settings" in the footer.',
    sections: [
      {
        id: 'necessary',
        heading: 'Strictly necessary (always on)',
        body: [
          'Needed for the shop to work, so they cannot be switched off:',
          {
            list: [
              'ugamarket_token — keeps you signed in (browser storage).',
              'ugamarket_guest_cart — remembers your cart before you sign in (browser storage).',
              'um_consent — remembers your cookie choices (cookie, 180 days).'
            ]
          }
        ]
      },
      {
        id: 'preferences',
        heading: 'Preferences (optional)',
        body: [
          'Remember your theme (light/dark and colour), language and notification-sound setting between visits (ugamarket_theme, ugamarket_lang, ugamarket_sound). If you do not allow them, your choices still work but are forgotten when you close the tab.'
        ]
      },
      {
        id: 'analytics',
        heading: 'Analytics (optional)',
        body: ['Would help us understand how the shop is used so we can improve it. UgaMarket does not currently use any analytics cookies; if we add them, they will only load with your permission.']
      },
      {
        id: 'marketing',
        heading: 'Marketing (optional)',
        body: ['Would allow personalised offers. UgaMarket does not currently use advertising or tracking cookies; if we add them, they will only load with your permission.']
      },
      {
        id: 'third',
        heading: 'Third parties',
        body: ['"Continue with Google" loads Google Identity Services only on the sign-in page. Fonts are served by Google Fonts. Map tiles come from OpenStreetMap when you pick a delivery location.']
      }
    ]
  }
};

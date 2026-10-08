import React, { useEffect, useRef, useState } from 'react';

/**
 * Official "Continue with Google" button (Google Identity Services).
 *
 * Google renders the button itself (required by its branding rules for ID
 * token sign-in). On success it calls onCredential(idToken); the API verifies
 * that token server-side — nothing here is trusted as proof of identity.
 *
 * Without REACT_APP_GOOGLE_CLIENT_ID, or if Google's script cannot load,
 * `fallback` is rendered instead.
 */

export const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const MAX_WIDTH = 400; // Google's maximum button width

let gsiPromise = null;

/** Load Google's script once per page. */
function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('gsi')));
      script.onerror = () => {
        gsiPromise = null;
        reject(new Error('gsi'));
      };
      document.head.appendChild(script);
    });
  }
  return gsiPromise;
}

const GoogleSignInButton = ({ onCredential, locale = 'en', disabled = false, fallback = null }) => {
  const containerRef = useRef(null);
  const callbackRef = useRef(onCredential);
  const [failed, setFailed] = useState(false);

  // Keep the latest handler without re-rendering Google's button.
  useEffect(() => {
    callbackRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return undefined;
    let cancelled = false;
    loadGoogleIdentity()
      .then((gsi) => {
        if (cancelled || !containerRef.current) return;
        gsi.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            if (response?.credential) callbackRef.current?.(response.credential);
          },
          ux_mode: 'popup',
          cancel_on_tap_outside: true
        });
        const width = Math.min(MAX_WIDTH, Math.max(200, Math.floor(containerRef.current.offsetWidth || MAX_WIDTH)));
        containerRef.current.innerHTML = '';
        gsi.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width,
          locale
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [locale]);

  if (!GOOGLE_CLIENT_ID || failed) return fallback;

  return (
    <div
      ref={containerRef}
      className="auth__google-gsi"
      aria-busy={disabled}
      style={disabled ? { pointerEvents: 'none', opacity: 0.6 } : undefined}
      data-testid="google-signin"
    />
  );
};

export default GoogleSignInButton;

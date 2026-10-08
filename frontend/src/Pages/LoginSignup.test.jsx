/**
 * "Continue with Google" on the sign-in page.
 *
 * Google's own button is replaced by a stub that hands back a fake ID token;
 * the page logic (phone step, errors, redirect) is the real component.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LoginSignup from './LoginSignup';

jest.mock('../Components/GoogleSignInButton/GoogleSignInButton', () => ({
  __esModule: true,
  default: ({ onCredential }) => (
    <button type="button" onClick={() => onCredential('fake-google-id-token')}>
      Google stub
    </button>
  ),
}));

jest.mock('../Components/LanguageSwitcher/LanguageSwitcher', () => () => null);

const mockShowToast = jest.fn();
jest.mock('../Components/Toast/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

const mockGoogleSignIn = jest.fn();
jest.mock('../Context/AuthContext', () => ({
  useAuth: () => ({ login: jest.fn(), register: jest.fn(), googleSignIn: mockGoogleSignIn, isAuthenticated: false }),
}));

jest.mock('../Context/LanguageContext', () => {
  const { translate } = require('../i18n');
  return { useLanguage: () => ({ currentLang: 'en', t: (key, params) => translate('en', key, params) }) };
});

function renderPage(path = '/login') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginSignup />} />
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/checkout" element={<p>Checkout page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const clickGoogle = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Google stub' }));
  });
};

describe('LoginSignup — Continue with Google', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the Google button is offered on the sign-in tab too (returning Google users)', () => {
    renderPage('/login');
    expect(screen.getByRole('button', { name: 'Google stub' })).toBeInTheDocument();
  });

  test('a returning Google user is signed in and sent to the redirect target', async () => {
    mockGoogleSignIn.mockResolvedValue({ success: true, user: { id: 'u1' } });
    renderPage('/login?redirect=/checkout');
    await clickGoogle();
    expect(mockGoogleSignIn).toHaveBeenCalledWith('fake-google-id-token');
    expect(await screen.findByText('Checkout page')).toBeInTheDocument();
  });

  test('a new Google user is asked for a phone number, then the account is created', async () => {
    mockGoogleSignIn
      .mockResolvedValueOnce({ success: false, needsPhone: true, profile: { fullName: 'Amina N', email: 'amina@gmail.com' } })
      .mockResolvedValueOnce({ success: true, user: { id: 'u2' } });
    renderPage('/login?signup=true');
    await clickGoogle();

    expect(await screen.findByText('Welcome, Amina N!')).toBeInTheDocument();
    expect(screen.getByText('amina@gmail.com')).toBeInTheDocument();

    // Invalid phone → blocked locally, no second API call
    fireEvent.change(screen.getByLabelText(/Phone/i), { target: { value: '12' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(mockGoogleSignIn).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/Phone/i), { target: { value: '0772123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(mockGoogleSignIn).toHaveBeenLastCalledWith('fake-google-id-token', '+256772123456');
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  test('a phone number that already has an account shows a clear message and keeps the phone step', async () => {
    mockGoogleSignIn
      .mockResolvedValueOnce({ success: false, needsPhone: true, profile: { fullName: 'Amina N', email: 'a@gmail.com' } })
      .mockResolvedValueOnce({ success: false, status: 409, code: 'PHONE_IN_USE' });
    renderPage('/login?signup=true');
    await clickGoogle();
    fireEvent.change(await screen.findByLabelText(/Phone/i), { target: { value: '0772123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(await screen.findByText(/This phone number already has an account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  test('an email that belongs to a phone account is explained (never linked silently)', async () => {
    mockGoogleSignIn.mockResolvedValue({ success: false, status: 409, code: 'GOOGLE_EMAIL_IN_USE' });
    renderPage('/login');
    await clickGoogle();
    expect(await screen.findByText(/An account with this email already exists/)).toBeInTheDocument();
  });

  test('"Use a different Google account" returns to the normal form', async () => {
    mockGoogleSignIn.mockResolvedValue({ success: false, needsPhone: true, profile: { fullName: 'Amina N', email: 'a@gmail.com' } });
    renderPage('/login?signup=true');
    await clickGoogle();
    fireEvent.click(await screen.findByRole('button', { name: 'Use a different Google account' }));
    expect(screen.getByRole('button', { name: 'Google stub' })).toBeInTheDocument();
  });
});

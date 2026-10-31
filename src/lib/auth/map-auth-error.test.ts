import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapAuthError } from './map-auth-error';

const t = (key: string) => key;

afterEach(() => vi.restoreAllMocks());

describe('mapAuthError', () => {
  it('maps a signup 500 (verification email could not be sent) to its own copy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = {
      status: 500,
      code: 'unexpected_failure',
      message: 'Error sending confirmation email',
    };
    expect(mapAuthError(err, t, 'signup')).toBe('emailDeliveryUnavailable');
  });

  it('keeps the generic signup copy for a 5xx that is not an email delivery failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      mapAuthError(
        {
          status: 500,
          code: 'unexpected_failure',
          message: 'Database error saving new user',
        },
        t,
        'signup'
      )
    ).toBe('genericSignup');
    expect(mapAuthError({ status: 503 }, t, 'signup')).toBe('genericSignup');
  });

  it('keeps the generic copy for a 500 outside signup', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      mapAuthError(
        { status: 500, message: 'Error sending confirmation email' },
        t,
        'login'
      )
    ).toBe('genericLogin');
  });

  it('still prefers the specific code mapping over the 5xx rule', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      mapAuthError({ status: 500, code: 'weak_password' }, t, 'signup')
    ).toBe('weakPassword');
  });

  it('logs only code, status and a fixed reason tag, never the message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mapAuthError(
      {
        status: 500,
        code: 'unexpected_failure',
        message: 'Error sending confirmation email to x@example.com',
      },
      t,
      'signup'
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain('x@example.com');
    expect(spy).toHaveBeenCalledWith('[auth:signup]', {
      code: 'unexpected_failure',
      status: 500,
      reason: 'email_delivery',
    });
  });
});

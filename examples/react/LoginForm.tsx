import { useState, type SyntheticEvent } from 'react';
import { isValidationError } from '@atannex/bridge';
import { auth } from './bridge.js';

export function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string): string => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    setBusy(true);
    setErrors({});
    try {
      if (needsCode) {
        await auth.twoFactorChallenge({ code: field('code') });
        onSignedIn();
        return;
      }
      const result = await auth.login({ email: field('email'), password: field('password') });
      if (result.status === 'two_factor_required') setNeedsCode(true);
      else onSignedIn();
    } catch (error) {
      if (isValidationError(error)) setErrors(error.fields);
      else throw error;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      {needsCode ? (
        <input name="code" inputMode="numeric" autoComplete="one-time-code" aria-label="Authentication code" />
      ) : (
        <>
          <input name="email" type="email" autoComplete="email" aria-label="Email" />
          <input name="password" type="password" autoComplete="current-password" aria-label="Password" />
        </>
      )}
      {Object.values(errors)
        .flat()
        .map((message) => (
          <p role="alert" key={message}>
            {message}
          </p>
        ))}
      <button disabled={busy}>{needsCode ? 'Verify' : 'Sign in'}</button>
    </form>
  );
}

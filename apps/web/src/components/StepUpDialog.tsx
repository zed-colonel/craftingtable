import { type FormEvent, useEffect, useRef, useState } from 'react';
import { setStepUpPrompt } from '../lib/api-client.js';

interface Asking {
  readonly failed: boolean;
  readonly answer: (password: string | undefined) => void;
}

/**
 * The password prompt for commands that need step-up (R-G9): an unrestricted run or a final
 * promotion asks for the operator's password again, at most every 10 minutes. The signed-in app
 * mounts it once; the command is sent again once the password is accepted.
 */
export function StepUpDialog() {
  const [asking, setAsking] = useState<Asking>();
  const [password, setPassword] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setStepUpPrompt((failed) => new Promise((resolve) => setAsking({ failed, answer: resolve })));
    return () => setStepUpPrompt(undefined);
  }, []);
  useEffect(() => {
    if (asking !== undefined) field.current?.focus();
  }, [asking]);
  if (asking === undefined) return null;
  const close = (answer: string | undefined) => {
    setAsking(undefined);
    setPassword('');
    asking.answer(answer);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    close(password);
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') close(undefined);
        }}
      >
        <h2 id="step-up-title">Confirm your password</h2>
        <p>This action runs an agent without restrictions or promotes work to its target branch.</p>
        {asking.failed && (
          <p className="error-state" role="alert">
            That password did not match.
          </p>
        )}
        <form onSubmit={submit} className="login-form">
          <label>
            Password
            <input
              ref={field}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <p className="inline-actions">
            <button type="submit" className="primary-button">
              Continue
            </button>
            <button type="button" onClick={() => close(undefined)}>
              Cancel
            </button>
          </p>
        </form>
      </section>
    </div>
  );
}

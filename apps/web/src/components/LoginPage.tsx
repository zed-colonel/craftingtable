import { useState, type FormEvent } from 'react';

export function LoginPage({
  message,
  onLogin,
}: {
  message?: string;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFailure(undefined);
    try {
      await onLogin(username, password);
      setPassword('');
    } catch {
      setFailure('Sign-in failed. Check your username and password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-layout">
      <section className="login-card" aria-labelledby="login-title">
        <span className="login-mark" aria-hidden="true">
          Ct
        </span>
        <h1 id="login-title">Sign in to CraftingTable</h1>
        <p>Use the local administrator created by the bootstrap command.</p>
        {message !== undefined && (
          <p className="error-state" role="alert">
            {message}
          </p>
        )}
        {failure !== undefined && (
          <p className="error-state" role="alert">
            {failure}
          </p>
        )}
        <form onSubmit={(event) => void submit(event)} className="login-form">
          <label>
            Username
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

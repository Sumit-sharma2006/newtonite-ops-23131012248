import React, { useState } from 'react';
import { apiClient, ApiError } from '../api/client';
import { UserProfile } from '../types/api';

interface LoginPageProps {
  onLoginSuccess: (user: UserProfile) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('alice@pressuredesk.io');
  const [password, setPassword] = useState('Password123!');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);

    try {
      const data = await apiClient<{ token: string; user: UserProfile }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password })
      });

      // Prompt rule: Store ONLY the token in localStorage
      localStorage.setItem('token', data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message || 'Login failed. Please check credentials.');
      } else {
        setErrorMessage('Network error occurred. Please verify backend is running.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSelectDemoUser = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword('Password123!');
    setErrorMessage(null);
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="app-badge">PressureDesk</div>
          <h1>Operations Under Pressure</h1>
          <p className="subtitle">Sign in to manage incident, payment, and compliance operations</p>
        </div>

        {errorMessage && (
          <div className="banner banner-error" role="alert">
            <span>⚠️ {errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="form-stack">
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. alice@pressuredesk.io"
              autoComplete="username"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? 'Authenticating...' : 'Sign In'}
          </button>
        </form>

        <div className="demo-accounts">
          <p className="demo-hint-title">
            <strong>Demo Accounts</strong> (Password: <code>Password123!</code>):
          </p>
          <div className="demo-chips">
            <button
              type="button"
              className="chip"
              onClick={() => handleSelectDemoUser('alice@pressuredesk.io')}
            >
              Alice (Lead / Admin)
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => handleSelectDemoUser('bob@pressuredesk.io')}
            >
              Bob (Lead Payments / Member)
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => handleSelectDemoUser('charlie@pressuredesk.io')}
            >
              Charlie (Lead Compliance)
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => handleSelectDemoUser('ivan@pressuredesk.io')}
            >
              Ivan (Viewer)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { apiClient } from './api/client';
import { UserProfile } from './types/api';

export const App: React.FC = () => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loadingInitial, setLoadingInitial] = useState<boolean>(true);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Sync state with URL hash (#item/:id)
  useEffect(() => {
    const parseHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#item/')) {
        const id = hash.replace('#item/', '').trim();
        setSelectedItemId(id || null);
      } else {
        setSelectedItemId(null);
      }
    };

    parseHash();
    window.addEventListener('hashchange', parseHash);
    return () => window.removeEventListener('hashchange', parseHash);
  }, []);

  // Listen for 401 unauthorized events to clear session immediately
  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
      setSelectedItemId(null);
      window.location.hash = '';
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, []);

  // Restore authenticated session on mount: GET /auth/me
  // Rule: Do NOT store user or memberships in localStorage!
  useEffect(() => {
    const restoreSession = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        setLoadingInitial(false);
        return;
      }

      try {
        const res = await apiClient<{ user: UserProfile }>('/auth/me');
        setUser(res.user);
      } catch {
        // If token expired or invalid, clear it
        localStorage.removeItem('token');
        setUser(null);
      } finally {
        setLoadingInitial(false);
      }
    };

    restoreSession();
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    setUser(null);
    setSelectedItemId(null);
    window.location.hash = '';
  };

  const handleSelectItem = (id: string) => {
    setSelectedItemId(id);
    window.location.hash = `#item/${id}`;
  };

  const handleBackToDashboard = () => {
    setSelectedItemId(null);
    window.location.hash = '';
  };

  if (loadingInitial) {
    return (
      <div className="init-spinner-container">
        <div className="spinner"></div>
        <p>Connecting to PressureDesk...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLoginSuccess={(u) => setUser(u)} />;
  }

  if (selectedItemId) {
    return (
      <ItemDetailPage
        itemId={selectedItemId}
        user={user}
        onBack={handleBackToDashboard}
      />
    );
  }

  return (
    <DashboardPage
      user={user}
      onSelectItem={handleSelectItem}
      onLogout={handleLogout}
    />
  );
};

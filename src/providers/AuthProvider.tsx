import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient } from '../lib/supabaseClient';

export type KunambiUser = (User & { isDemo?: boolean }) | null;

type AuthContextValue = {
  user: KunambiUser;
  session: Session | null;
  loading: boolean;
  showAuthModal: boolean;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  signInWithEmail: (email: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  requireAuth: (callback: () => void | Promise<void>) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const supabase = getSupabaseClient();
  const [user, setUser] = useState<KunambiUser>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (!supabase) {
        setLoading(false);
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);

      const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        setSession(nextSession);
        setUser(nextSession?.user ?? null);
      });

      return () => {
        listener.subscription.unsubscribe();
      };
    };

    const cleanupPromise = init();

    return () => {
      mounted = false;
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [supabase]);

  const openAuthModal = useCallback(() => setShowAuthModal(true), []);
  const closeAuthModal = useCallback(() => setShowAuthModal(false), []);

  const signInWithEmail = useCallback(
    async (email: string) => {
      if (!supabase) {
        setUser({
          id: 'demo-user',
          email,
          app_metadata: {},
          user_metadata: { name: email.split('@')[0], isDemo: true },
          aud: 'authenticated',
          created_at: new Date().toISOString(),
          isDemo: true
        } as KunambiUser);
        closeAuthModal();
        return { error: undefined };
      }

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin + '/account'
        }
      });

      if (error) {
        return { error: error.message };
      }

      return { error: undefined };
    },
    [closeAuthModal, supabase]
  );

  const signOut = useCallback(async () => {
    if (!supabase) {
      setUser(null);
      setSession(null);
      return;
    }
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  }, [supabase]);

  const requireAuth = useCallback(
    async (callback: () => void | Promise<void>) => {
      if (user) {
        await callback();
      } else {
        openAuthModal();
      }
    },
    [openAuthModal, user]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      showAuthModal,
      openAuthModal,
      closeAuthModal,
      signInWithEmail,
      signOut,
      requireAuth
    }),
    [closeAuthModal, loading, openAuthModal, requireAuth, session, showAuthModal, signInWithEmail, signOut, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuthContext = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return context;
};

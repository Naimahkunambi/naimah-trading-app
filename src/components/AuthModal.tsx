import React, { useState } from 'react';
import { Button } from './Button';
import { useAuthContext } from '../providers/AuthProvider';

export const AuthModal: React.FC = () => {
  const { showAuthModal, closeAuthModal, signInWithEmail } = useAuthContext();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  if (!showAuthModal) return null;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('loading');
    const { error } = await signInWithEmail(email);
    if (error) {
      setStatus('error');
      setMessage(error);
    } else {
      setStatus('sent');
      setMessage('Check your email for a magic link. (Demo mode signs you in immediately.)');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 px-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <h2 className="text-2xl font-bold text-ink">Sign in to play & compete</h2>
          <p className="mt-2 text-sm text-ink/70">
            Enter your email to receive a magic link from Supabase auth.
          </p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block text-left text-sm font-semibold text-ink">
            Email address
            <input
              className="mt-2 w-full rounded-full border border-primary/30 px-4 py-2 focus:border-primary"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <Button type="submit" disabled={status === 'loading'}>
              {status === 'loading' ? 'Sending magic link…' : 'Send magic link'}
            </Button>
            <Button type="button" variant="ghost" onClick={closeAuthModal}>
              Cancel
            </Button>
          </div>
        </form>
        {message && (
          <p className="mt-4 text-sm text-ink/70" role="status">
            {message}
          </p>
        )}
      </div>
    </div>
  );
};

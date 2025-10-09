import React, { useState } from 'react';
import { EMAIL_PUBLIC, PHONE_PUBLIC, SOCIAL_FB, SOCIAL_IG, SOCIAL_LI } from '../data/siteMeta';
import { getSupabaseClient } from '../lib/supabaseClient';

export const ContactPage: React.FC = () => {
  const supabase = getSupabaseClient();
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [feedback, setFeedback] = useState('');

  const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('sending');
    try {
      if (!supabase) {
        console.info('Demo mode contact message', form);
        setStatus('sent');
        setFeedback('Message logged in demo mode. Configure Supabase to capture submissions.');
        return;
      }

      const { error } = await supabase.from('contact_messages').insert(form);
      if (error) throw error;
      setStatus('sent');
      setFeedback('Thanks! Expect a reply soon.');
      setForm({ name: '', email: '', message: '' });
    } catch (error) {
      console.error(error);
      setStatus('error');
      setFeedback((error as Error).message ?? 'Could not send message');
    }
  };

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-4xl font-bold text-ink">Contact</h1>
        <p className="text-ink/70">
          Email <a href={`mailto:${EMAIL_PUBLIC}`} className="text-primary">{EMAIL_PUBLIC}</a> or call{' '}
          <a href={`tel:${PHONE_PUBLIC}`} className="text-primary">
            {PHONE_PUBLIC}
          </a>
          .
        </p>
      </header>

      <form className="space-y-4 rounded-3xl bg-white p-6 shadow-md" onSubmit={onSubmit}>
        <div>
          <label className="block text-sm font-semibold text-ink">
            Name
            <input
              className="mt-2 w-full rounded-full border border-primary/20 px-4 py-2 focus:border-primary"
              name="name"
              value={form.name}
              onChange={onChange}
              required
            />
          </label>
        </div>
        <div>
          <label className="block text-sm font-semibold text-ink">
            Email
            <input
              type="email"
              className="mt-2 w-full rounded-full border border-primary/20 px-4 py-2 focus:border-primary"
              name="email"
              value={form.email}
              onChange={onChange}
              required
            />
          </label>
        </div>
        <div>
          <label className="block text-sm font-semibold text-ink">
            Message
            <textarea
              className="mt-2 h-32 w-full rounded-3xl border border-primary/20 px-4 py-3 text-sm focus:border-primary"
              name="message"
              value={form.message}
              onChange={onChange}
              required
            />
          </label>
        </div>
        <button
          type="submit"
          className="rounded-full bg-primary px-5 py-2 font-semibold text-white"
          disabled={status === 'sending'}
        >
          {status === 'sending' ? 'Sending…' : 'Send message'}
        </button>
        {feedback && <p className="text-sm text-primary">{feedback}</p>}
      </form>

      <div className="rounded-3xl bg-white p-6 text-sm text-ink/70 shadow-md">
        <p>Connect on social:</p>
        <ul className="mt-3 space-y-2">
          <li>
            <a href={SOCIAL_IG} className="text-primary" target="_blank" rel="noreferrer">
              Instagram
            </a>
          </li>
          <li>
            <a href={SOCIAL_FB} className="text-primary" target="_blank" rel="noreferrer">
              Facebook
            </a>
          </li>
          <li>
            <a href={SOCIAL_LI} className="text-primary" target="_blank" rel="noreferrer">
              LinkedIn
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
};

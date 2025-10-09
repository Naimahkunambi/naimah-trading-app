import React, { useState } from 'react';
import { Button } from '../components/Button';
import { useAuthContext } from '../providers/AuthProvider';
import { getSupabaseClient } from '../lib/supabaseClient';

const ebookOptions = [
  { value: 'ebook_canva', label: 'Canva Mastery for Real Estate Professionals' },
  { value: 'ebook_zanzibar', label: 'Zanzibar Investment Starter Guide' },
  { value: 'ebook_sales30', label: '30 Sales Systems in 30 Days' },
  { value: 'ebook_ai_prompts', label: 'AI Prompts for Busy Brokers' }
];

export const EbooksPage: React.FC = () => {
  const { user, requireAuth } = useAuthContext();
  const supabase = getSupabaseClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [customRequest, setCustomRequest] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const toggleOption = (value: string) => {
    setSelected((prev) => (prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await requireAuth(async () => {
      setStatus('submitting');
      try {
        if (!supabase) {
          console.info('Demo mode: ebook request stored locally', { selected, customRequest });
          setStatus('success');
          setMessage('Request captured in demo mode. Connect Supabase to store real submissions.');
          return;
        }

        const { error } = await supabase.from('ebook_requests').insert({
          user_id: user?.id ?? null,
          requested_titles: selected,
          custom_request: customRequest
        });

        if (error) throw error;

        setStatus('success');
        setMessage('Request submitted! Check your email for follow-up.');
      } catch (error) {
        console.error(error);
        setStatus('error');
        setMessage((error as Error).message ?? 'Unable to submit request');
      }
    });
  };

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-4xl font-bold text-ink">Request an Ebook</h1>
        <p className="max-w-2xl text-ink/70">
          Request an ebook or ask for a custom one. I’ll reply with delivery and options.
        </p>
      </header>

      <form className="space-y-6 rounded-3xl bg-white p-6 shadow-md" onSubmit={submit}>
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold uppercase tracking-widest text-ink/60">Available titles</legend>
          {ebookOptions.map((option) => (
            <label key={option.value} className="flex items-center gap-3 text-sm text-ink/80">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-primary/40"
                checked={selected.includes(option.value)}
                onChange={() => toggleOption(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        <div>
          <label className="block text-sm font-semibold text-ink">
            Custom request
            <textarea
              className="mt-2 h-32 w-full rounded-3xl border border-primary/20 px-4 py-3 text-sm focus:border-primary"
              value={customRequest}
              onChange={(event) => setCustomRequest(event.target.value)}
              placeholder="Describe the ebook or problem you want solved."
            />
          </label>
        </div>

        <Button type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Sending…' : 'Submit request'}
        </Button>
        {message && <p className="text-sm text-primary">{message}</p>}
      </form>

      <div className="rounded-3xl bg-white p-6 text-sm text-ink/70 shadow-md">
        Prefer email? Send a note to <a href="mailto:naimah@coldwellbanker.tz">naimah@coldwellbanker.tz</a>.
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { Button } from '../components/Button';
import { useAuthContext } from '../providers/AuthProvider';
import { getSupabaseClient } from '../lib/supabaseClient';

const tiers = [
  {
    sku: 'learn_starter',
    title: 'Starter',
    price: '$149',
    summary: 'One focused brief delivered in 72 hours.',
    bullets: ['30-minute kickoff call', 'Action plan with 5 concrete steps', 'Follow-up checklist']
  },
  {
    sku: 'learn_pro',
    title: 'Pro',
    price: '$399',
    summary: 'Deep dive with research, templates, and follow-up support.',
    bullets: ['Strategy blueprint', 'Template toolkit', 'Two weeks async support']
  },
  {
    sku: 'learn_vip',
    title: 'VIP',
    price: '$899',
    summary: 'Hands-on sprint. We co-build and implement together.',
    bullets: ['Dedicated Slack channel', 'Working sessions each week', 'Implementation QA + review']
  }
];

export const LearnPage: React.FC = () => {
  const { requireAuth } = useAuthContext();
  const supabase = getSupabaseClient();
  const [message, setMessage] = useState('');
  const [loadingSku, setLoadingSku] = useState<string | null>(null);

  const handleCheckout = async (sku: string) => {
    await requireAuth(async () => {
      setLoadingSku(sku);
      setMessage('');
      try {
        if (!supabase) {
          setMessage('Demo mode: configure Supabase + Stripe to enable checkout.');
          return;
        }

        const { data, error } = await supabase.functions.invoke('create-checkout-session', {
          body: { sku, successUrl: window.location.origin + '/account?status=success' }
        });

        if (error) throw error;
        const url = data?.url;
        if (url) {
          window.location.href = url;
        } else {
          setMessage('No checkout URL returned. Check your Edge Function.');
        }
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? 'Unable to start checkout.');
      } finally {
        setLoadingSku(null);
      }
    });
  };

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <h1 className="text-4xl font-bold text-ink">Learn Anything — Simplified</h1>
        <p className="max-w-2xl text-ink/70">
          Turn a messy topic into a clear plan. I translate complexity into steps you can act on today.
        </p>
      </header>

      <section className="grid gap-6 md:grid-cols-3">
        {tiers.map((tier) => (
          <div key={tier.sku} className="flex h-full flex-col justify-between rounded-3xl border border-primary/10 bg-white p-6 shadow-md">
            <div className="space-y-3">
              <h2 className="text-2xl font-bold text-ink">{tier.title}</h2>
              <p className="text-xl font-semibold text-primary">{tier.price}</p>
              <p className="text-sm text-ink/70">{tier.summary}</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink/70">
                {tier.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            </div>
            <Button onClick={() => void handleCheckout(tier.sku)} disabled={loadingSku === tier.sku}>
              {loadingSku === tier.sku ? 'Preparing checkout…' : 'Pay with Stripe'}
            </Button>
          </div>
        ))}
      </section>

      {message && <p className="rounded-3xl bg-white p-4 text-sm text-primary">{message}</p>}
    </div>
  );
};

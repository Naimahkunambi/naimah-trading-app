// Supabase Edge Function: Stripe webhook handler
// Deploy with `supabase functions deploy stripe-webhook`

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.24.0?target=deno';

const STRIPE_SECRET = Deno.env.get('STRIPE_SK');
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');

if (!STRIPE_SECRET || !STRIPE_WEBHOOK_SECRET) {
  console.error('Stripe secrets missing');
}

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { apiVersion: '2023-10-16' }) : null;

serve(async (req) => {
  if (!stripe) {
    return new Response('Stripe not configured', { status: 400 });
  }

  const signature = req.headers.get('stripe-signature') ?? '';
  const body = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error('Webhook signature verification failed', err);
    return new Response('Invalid signature', { status: 400 });
  }

  const supabase = await import('https://esm.sh/@supabase/supabase-js@2.48.0');
  const client = supabase.createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await client
        .from('orders')
        .update({ status: 'paid', stripe_payment_intent: session.payment_intent?.toString() ?? null })
        .eq('stripe_session_id', session.id);
      break;
    }
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      await client.from('orders').update({ status: 'failed' }).eq('stripe_session_id', session.id);
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

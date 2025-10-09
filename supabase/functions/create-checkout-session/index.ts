// Supabase Edge Function: create Stripe Checkout session
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.24.0?target=deno';
import { corsHeaders } from '../_shared/cors.ts';

const STRIPE_SECRET = Deno.env.get('STRIPE_SK');

const products: Record<string, { price: number; name: string }> = {
  learn_starter: { price: 14900, name: 'Learn Anything — Starter' },
  learn_pro: { price: 39900, name: 'Learn Anything — Pro' },
  learn_vip: { price: 89900, name: 'Learn Anything — VIP' },
  ebook_canva: { price: 2900, name: 'Canva Mastery Ebook' },
  ebook_zanzibar: { price: 3900, name: 'Zanzibar Investment Starter Guide' },
  ebook_sales30: { price: 3400, name: '30 Sales Systems in 30 Days' },
  ebook_ai_prompts: { price: 2900, name: 'AI Prompts for Busy Brokers' }
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!STRIPE_SECRET) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), { status: 500, headers: corsHeaders });
  }

  const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2023-10-16' });
  const supabase = await import('https://esm.sh/@supabase/supabase-js@2.48.0');
  const client = supabase.createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const body = await req.json();
  const sku = body.sku as string;
  const successUrl = body.successUrl as string;
  const cancelUrl = body.cancelUrl as string ?? new URL(req.url).origin + '/learn';
  const userId = body.userId as string | null;

  const product = products[sku];
  if (!product) {
    return new Response(JSON.stringify({ error: 'Unknown SKU' }), { status: 400, headers: corsHeaders });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: product.name },
          unit_amount: product.price
        },
        quantity: 1
      }
    ],
    metadata: { sku, userId: userId ?? '' }
  });

  await client.from('orders').insert({
    user_id: userId,
    product_sku: sku,
    amount_cents: product.price,
    stripe_session_id: session.id
  });

  return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: corsHeaders });
});

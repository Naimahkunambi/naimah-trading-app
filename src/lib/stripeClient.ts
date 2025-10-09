import { loadStripe, Stripe } from '@stripe/stripe-js';

let stripePromise: Promise<Stripe | null> | null = null;

export const getStripe = () => {
  if (!stripePromise) {
    const pk = import.meta.env.VITE_STRIPE_PK as string | undefined;
    if (!pk) {
      stripePromise = Promise.resolve(null);
    } else {
      stripePromise = loadStripe(pk);
    }
  }

  return stripePromise;
};

import React, { useEffect, useState } from 'react';
import { useAuthContext } from '../providers/AuthProvider';
import { getSupabaseClient } from '../lib/supabaseClient';

export const AccountPage: React.FC = () => {
  const { user, openAuthModal, signOut } = useAuthContext();
  const supabase = getSupabaseClient();
  const [orders, setOrders] = useState<any[]>([]);
  const [stats, setStats] = useState<{ totalGames: number; bestScore: number } | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!user || !supabase) return;
      const [{ data: ordersData }, { data: bestScoreData }, { count }] = await Promise.all([
        supabase.from('orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
        supabase
          .from('scores')
          .select('score')
          .eq('user_id', user.id)
          .order('score', { ascending: false })
          .limit(1),
        supabase.from('scores').select('*', { count: 'exact', head: true }).eq('user_id', user.id)
      ]);
      setOrders(ordersData ?? []);
      setStats({ totalGames: count ?? 0, bestScore: bestScoreData?.[0]?.score ?? 0 });
    };
    void load();
  }, [supabase, user]);

  if (!user) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-ink">Account</h1>
        <p className="text-ink/70">Sign in to see your profile, orders, and game stats.</p>
        <button onClick={openAuthModal} className="rounded-full bg-primary px-5 py-2 font-semibold text-white">
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-ink">Welcome back, {user.user_metadata?.name ?? user.email}</h1>
          <p className="text-sm text-ink/60">{user.email}</p>
        </div>
        <button onClick={() => void signOut()} className="rounded-full border border-primary px-5 py-2 text-sm font-semibold text-primary">
          Sign out
        </button>
      </header>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-3xl bg-white p-6 shadow-md">
          <h2 className="text-xl font-bold text-ink">Game stats</h2>
          {stats ? (
            <ul className="mt-4 space-y-2 text-sm text-ink/70">
              <li>Total games played: {stats.totalGames}</li>
              <li>Best recorded score: {stats.bestScore}</li>
            </ul>
          ) : (
            <p className="mt-4 text-sm text-ink/70">
              Connect Supabase to surface live stats. Demo mode hides this section.
            </p>
          )}
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-md">
          <h2 className="text-xl font-bold text-ink">Orders</h2>
          {orders.length > 0 ? (
            <ul className="mt-4 space-y-3 text-sm text-ink/70">
              {orders.map((order) => (
                <li key={order.id} className="rounded-2xl border border-primary/10 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{order.product_sku}</span>
                    <span className="text-xs uppercase text-ink/50">{order.status}</span>
                  </div>
                  <p className="text-xs text-ink/50">Paid ${(order.amount_cents / 100).toFixed(2)} {order.currency?.toUpperCase()}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-ink/70">
              No orders yet. Book a “Learn Anything” session or request a paid ebook to see details here.
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

import { useQuery } from '@tanstack/react-query';
import { getSupabaseClient } from '../lib/supabaseClient';

export type LeaderboardEntry = {
  id: number;
  display_name: string | null;
  identifier: string | null;
  score: number;
  created_at: string;
};

export const useLeaderboard = (gameId: number | null, range: 'weekly' | 'alltime') => {
  const supabase = getSupabaseClient();

  return useQuery({
    queryKey: ['leaderboard', gameId, range],
    enabled: Boolean(gameId),
    queryFn: async (): Promise<LeaderboardEntry[]> => {
      if (!supabase || !gameId) {
        return [];
      }

      let query = supabase
        .from('scores')
        .select('id, score, created_at, user_id, profiles(display_name)')
        .eq('game_id', gameId)
        .order('score', { ascending: false })
        .limit(50);

      if (range === 'weekly') {
        const since = new Date();
        since.setDate(since.getDate() - 7);
        query = query.gte('created_at', since.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        console.error(error);
        return [];
      }

      return (data ?? []).map((row: any) => ({
        id: row.id,
        score: row.score,
        created_at: row.created_at,
        display_name: row.profiles?.display_name ?? null,
        identifier: row.user_id ?? null
      }));
    },
    staleTime: 1000 * 60
  });
};

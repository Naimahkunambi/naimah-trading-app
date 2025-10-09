import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient } from '../lib/supabaseClient';
import { useAuthContext } from '../providers/AuthProvider';

export const useScoreSubmission = (gameId: number | null) => {
  const supabase = getSupabaseClient();
  const { user, openAuthModal } = useAuthContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ['submit-score', gameId],
    mutationFn: async (score: number) => {
      if (!user) {
        openAuthModal();
        throw new Error('Please sign in to submit scores');
      }

      if (!supabase || !gameId) {
        console.info('Demo mode: score stored locally', { score, gameId });
        return { demo: true };
      }

      const { error } = await supabase.from('scores').insert({
        user_id: user.id,
        game_id: gameId,
        score
      });

      if (error) {
        throw error;
      }

      await queryClient.invalidateQueries({ queryKey: ['leaderboard', gameId] });
      return { demo: false };
    }
  });
};

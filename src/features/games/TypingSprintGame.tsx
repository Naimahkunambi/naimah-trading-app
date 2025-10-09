import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';

type Prompt = {
  id: number;
  phrase: string;
};

const prompts: Prompt[] = [
  { id: 1, phrase: 'Radically honest Zanzibar follow-up' },
  { id: 2, phrase: 'Sales pipeline clarity in 24 hours' },
  { id: 3, phrase: 'Property tour scheduled and confirmed' },
  { id: 4, phrase: 'AI-assisted pricing model locked in' },
  { id: 5, phrase: 'Client onboarding playbook delivered' },
  { id: 6, phrase: 'Negotiation strategy ready for Monday' }
];

const ROUND_TIME = 30; // seconds

export const TypingSprintGame: React.FC<{ onFinish?: (score: number) => void }> = ({ onFinish }) => {
  const deck = useMemo(() => [...prompts].sort(() => Math.random() - 0.5).slice(0, 4), []);
  const [activeIndex, setActiveIndex] = useState(0);
  const [input, setInput] = useState('');
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [score, setScore] = useState(0);
  const [completed, setCompleted] = useState(false);

  const activePrompt = deck[activeIndex];

  useEffect(() => {
    if (completed) return;
    const interval = window.setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          handleSubmit();
          return ROUND_TIME;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed, activeIndex]);

  const handleSubmit = () => {
    if (!activePrompt) {
      setCompleted(true);
      onFinish?.(score);
      return;
    }

    const accuracy = input.trim() === activePrompt.phrase ? 1 : 0;
    const delta = accuracy ? 150 + timeLeft * 2 : Math.max(0, 50 - (ROUND_TIME - timeLeft) * 3);
    const nextScore = score + delta;
    const nextIndex = activeIndex + 1;

    setScore(nextScore);
    setInput('');
    setTimeLeft(ROUND_TIME);

    if (nextIndex >= deck.length) {
      setCompleted(true);
      onFinish?.(nextScore);
    } else {
      setActiveIndex(nextIndex);
    }
  };

  const restart = () => window.location.reload();

  if (completed) {
    return (
      <div className="space-y-4 rounded-3xl bg-white p-6 shadow-lg">
        <h3 className="text-2xl font-bold text-ink">Sprint complete!</h3>
        <p className="text-primary text-xl font-semibold">Score: {score}</p>
        <p className="text-sm text-ink/70">Practice again tomorrow and chase the weekly leaderboard.</p>
        <Button onClick={restart}>Run it back</Button>
      </div>
    );
  }

  if (!activePrompt) return null;

  return (
    <div className="space-y-4 rounded-3xl bg-white p-6 shadow-lg">
      <div className="flex items-center justify-between text-sm text-ink/70">
        <span>
          Phrase {activeIndex + 1} / {deck.length}
        </span>
        <span className="font-semibold text-primary">{timeLeft}s</span>
      </div>
      <p className="text-lg font-semibold text-ink">{activePrompt.phrase}</p>
      <textarea
        className="h-28 w-full rounded-2xl border border-primary/20 px-4 py-3 text-sm focus:border-primary"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        placeholder="Type the phrase exactly as shown"
      />
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink/60">Score: {score}</p>
        <Button onClick={handleSubmit}>Submit</Button>
      </div>
    </div>
  );
};

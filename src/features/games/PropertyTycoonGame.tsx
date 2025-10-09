import React, { useMemo, useState } from 'react';
import { Button } from '../../components/Button';

type Decision = 'buy' | 'hold' | 'pass';

type PropertyCard = {
  id: number;
  name: string;
  location: string;
  askingPrice: number;
  trend: 'rising' | 'flat' | 'falling';
  riskNote: string;
  bestMove: Decision;
};

const propertyDeck: PropertyCard[] = [
  {
    id: 1,
    name: 'Stone Town Heritage Loft',
    location: 'Stone Town',
    askingPrice: 180000,
    trend: 'rising',
    riskNote: 'Tourism-backed rentals with 80% occupancy. Heritage permits approved.',
    bestMove: 'buy'
  },
  {
    id: 2,
    name: 'Matemwe Beachfront Fixer',
    location: 'Matemwe',
    askingPrice: 240000,
    trend: 'flat',
    riskNote: 'Storm surge repairs pending. Contractor quotes delayed.',
    bestMove: 'hold'
  },
  {
    id: 3,
    name: 'Fumba Smart Home Cluster',
    location: 'Fumba',
    askingPrice: 150000,
    trend: 'rising',
    riskNote: 'High demand from hybrid workers. Fiber rollout complete.',
    bestMove: 'buy'
  },
  {
    id: 4,
    name: 'Jambiani Artist Retreat',
    location: 'Jambiani',
    askingPrice: 130000,
    trend: 'falling',
    riskNote: 'Creative scene still emerging; anchor tenant undecided.',
    bestMove: 'pass'
  }
];

export const PropertyTycoonGame: React.FC<{ onFinish?: (score: number) => void }> = ({ onFinish }) => {
  const deck = useMemo(() => [...propertyDeck].sort(() => Math.random() - 0.5).slice(0, 3), []);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [history, setHistory] = useState<{ property: PropertyCard; decision: Decision; result: number }[]>([]);
  const [completed, setCompleted] = useState(false);

  const currentCard = deck[index];

  const handleDecision = (decision: Decision) => {
    const card = deck[index];
    const result = decision === card.bestMove ? 120 : decision === 'hold' ? 40 : -60;
    const newScore = score + result;
    setHistory((prev) => [...prev, { property: card, decision, result }]);
    setScore(newScore);
    if (index === deck.length - 1) {
      setCompleted(true);
      onFinish?.(newScore);
    } else {
      setIndex((prev) => prev + 1);
    }
  };

  const restart = () => {
    window.location.reload();
  };

  if (completed) {
    return (
      <div className="space-y-6 rounded-3xl bg-white/90 p-6 shadow-lg">
        <h3 className="text-2xl font-bold text-ink">Deal sprint complete!</h3>
        <p className="text-ink/70">You closed {history.filter((item) => item.result > 0).length} winning moves.</p>
        <p className="text-xl font-semibold text-primary">Score: {score}</p>
        <ul className="space-y-3 text-sm text-ink/80">
          {history.map((item) => (
            <li key={item.property.id} className="rounded-2xl border border-primary/20 p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{item.property.name}</span>
                <span className="text-xs uppercase tracking-widest text-ink/60">{item.decision.toUpperCase()}</span>
              </div>
              <p className="mt-1 text-xs text-ink/60">{item.result >= 0 ? 'Great call!' : 'Rework your thesis next time.'}</p>
            </li>
          ))}
        </ul>
        <Button onClick={restart}>Play again</Button>
      </div>
    );
  }

  if (!currentCard) {
    return null;
  }

  return (
    <div className="space-y-6 rounded-3xl bg-white/95 p-6 shadow-lg">
      <div>
        <h3 className="text-sm uppercase tracking-widest text-ink/60">Round {index + 1} of {deck.length}</h3>
        <h2 className="mt-2 text-2xl font-bold text-ink">{currentCard.name}</h2>
        <p className="text-sm text-ink/60">{currentCard.location}</p>
      </div>
      <div className="rounded-2xl bg-surface p-4 text-sm text-ink/80">
        <p><strong>Asking price:</strong> ${currentCard.askingPrice.toLocaleString()}</p>
        <p><strong>Market trend:</strong> {currentCard.trend}</p>
        <p className="mt-2 leading-relaxed">{currentCard.riskNote}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => handleDecision('buy')}>Buy</Button>
        <Button variant="secondary" onClick={() => handleDecision('hold')}>
          Hold & watch
        </Button>
        <Button variant="ghost" onClick={() => handleDecision('pass')}>
          Pass
        </Button>
      </div>
      <p className="text-sm text-ink/60">Score: {score}</p>
    </div>
  );
};

import React from 'react';

export const LogoBadge: React.FC<{ size?: 'sm' | 'md' | 'lg' }> = ({ size = 'md' }) => {
  const dimension = size === 'lg' ? 64 : size === 'sm' ? 32 : 48;
  const textSize = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-lg';

  return (
    <div
      className={`inline-flex items-center gap-3 rounded-full bg-primary/10 px-3 py-1 text-primary ${textSize}`}
      aria-label="Just Another Kunambi logo"
    >
      <span
        className="flex items-center justify-center rounded-xl bg-primary font-semibold text-white"
        style={{ width: dimension, height: dimension }}
      >
        NK
      </span>
      <span className="font-semibold uppercase tracking-widest">Just Another Kunambi</span>
    </div>
  );
};

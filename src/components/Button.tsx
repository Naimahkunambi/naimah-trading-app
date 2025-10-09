import React from 'react';
import { clsx } from 'clsx';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
};

export const Button: React.FC<ButtonProps> = ({ variant = 'primary', className, children, ...rest }) => {
  const base =
    'rounded-full px-5 py-2 font-semibold transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';
  const styles = {
    primary: 'bg-primary text-white hover:bg-primary/90 shadow-sm',
    secondary: 'border border-primary text-primary hover:bg-primary/10',
    ghost: 'text-primary hover:bg-primary/10'
  };

  return (
    <button className={clsx(base, styles[variant], className)} {...rest}>
      {children}
    </button>
  );
};

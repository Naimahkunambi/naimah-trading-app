import React from 'react';
import { NavLink } from 'react-router-dom';
import { Button } from './Button';
import { LogoBadge } from './LogoBadge';
import { useAuthContext } from '../providers/AuthProvider';

const navLinks = [
  { to: '/about', label: 'Bio' },
  { to: '/blog', label: 'Blog' },
  { to: '/games', label: 'Games' },
  { to: '/ebooks', label: 'Ebooks' },
  { to: '/learn', label: 'Learn' },
  { to: '/leaderboards', label: 'Leaderboards' },
  { to: '/contact', label: 'Contact' }
];

export const Header: React.FC = () => {
  const { user, openAuthModal, signOut } = useAuthContext();

  return (
    <header className="sticky top-0 z-50 border-b border-primary/20 bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
        <NavLink to="/" className="shrink-0">
          <LogoBadge size="sm" />
        </NavLink>
        <nav className="hidden items-center gap-6 text-sm font-semibold md:flex">
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `transition-colors hover:text-primary ${isActive ? 'text-primary' : 'text-ink/80'}`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <NavLink to="/account" className="hidden text-sm font-semibold text-ink/80 hover:text-primary md:block">
                {user.email}
              </NavLink>
              <Button variant="ghost" onClick={() => void signOut()}>
                Sign out
              </Button>
            </>
          ) : (
            <Button onClick={openAuthModal}>Sign in</Button>
          )}
        </div>
      </div>
    </header>
  );
};

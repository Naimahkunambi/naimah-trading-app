import React from 'react';
import { NavLink } from 'react-router-dom';

export const Footer: React.FC = () => {
  return (
    <footer className="mt-16 border-t border-primary/10 bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-ink/70 md:flex-row md:items-center md:justify-between">
        <p>
          © {new Date().getFullYear()} Just Another Kunambi · Crafted by Naimah Kunambi.
        </p>
        <nav className="flex flex-wrap items-center gap-4">
          <NavLink to="/legal" className="hover:text-primary">
            Terms & Privacy
          </NavLink>
          <NavLink to="/contact" className="hover:text-primary">
            Contact
          </NavLink>
          <a href="https://github.com/GITHUB_USERNAME/justanotherkunambi-site" className="hover:text-primary">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
};

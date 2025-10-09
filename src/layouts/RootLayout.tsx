import React from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { AuthModal } from '../components/AuthModal';

export const RootLayout: React.FC = () => {
  return (
    <div className="flex min-h-screen flex-col bg-surface text-ink">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        <Outlet />
      </main>
      <Footer />
      <AuthModal />
    </div>
  );
};

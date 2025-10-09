import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { RootLayout } from './layouts/RootLayout';
import { HomePage } from './pages/HomePage';
import { AboutPage } from './pages/AboutPage';
import { BlogIndexPage } from './pages/BlogIndexPage';
import { BlogPostPage } from './pages/BlogPostPage';
import { GamesPage } from './pages/GamesPage';
import { GameDetailPage } from './pages/GameDetailPage';
import { EbooksPage } from './pages/EbooksPage';
import { LearnPage } from './pages/LearnPage';
import { AccountPage } from './pages/AccountPage';
import { LeaderboardsPage } from './pages/LeaderboardsPage';
import { ContactPage } from './pages/ContactPage';
import { LegalPage } from './pages/LegalPage';
import { NotFoundPage } from './pages/NotFoundPage';

const App: React.FC = () => {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<HomePage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="blog" element={<BlogIndexPage />} />
        <Route path="blog/:slug" element={<BlogPostPage />} />
        <Route path="games" element={<GamesPage />} />
        <Route path="games/:slug" element={<GameDetailPage />} />
        <Route path="ebooks" element={<EbooksPage />} />
        <Route path="learn" element={<LearnPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="leaderboards" element={<LeaderboardsPage />} />
        <Route path="contact" element={<ContactPage />} />
        <Route path="legal" element={<LegalPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
};

export default App;

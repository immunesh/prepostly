import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { AppProvider, useApp } from './lib/app.jsx';
import { Loading } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Landing from './pages/Landing.jsx';
import { Login, Signup } from './pages/Auth.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Create from './pages/Create.jsx';
import Library from './pages/Library.jsx';
import PostView from './pages/PostView.jsx';
import Calendar from './pages/Calendar.jsx';
import Ideas from './pages/Ideas.jsx';
import Competitors from './pages/Competitors.jsx';
import AdIntel from './pages/AdIntel.jsx';
import AdsStudio from './pages/AdsStudio.jsx';
import Autopilot from './pages/Autopilot.jsx';
import Brand from './pages/Brand.jsx';
import Team from './pages/Team.jsx';
import Account from './pages/Account.jsx';
import Share from './pages/Share.jsx';
import { Privacy, Terms, DataDeletion } from './pages/Legal.jsx';

function RequireAuth({ children }) {
  const { me } = useApp();
  const loc = useLocation();
  if (me === undefined) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.brand && loc.pathname !== '/app/onboarding') return <Navigate to="/app/onboarding" replace />;
  return children;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/s/:shareId" element={<Share />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/data-deletion" element={<DataDeletion />} />
      <Route path="/app/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
      <Route path="/app" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/app/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="create" element={<Create />} />
        <Route path="library" element={<Library />} />
        <Route path="posts/:id" element={<PostView />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="ideas" element={<Ideas />} />
        <Route path="competitors" element={<Competitors />} />
        <Route path="ad-intelligence" element={<AdIntel />} />
        <Route path="ads-studio" element={<AdsStudio />} />
        <Route path="autoposting" element={<Autopilot />} />
        <Route path="autoposting/review" element={<Autopilot review />} />
        <Route path="brand" element={<Brand />} />
        <Route path="team" element={<Team />} />
        <Route path="account" element={<Account />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);

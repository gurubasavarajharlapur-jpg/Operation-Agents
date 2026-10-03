import { createBrowserRouter, Navigate, NavLink, Link, Outlet, RouterProvider } from 'react-router';
import { useAuth } from './auth.tsx';
import { useApi } from './useApi.ts';
import { ChainStatus } from './components/ChainStatus.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { CaseDetailPage } from './pages/CaseDetailPage.tsx';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import type { Stats } from './types.ts';
import { useDemo } from './demo.ts';

function Layout() {
  const { operator, checking, signOut } = useAuth();
  const { data: stats } = useApi<Stats>(operator ? '/stats' : null, 5000);
  const demo = useDemo();

  if (checking) return null;
  if (!operator) return <SignIn />;

  return (
    <>
      <header className="topbar">
        <Link to="/overview" className="brand"><span className="brand-mark">OA</span>Operation Agents</Link>
        <nav className="nav">
          <NavLink to="/overview">Overview</NavLink>
          <NavLink to="/cases" end>Cases</NavLink>
          <NavLink to="/approvals">
            Approvals {stats && stats.pending_approvals > 0 && <span className="count" data-testid="pending-count">{stats.pending_approvals}</span>}
          </NavLink>
        </nav>
        <div className="topbar-right">
          <ChainStatus />
          <div className="menu">
            <span className="avatar">{operator.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}</span>
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ fontWeight: 550 }}>{operator.name}</div>
              <div className="faint" style={{ fontSize: 12 }}>{operator.role === 'finance_manager' ? 'Finance manager' : 'Operations'}</div>
            </div>
            <button className="btn ghost" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>
      {demo?.enabled && (
        <div className="demo-banner" data-testid="demo-banner">
          Public demo · sample invoices · <strong>payments are simulated</strong> ·{' '}
          {demo.agent_mode === 'llm' ? 'decisions by the Claude agent' : 'decisions by the rules-only engine (no LLM in this deployment)'}
        </div>
      )}
      <Outlet />
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Navigate to="/overview" replace /> },
      { path: '/overview', element: <OverviewPage /> },
      { path: '/cases', element: <CasesPage /> },
      { path: '/cases/:id', element: <CaseDetailPage /> },
      { path: '/approvals', element: <ApprovalsPage /> },
      { path: '*', element: <Navigate to="/overview" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}

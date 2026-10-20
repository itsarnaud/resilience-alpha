import { Navigate, Route, Routes } from 'react-router';
import Layout from './components/Layout';
import Protected from './components/Protected';
import AccountsPage from './pages/AccountsPage';
import BeneficiariesPage from './pages/BeneficiariesPage';
import HistoryPage from './pages/HistoryPage';
import LoginPage from './pages/LoginPage';
import TransferPage from './pages/TransferPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected />}>
        <Route element={<Layout />}>
          <Route index element={<AccountsPage />} />
          <Route path="virement" element={<TransferPage />} />
          <Route path="beneficiaires" element={<BeneficiariesPage />} />
          <Route path="historique" element={<HistoryPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

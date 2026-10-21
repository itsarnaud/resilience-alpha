import { Navigate, Route, Routes } from 'react-router';
import Layout from './components/Layout';
import Protected from './components/Protected';
import LoginPage from './pages/LoginPage';
import UsersPage from './pages/UsersPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected />}>
        <Route element={<Layout />}>
          <Route index element={<UsersPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

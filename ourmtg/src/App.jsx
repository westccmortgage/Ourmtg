import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { LangProvider } from './lib/i18n'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import Home from './pages/Home'
import Login from './pages/Login'
import Apply from './pages/Apply'
import LeadFlow from './pages/LeadFlow'
import Calculator from './pages/Calculator'
import BuildFile from './pages/BuildFile'
import WhoDoesWhat from './pages/WhoDoesWhat'
import { FLOWS } from './lib/leadFlows'
import RealtorLanding from './pages/RealtorLanding'
import Invite from './pages/Invite'
import Legal from './pages/Legal'
import Portal from './pages/Portal'
import Documents from './pages/Documents'
import LoanFileDetail from './pages/LoanFileDetail'
import NewLoanFile from './pages/NewLoanFile'

function NotFound() {
  return (
    <div className="center" style={{ padding: '48px 0' }}>
      <h1>Page not found</h1>
      <Link to="/" className="btn btn-ghost">Back to home</Link>
    </div>
  )
}

export default function App() {
  return (
    <LangProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="login" element={<Login />} />
            <Route path="apply" element={<Apply />} />
            <Route path="realtor" element={<RealtorLanding />} />
            <Route path="calculator" element={<Calculator />} />
            <Route path="plan" element={<BuildFile />} />
            <Route path="who" element={<WhoDoesWhat />} />
            {Object.values(FLOWS).map((flow) => (
              <Route key={flow.path} path={flow.path.slice(1)} element={<LeadFlow flow={flow} />} />
            ))}
            <Route path="invite" element={<Invite />} />
            <Route path="legal/:doc" element={<Legal />} />
            <Route path="portal" element={<RequireAuth><Portal /></RequireAuth>} />
            <Route path="portal/documents/:loanFileId" element={<RequireAuth><Documents /></RequireAuth>} />
            <Route path="portal/file/:loanFileId" element={<RequireAuth><LoanFileDetail /></RequireAuth>} />
            <Route path="portal/new-file" element={<RequireAuth><NewLoanFile /></RequireAuth>} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </LangProvider>
  )
}

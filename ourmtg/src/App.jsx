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
import ApplicationAssistant from './features/conversational-1003/pages/ApplicationAssistant'
import ApplicationTeamReview from './features/conversational-1003/pages/ApplicationTeamReview'
import ShortLink1003 from './pages/ShortLink1003'
import ApplicationEntry from './pages/ApplicationEntry'
import PreUnderwritingPanel from './features/pre-underwriting/pages/PreUnderwritingPanel'
import { conversational1003Enabled } from './features/conversational-1003/clientFlag'
import { preUnderwritingEnabled } from './features/pre-underwriting/clientFlag'

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
            {/* Conversational 1003 — default OFF. The client flag only hides the UI; the
                gateway functions enforce CONVERSATIONAL_1003_ENABLED server-side regardless. */}
            {conversational1003Enabled() && (
              <>
                <Route path="application/assistant/:loanFileId" element={<RequireAuth><ApplicationAssistant /></RequireAuth>} />
                <Route path="portal/file/:loanFileId/application" element={<RequireAuth><ApplicationTeamReview /></RequireAuth>} />
                {/* The loan team taking the application over the phone. Same interview, same
                    engine; the server records it as team-entered and still refuses to let them
                    attest. Authorization is enforced there, not by this route existing. */}
                <Route path="portal/file/:loanFileId/application/take" element={<RequireAuth><ApplicationAssistant assist /></RequireAuth>} />
                {/* Short form of an application invite — texted, not clicked from an email.
                    Public by design: it only rewrites the URL, redemption still authorizes. */}
                <Route path="1003/:token" element={<ShortLink1003 />} />
                {/* Where 1003.ourmtg.com lands: resolve "my application" from who is signed in.
                    Not wrapped in RequireAuth — it sends people to sign in itself, so it can
                    come back here afterwards instead of dropping them on the portal. */}
                <Route path="application" element={<ApplicationEntry />} />
              </>
            )}
            {/* Autopilot Pre-Underwriting — default OFF. Findings are internal by definition
                (docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md); the functions enforce that server-side
                regardless of whether this route is mounted. */}
            {preUnderwritingEnabled() && (
              <Route path="portal/file/:loanFileId/pre-underwriting"
                element={<RequireAuth><PreUnderwritingPanel /></RequireAuth>} />
            )}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </LangProvider>
  )
}

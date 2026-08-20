import Splash from './Splash'
import Dashboard from './Dashboard'
import ErrorBoundary from './lib/ErrorBoundary'

export default function App() {
  const view = new URLSearchParams(window.location.search).get('view')
  return <ErrorBoundary>{view === 'splash' ? <Splash /> : <Dashboard />}</ErrorBoundary>
}

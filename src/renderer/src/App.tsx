import Splash from './Splash'
import Dashboard from './Dashboard'

export default function App() {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'splash' ? <Splash /> : <Dashboard />
}

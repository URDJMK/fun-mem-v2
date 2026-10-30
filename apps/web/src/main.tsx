import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './looks.css';
import './studio.css';

// the landing page in progress, behind ?landing=16; never in a build (src/directions/preview.ts)
if (import.meta.env.DEV) await import('./directions/preview');

createRoot(document.getElementById('root')!).render(<App />);

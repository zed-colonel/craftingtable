import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, currentTheme } from './lib/theme.js';
import './styles/tokens.css';
import './styles/global.css';

// Before the first paint, so a light-theme user never sees a dark flash.
applyTheme(currentTheme());

const root = document.getElementById('root');
if (root === null) {
  throw new Error('missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

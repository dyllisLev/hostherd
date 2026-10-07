import React from 'react';
import ReactDOM from 'react-dom/client';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { App } from './app';
import { useLocale } from './i18n';
import { applyTheme } from './lib/preferences';
import './styles.css';

/** Re-renders the whole tree when the language changes; strings are looked up at render time. */
function Root() {
  useLocale();
  return <App />;
}

applyTheme();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Root /></React.StrictMode>,
);

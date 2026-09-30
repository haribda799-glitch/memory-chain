import { HashRouter, Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import Gallery from './components/Gallery';
import CreateMemorial from './components/CreateMemorial';
import MemorialPage from './components/MemorialPage';
import MyMemorials from './components/MyMemorials';
import ErrorBoundary from './components/ErrorBoundary';

export default function App() {
  return (
    <HashRouter>
      <div className="bg-background text-on-surface font-body-md antialiased min-h-screen flex flex-col">
        <Header />
        <main className="flex-grow">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Gallery />} />
              <Route path="/create" element={<CreateMemorial />} />
              <Route path="/memorial/:id" element={<MemorialPage />} />
              <Route path="/my" element={<MyMemorials />} />
            </Routes>
          </ErrorBoundary>
        </main>
        {/* Footer */}
        <footer className="bg-surface-container-low border-t border-outline-variant/15 w-full py-12">
          <div className="flex flex-col md:flex-row justify-between items-center px-margin-mobile md:px-margin-desktop space-y-stack-md md:space-y-0 max-w-container-max mx-auto">
            <div className="font-headline-sm text-headline-sm text-primary flex flex-col items-center md:items-start">
              Memory Chain
              <span className="font-body-sm text-body-sm text-on-surface-variant mt-2 block">
                © 2024 Memory Chain. Preserving eternal bonds on-chain.
              </span>
            </div>
            <div className="flex flex-wrap justify-center md:justify-end gap-6 font-body-sm text-body-sm font-label-md text-label-md">
              <a href="#" className="text-on-tertiary-fixed-variant hover:text-primary transition-colors cursor-pointer">Privacy Policy</a>
              <a href="#" className="text-on-tertiary-fixed-variant hover:text-primary transition-colors cursor-pointer">Terms of Service</a>
              <a href="#" className="text-on-tertiary-fixed-variant hover:text-primary transition-colors cursor-pointer">Support</a>
              <a href="#" className="text-on-tertiary-fixed-variant hover:text-primary transition-colors cursor-pointer">FAQ</a>
            </div>
          </div>
        </footer>
      </div>
    </HashRouter>
  );
}

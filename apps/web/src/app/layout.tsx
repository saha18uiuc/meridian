import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Meridian',
  description: 'Whiteboard a process, review it, freeze it, and run it as a durable agent.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <header className="app-header">
            <span className="brand">Meridian</span>
            <nav>
              <Link href="/boards">Boards</Link>
              <Link href="/specs">Specifications</Link>
              <Link href="/agents">Agents</Link>
              <Link href="/executions">Executions</Link>
            </nav>
          </header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}

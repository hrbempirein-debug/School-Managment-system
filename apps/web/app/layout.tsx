import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'School Management SaaS',
  description: 'Multi-tenant school management platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 font-sans text-gray-900">{children}</body>
    </html>
  );
}
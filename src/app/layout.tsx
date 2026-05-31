import type { Metadata } from 'next';
import { Outfit, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import Header from '@/components/Header';
import Sidebar from '@/components/Sidebar';

const outfit = Outfit({
  variable: '--font-sans',
  subsets: ['latin'],
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'AutoQA - Transform Test Cases into Automated Test Execution',
  description: 'An intelligent rule-based end-to-end automated testing SaaS foundation.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrainsMono.variable} h-full antialiased dark`}>
      <body className="h-full flex bg-[#090d16] text-[#f9fafb] font-sans overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 xl:p-10 relative bg-[#090d16]">
            {/* Ambient decorative layout glow */}
            <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/5 blur-[100px] rounded-full pointer-events-none -z-10"></div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

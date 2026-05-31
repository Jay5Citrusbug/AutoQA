'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  Play, ClipboardList, History, Settings, CodeXml, ChevronRight, 
  LayoutDashboard, FileTerminal, ShieldAlert, LogOut, User, Cpu
} from 'lucide-react';

export default function Sidebar() {
  const pathname = usePathname();

  const menuItems = [
    { name: 'Run Test', path: '/run-test', icon: Play },
    { name: 'Executions', path: '/executions', icon: History },
    { name: 'Reports', path: '/reports', icon: ClipboardList },
    { name: 'Generated Scripts', path: '/generated-scripts', icon: FileTerminal },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];

  return (
    <aside className="w-72 border-r border-zinc-800 bg-zinc-950 flex flex-col justify-between py-6 shrink-0 select-none overflow-y-auto scrollbar-none">
      <div className="flex flex-col gap-8">
        
        {/* Top Logo */}
        <div className="px-6 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white shadow shadow-blue-500/20">
            <Cpu className="h-5.5 w-5.5 text-white" />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-black text-white tracking-wider">AutoQA</h1>
            <p className="text-[10px] sm:text-xs text-zinc-500 font-bold uppercase tracking-wider mt-0.5">Intelligent Testing</p>
          </div>
        </div>

        {/* Links Navigation */}
        <nav className="flex flex-col px-3 gap-2">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.path || (item.path !== '/' && pathname.startsWith(item.path));

            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-3 px-4 py-4 rounded-xl text-sm sm:text-base font-semibold tracking-wide transition-all ${
                  isActive
                    ? 'border-2 border-dashed border-blue-500/60 bg-blue-500/5 text-blue-400 font-bold'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-900/40 border border-transparent'
                }`}
              >
                <Icon className={`h-5 w-5 ${isActive ? 'text-blue-400' : 'text-zinc-500'}`} />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Bottom Profile and Logout Actions */}
      <div className="flex flex-col px-3 gap-1.5 border-t border-zinc-900 pt-5">
        <Link
          href="/profile"
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold text-zinc-400 hover:text-white hover:bg-zinc-900/40 transition-all"
        >
          <User className="h-5 w-5 text-zinc-500" />
          Profile
        </Link>
        <button
          type="button"
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold text-zinc-400 hover:text-rose-400 hover:bg-rose-500/5 transition-all text-left w-full cursor-pointer"
        >
          <LogOut className="h-5 w-5 text-zinc-500" />
          Logout
        </button>
      </div>

    </aside>
  );
}

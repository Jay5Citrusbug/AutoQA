'use client';

import React from 'react';
import { Search, Bell, HelpCircle } from 'lucide-react';

interface HeaderProps {
  placeholder?: string;
}

export default function Header({ placeholder = 'Search test cases...' }: HeaderProps) {
  return (
    <header className="bg-zinc-950/20 px-8 py-5 flex items-center justify-between border-b border-zinc-800/40">
      
      {/* Search Input Box */}
      <div className="relative w-full max-w-md">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-zinc-500">
          <Search className="h-4.5 w-4.5" />
        </div>
        <input
          type="text"
          placeholder={placeholder}
          className="w-full bg-zinc-900 border border-zinc-800/80 rounded-xl pl-11 pr-4 py-2.5 text-sm sm:text-base text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-all"
        />
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-5">
        <button className="text-zinc-400 hover:text-white transition-colors relative">
          <Bell className="h-5 w-5" />
          <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-purple-500"></span>
        </button>

        <button className="text-zinc-400 hover:text-white transition-colors">
          <HelpCircle className="h-5 w-5" />
        </button>

        <button className="px-4.5 py-2 rounded-xl border border-dashed border-blue-500 bg-blue-500/5 text-blue-400 hover:bg-blue-500/10 text-sm font-bold transition-all select-none cursor-pointer">
          Quick Run
        </button>

        <div className="h-8.5 w-8.5 rounded-full bg-zinc-800 border border-zinc-700 overflow-hidden flex items-center justify-center font-bold text-xs text-zinc-300">
          JS
        </div>
      </div>
    </header>
  );
}

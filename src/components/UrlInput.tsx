'use client';

import React from 'react';
import { Globe, RefreshCw } from 'lucide-react';

interface UrlInputProps {
  url: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}

export default function UrlInput({ url, onChange, disabled }: UrlInputProps) {
  const handleQuickFill = (val: string) => {
    if (disabled) return;
    onChange(val);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
          <Globe className="h-4 w-4 text-purple-400" />
          Target Application URL
        </label>
        <span className="text-[10px] text-zinc-500 font-mono">Supports HTTP/HTTPS</span>
      </div>

      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
          <Globe className="h-4.5 w-4.5" />
        </div>
        <input
          type="url"
          value={url}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="https://example.com/login"
          className="w-full pl-11 pr-4 py-3 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>

      {/* Quick fillers for test purposes */}
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <span className="text-[10px] text-zinc-500 font-medium">Quick Presets:</span>
        {[
          { label: 'Standard Web Login', url: 'https://the-internet.herokuapp.com/login' },
          { label: 'Secure Forms Sandbox', url: 'https://demo.playwright.dev/todomvc/' },
        ].map((p, idx) => (
          <button
            key={idx}
            type="button"
            disabled={disabled}
            onClick={() => handleQuickFill(p.url)}
            className="text-[10px] text-zinc-400 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-800/80 px-2.5 py-1 rounded-md transition-all disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

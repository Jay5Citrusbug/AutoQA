'use client';

import React from 'react';
import { Play, Loader2 } from 'lucide-react';

interface RunButtonProps {
  onClick: () => void;
  isLoading: boolean;
  disabled?: boolean;
}

export default function RunButton({ onClick, isLoading, disabled }: RunButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading || disabled}
      className={`w-full py-3.5 px-6 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer select-none transition-all duration-300 relative overflow-hidden ${
        isLoading
          ? 'bg-zinc-800 text-zinc-500 border border-zinc-700/50 cursor-not-allowed'
          : disabled
            ? 'bg-zinc-900 text-zinc-600 border border-zinc-900 cursor-not-allowed opacity-50'
            : 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:opacity-95 shadow-lg shadow-purple-500/10 hover:shadow-purple-500/20 active:scale-[0.99] border border-purple-500/20'
      }`}
    >
      {isLoading ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-purple-400" />
          <span>Executing Rule-Based Engines...</span>
        </>
      ) : (
        <>
          <Play className="h-4.5 w-4.5 fill-current" />
          <span>Run Test Case Suite</span>
        </>
      )}
    </button>
  );
}

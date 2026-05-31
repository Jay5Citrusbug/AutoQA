'use client';

import React from 'react';
import { FileText, ClipboardCopy, ListPlus } from 'lucide-react';

interface TestCaseEditorProps {
  stepsText: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}

export default function TestCaseEditor({ stepsText, onChange, disabled }: TestCaseEditorProps) {
  const presets = [
    {
      name: 'Login Form',
      steps: [
        'Navigate to "https://the-internet.herokuapp.com/login"',
        'Enter "tomsmith" into input "username"',
        'Enter "SuperSecretPassword!" into input "password"',
        'Click the login button',
        'Verify success message "You logged into a secure area!"',
      ].join('\n'),
    },
    {
      name: 'Generic Signup Preset',
      steps: [
        'Enter "john_doe" into input "Username"',
        'Enter "john@domain.com" into input "Email"',
        'Enter "securePass123" into input "Password"',
        'Check terms checkbox',
        'Click Register',
        'Verify success message "account successfully created"',
      ].join('\n'),
    },
  ];

  const handleApplyPreset = (steps: string) => {
    if (disabled) return;
    onChange(steps);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
          <FileText className="h-4 w-4 text-purple-400" />
          Natural Language Test Case Steps
        </label>
        <span className="text-[10px] text-zinc-500 font-mono">One step per line</span>
      </div>

      <div className="relative">
        <textarea
          value={stepsText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="Step 1: Navigate to 'https://example.com/login'&#10;Step 2: Enter 'admin@example.com' into username&#10;Step 3: Enter 'supersecret' into password&#10;Step 4: Click Login&#10;Step 5: Verify success message 'Welcome back'"
          className="w-full min-h-[220px] p-4 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-white placeholder-zinc-600 font-mono focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed resize-y"
        />
      </div>

      {/* Preset injection helpers */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-1 border-t border-zinc-900 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-zinc-500 font-medium">Load Preset:</span>
          {presets.map((p, idx) => (
            <button
              key={idx}
              type="button"
              disabled={disabled}
              onClick={() => handleApplyPreset(p.steps)}
              className="text-[10px] text-zinc-400 hover:text-white bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/60 px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <ListPlus className="h-3 w-3 text-purple-400" />
              {p.name}
            </button>
          ))}
        </div>

        <div className="text-[10px] text-zinc-500 leading-normal flex items-start gap-1">
          <span className="text-purple-400 font-semibold uppercase">Syntax Tip:</span>
          <span>Use double quotes for values/inputs (e.g. `Enter "my-value" in email`).</span>
        </div>
      </div>
    </div>
  );
}

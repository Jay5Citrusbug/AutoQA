'use client';

import React, { useState } from 'react';
import { Settings, Save, ShieldCheck, Cpu, HardDrive, ToggleLeft } from 'lucide-react';

export default function SettingsPage() {
  const [successMsg, setSuccessMsg] = useState('');

  // Config state
  const [execSettings, setExecSettings] = useState({
    screenshotCapture: 'on-failure',
    videoCapture: 'off',
    headlessMode: true,
    defaultTimeout: 30,
    reportFormat: 'both'
  });

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMsg('System configuration settings saved successfully.');
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  return (
    <div className="flex flex-col gap-8 w-full py-2 animate-fade-in">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white flex items-center gap-2.5">
          <Settings className="h-8 w-8 text-purple-400" />
          Execution Settings
        </h2>
        <p className="text-base sm:text-lg text-zinc-400 mt-2">Configure core engine parameters, browser session properties, and report outputs.</p>
      </div>

      {successMsg && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4.5 rounded-xl text-sm sm:text-base font-bold">
          {successMsg}
        </div>
      )}

      <form onSubmit={handleSaveSettings} className="flex flex-col gap-6">
        {/* Card 1: Browser settings */}
        <div className="border border-zinc-800 bg-zinc-900/10 backdrop-blur-md rounded-2xl p-6 flex flex-col gap-5">
          <h3 className="text-sm sm:text-base font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2 border-b border-zinc-900 pb-3">
            <Cpu className="h-5.5 w-5.5 text-purple-400" />
            Execution Parameters
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm sm:text-base font-bold text-zinc-400">
            {/* Screenshots */}
            <div className="flex flex-col gap-2.5">
              <label className="font-bold text-zinc-400">Screenshot Capture Mode</label>
              <select 
                value={execSettings.screenshotCapture}
                onChange={e => setExecSettings(prev => ({ ...prev, screenshotCapture: e.target.value }))}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-purple-500 font-semibold"
              >
                <option value="all">Capture all steps (Default)</option>
                <option value="on-failure">Capture only on failures</option>
                <option value="off">Off (Disable completely)</option>
              </select>
            </div>

            {/* Videos */}
            <div className="flex flex-col gap-2.5">
              <label className="font-bold text-zinc-400">Video Capture Mode</label>
              <select 
                value={execSettings.videoCapture}
                onChange={e => setExecSettings(prev => ({ ...prev, videoCapture: e.target.value }))}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-purple-500 font-semibold"
              >
                <option value="off">Off (Disable completely)</option>
                <option value="on-first-retry">Only on execution retries</option>
                <option value="retain-on-failure">Retain only on failures</option>
                <option value="on">Record every run (Slower execution)</option>
              </select>
            </div>

            {/* Headless Mode */}
            <div className="flex flex-col gap-2.5">
              <label className="font-bold text-zinc-400">Headless Browser Session</label>
              <select 
                value={execSettings.headlessMode ? 'true' : 'false'}
                onChange={e => setExecSettings(prev => ({ ...prev, headlessMode: e.target.value === 'true' }))}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-purple-500 font-semibold"
              >
                <option value="true">Headless (Invisibly behind background)</option>
                <option value="false">Headed (Launches visual Chromium instance)</option>
              </select>
            </div>

            {/* Timeout */}
            <div className="flex flex-col gap-2.5">
              <label className="font-bold text-zinc-400">Default Assertion Timeout (Seconds)</label>
              <input 
                type="number"
                value={execSettings.defaultTimeout}
                onChange={e => setExecSettings(prev => ({ ...prev, defaultTimeout: parseInt(e.target.value) }))}
                min={5}
                max={120}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-purple-500 font-semibold"
              />
            </div>
          </div>
        </div>

        {/* Card 2: Report configurations */}
        <div className="border border-zinc-800 bg-zinc-900/10 backdrop-blur-md rounded-2xl p-6 flex flex-col gap-5">
          <h3 className="text-sm sm:text-base font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2 border-b border-zinc-900 pb-3">
            <HardDrive className="h-5.5 w-5.5 text-indigo-400" />
            Report Settings
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm sm:text-base font-bold text-zinc-400">
            <div className="flex flex-col gap-2.5">
              <label className="font-bold text-zinc-400">Output Report Formats</label>
              <select 
                value={execSettings.reportFormat}
                onChange={e => setExecSettings(prev => ({ ...prev, reportFormat: e.target.value }))}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-purple-500 font-semibold"
              >
                <option value="both">JSON Summary & Dynamic HTML Dashboard</option>
                <option value="json">JSON Summary logs only</option>
                <option value="html">Dynamic HTML Dashboard page only</option>
              </select>
            </div>

            <div className="flex flex-col gap-2.5">
              <label className="font-bold text-zinc-400">Telemetry Retention Logs</label>
              <select className="bg-zinc-950 border border-zinc-800 rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-purple-500 font-semibold">
                <option>Retain forever (No auto-delete)</option>
                <option>Delete logs older than 7 days</option>
                <option>Delete logs older than 30 days</option>
              </select>
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex items-center gap-4 self-end mt-2">
          <button
            type="submit"
            className="flex items-center gap-2 px-8 py-4 rounded-xl font-bold bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/10 transition-all select-none cursor-pointer text-base sm:text-lg"
          >
            <Save className="h-5 w-5" />
            Save Configuration
          </button>
        </div>
      </form>
    </div>
  );
}

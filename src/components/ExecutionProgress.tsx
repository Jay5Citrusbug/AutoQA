'use client';

import React from 'react';
import { Loader2, CheckCircle2, XCircle, AlertCircle, Compass, Clock } from 'lucide-react';
import { ParsedStep } from '@/types/testCase';
import { StepExecutionResult } from '@/types/execution';

interface ExecutionProgressProps {
  steps: ParsedStep[];
  currentStepIndex: number;
  results: StepExecutionResult[];
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export default function ExecutionProgress({ steps, currentStepIndex, results, status }: ExecutionProgressProps) {
  if (status === 'pending') return null;

  return (
    <div className="border border-border/60 bg-zinc-900/10 backdrop-blur-md rounded-2xl p-6 flex flex-col gap-6">
      <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
        <h3 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
          <Loader2 className={`h-4.5 w-4.5 text-purple-400 ${status === 'running' ? 'animate-spin' : ''}`} />
          Automated Execution Log
        </h3>
        <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono font-bold">
          {status === 'running' ? 'Active Run' : 'Finished'}
        </span>
      </div>

      <div className="flex flex-col gap-3.5">
        {steps.map((step, idx) => {
          const stepNum = idx + 1;
          const result = results.find((r) => r.stepIndex === stepNum);
          
          let state: 'idle' | 'running' | 'passed' | 'failed' = 'idle';
          if (status === 'running' && currentStepIndex === stepNum) {
            state = 'running';
          } else if (result) {
            state = result.status as 'passed' | 'failed' | 'idle';
          }

          const stateStyle = {
            idle: {
              badge: 'bg-zinc-800 text-zinc-400 border border-zinc-700/50',
              text: 'text-zinc-500',
              icon: null
            },
            running: {
              badge: 'bg-purple-500/15 text-purple-400 border border-purple-500/30 animate-pulse',
              text: 'text-zinc-200 font-medium',
              icon: <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
            },
            passed: {
              badge: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25',
              text: 'text-zinc-300',
              icon: <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            },
            failed: {
              badge: 'bg-rose-500/10 text-rose-400 border border-rose-500/25',
              text: 'text-rose-400',
              icon: <XCircle className="h-4 w-4 text-rose-400 shrink-0" />
            }
          }[state];

          return (
            <div key={idx} className="flex flex-col gap-2 border-l border-zinc-900 pl-4 py-0.5 relative">
              {/* Dynamic state connector node */}
              <span className={`absolute left-[-4.5px] top-[8px] h-2 w-2 rounded-full border ${
                state === 'running' 
                  ? 'bg-purple-500 border-purple-400 animate-ping' 
                  : state === 'passed' 
                    ? 'bg-emerald-500 border-emerald-400' 
                    : state === 'failed' 
                      ? 'bg-rose-500 border-rose-400' 
                      : 'bg-zinc-800 border-zinc-700'
              }`}></span>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${stateStyle.badge}`}>
                    Step {stepNum}
                  </span>
                  <p className={`text-sm ${stateStyle.text}`}>{step.rawText}</p>
                </div>
                
                <div className="flex items-center gap-2">
                  {result && (
                    <span className="text-[10px] text-zinc-500 font-mono flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {result.durationMs}ms
                    </span>
                  )}
                  {stateStyle.icon}
                </div>
              </div>

              {/* Display dynamic selector metadata if step is resolved */}
              {result?.resolvedSelector && (
                <div className="ml-16 flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono bg-zinc-950 px-2 py-1 rounded border border-zinc-900 self-start">
                  <Compass className="h-3 w-3 text-zinc-600" />
                  <span>Selector: {result.resolvedSelector}</span>
                </div>
              )}

              {/* Display specific step failure message if step failed */}
              {result?.error && (
                <div className="ml-16 text-[10px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded-lg max-w-lg mt-1">
                  <span className="font-bold">Error:</span> {result.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

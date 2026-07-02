#!/usr/bin/env node

process.env.COPILOT_DEBUGGER_OPEN = process.env.COPILOT_DEBUGGER_OPEN ?? '1';

await import('./index.js');
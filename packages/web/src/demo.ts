import { useEffect, useState } from 'react';
import { api } from './api.ts';

export interface DemoInfo {
  enabled: boolean;
  agent_mode: 'llm' | 'rules';
  scenarios: { id: string; label: string; expect: string }[];
  limits: { invoices_per_hour: number };
}

// GET /api/demo only exists when the server runs with DEMO_MODE=true; anything else means no demo.
let cached: Promise<DemoInfo | null> | null = null;
const loadDemo = () => (cached ??= api<DemoInfo>('/demo', { token: '' }).catch(() => null));

export function useDemo(): DemoInfo | null {
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  useEffect(() => {
    void loadDemo().then(setDemo);
  }, []);
  return demo;
}

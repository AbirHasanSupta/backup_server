import { ReelItem } from './reelEngine';

export type CustomReelsSession = {
  reels: ReelItem[];
  title?: string;
  sourceMode?: 'phone' | 'shared';
  selectedSourceId?: string | null;
  timestamp: number;
};

let currentSession: CustomReelsSession | null = null;
let listeners: ((session: CustomReelsSession | null) => void)[] = [];

export function setCustomReelsSession(session: CustomReelsSession | null) {
  currentSession = session;
  listeners.forEach(cb => {
    try {
      cb(session);
    } catch {}
  });
}

export function getCustomReelsSession(): CustomReelsSession | null {
  return currentSession;
}

export function clearCustomReelsSession() {
  currentSession = null;
  listeners.forEach(cb => {
    try {
      cb(null);
    } catch {}
  });
}

export function subscribeCustomReelsSession(cb: (session: CustomReelsSession | null) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter(l => l !== cb);
  };
}

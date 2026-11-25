'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { participantIdentity, participantLoader } from './task-participants-client.mjs';
const empty = { status: 'idle', rows: [], total: 0, readBlock: null };
export function useTaskParticipants(identityInput) {
  const identity = participantIdentity(identityInput);
  const current = useRef(identity.key), mounted = useRef(false);
  const [state, setState] = useState({ ...empty, key: identity.key });
  current.current = identity.key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(() => {
    if (!identity.count) return;
    const key = identity.key;
    setState(previous => previous.key === key && previous.status === 'ready' ? previous : { ...empty, key, status: 'loading' });
    participantLoader.load(identity).then(data => {
      if (mounted.current && current.current === key) setState({ ...data, key, status: 'ready' });
    }).catch(() => {
      if (mounted.current && current.current === key) setState({ ...empty, key, status: 'error' });
    });
  }, [identity.key]);
  return { ...(state.key === identity.key ? state : { ...empty, key: identity.key }), load };
}

'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor } from '@/lib/navigation';
import { useSession } from '@/stores/session';

/** Entry: send signed-in people to their home, everyone else to sign in. */
export default function Index() {
  const router = useRouter();
  const { status, me, load } = useSession();
  useEffect(() => {
    if (status === 'loading') void load();
    else if (status === 'anonymous' || status === 'error') router.replace('/login');
    else if (me) router.replace(homeFor(me));
  }, [status, me, load, router]);
  return null;
}

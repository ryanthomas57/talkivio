import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Component stories (ch. 05) are developer documentation: English only and not served in production
 * unless ENABLE_DESIGN_SYSTEM=1 (e.g. a design review build).
 */
export default function DesignSystemLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DESIGN_SYSTEM !== '1') notFound();
  return children;
}

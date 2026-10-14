import { BrandMark, BrandWordmark } from '@/components/brand';
import { cn } from '@/lib/cn';

/** The Talkivio logo (the ribbon mark and the wordmark, as in the product); the wordmark takes the text colour. */
export function SiteLogo({ small, className }: { small?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 text-[var(--site-paper)]', className)}>
      <BrandMark className={small ? 'h-6' : 'h-7'} />
      <BrandWordmark className={small ? 'h-[14px]' : 'h-[16px]'} />
    </span>
  );
}

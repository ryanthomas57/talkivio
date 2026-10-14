import { CheckCircle2, Circle, Clock, MessageSquare } from 'lucide-react';
import { useT, type MessageKey } from '@/i18n';
import { cn } from '@/lib/cn';

const META: Record<string, { label: MessageKey; cls: string; Icon: typeof Circle }> = {
  queued: { label: 'visitors.chatStatus.queued', cls: 'text-warning', Icon: Clock },
  offered: { label: 'visitors.chatStatus.offered', cls: 'text-warning', Icon: Clock },
  active: { label: 'visitors.chatStatus.active', cls: 'text-success', Icon: MessageSquare },
  closed: { label: 'visitors.chatStatus.closed', cls: 'text-fg-2', Icon: CheckCircle2 },
};

/** Chat status with icon + text + colour (never colour alone). */
export function ChatStatusLabel({ status, className }: { status: string; className?: string }) {
  const t = useT();
  const known = META[status];
  const m = known
    ? { label: t(known.label), cls: known.cls, Icon: known.Icon }
    : { label: status, cls: 'text-fg-2', Icon: Circle };
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', m.cls, className)}>
      <m.Icon className="size-3.5" aria-hidden />
      {m.label}
    </span>
  );
}

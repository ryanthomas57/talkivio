'use client';
/** Dropdown menu (Radix): arrows, Home/End, typeahead and Escape work (ch. 05). */
import * as M from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuGroup = M.Group;
export const MenuRadioGroup = M.RadioGroup;

export const MenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof M.Content>>(
  function MenuContent({ className, sideOffset = 6, align = 'end', ...rest }, ref) {
    return (
      <M.Portal>
        <M.Content
          ref={ref}
          sideOffset={sideOffset}
          align={align}
          collisionPadding={8}
          {...rest}
          className={cn(
            'z-50 min-w-[200px] rounded-[var(--radius-control)] border border-line bg-surface p-2 shadow-[var(--shadow-float)] data-[state=open]:animate-fade-in',
            className,
          )}
        />
      </M.Portal>
    );
  },
);

const itemClass =
  'relative flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-sm text-fg outline-none data-[highlighted]:bg-surface-3 data-[disabled]:cursor-not-allowed data-[disabled]:text-fg-3';

export const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof M.Item> & { danger?: boolean; icon?: ReactNode }
>(function MenuItem({ className, danger, icon, children, asChild, ...rest }, ref) {
  const iconNode = icon && (
    <span className="flex size-4 items-center justify-center text-fg-2 [&_svg]:size-4">{icon}</span>
  );
  // With asChild the item merges onto its one child element (a link), so the icon goes inside that element:
  // a second sibling makes Radix throw and takes the whole page down.
  const content =
    asChild && isValidElement<{ children?: ReactNode }>(children) ? (
      cloneElement(children, undefined, iconNode, children.props.children)
    ) : (
      <>
        {iconNode}
        {children}
      </>
    );
  return (
    <M.Item
      ref={ref}
      asChild={asChild}
      {...rest}
      className={cn(itemClass, danger && 'text-danger data-[highlighted]:bg-danger-tint', className)}
    >
      {content}
    </M.Item>
  );
});

export const MenuRadioItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof M.RadioItem>>(
  function MenuRadioItem({ className, children, ...rest }, ref) {
    return (
      <M.RadioItem ref={ref} {...rest} className={cn(itemClass, 'pe-8', className)}>
        {children}
        <M.ItemIndicator className="absolute end-2.5">
          <Check className="size-4 text-primary" />
        </M.ItemIndicator>
      </M.RadioItem>
    );
  },
);

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-2">{children}</M.Label>;
}

export function MenuSeparator() {
  return <M.Separator className="-mx-2 my-2 h-px bg-line-subtle" />;
}

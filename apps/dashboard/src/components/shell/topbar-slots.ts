'use client';
import { createContext, useContext } from 'react';

/**
 * Where a page's title and actions render: the white top bar of the app shell. `undefined` outside the shell
 * (sign-in, onboarding, the standalone design system), where <PageHeader> stays in the page.
 */
export const TopbarSlots = createContext<
  | {
      title: HTMLElement | null;
      actions: HTMLElement | null;
      /** A page header announces itself so the shell stops showing the section name in its place. */
      claim: () => () => void;
    }
  | undefined
>(undefined);

export const useTopbarSlots = () => useContext(TopbarSlots);

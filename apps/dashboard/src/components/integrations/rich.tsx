import { Fragment, type ReactNode } from 'react';
import type { MessageKey, Translate } from '@/i18n';

type Values = Parameters<Translate>[1];
const MARK = '\u0000';

/**
 * A translated sentence with React nodes (inline code, times) in place of some of its {placeholders},
 * so the sentence stays whole in the catalog while protocol codes keep their <code> styling.
 */
export function richT(t: Translate, key: MessageKey, nodes: Record<string, ReactNode>, values?: Values): ReactNode {
  const marked: NonNullable<Values> = { ...values };
  for (const name of Object.keys(nodes)) marked[name] = `${MARK}${name}${MARK}`;
  return t(key, marked)
    .split(MARK)
    .map((part, i) => (i % 2 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}

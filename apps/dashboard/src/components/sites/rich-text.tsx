'use client';
/**
 * Translated sentences that keep inline markup (<code>, links): each `{slotN}` variable in the
 * message is replaced by the matching React node, so word order stays in the catalog.
 *
 *   richT(t('sites.install.snippetHint', slots(1)), [<code>&lt;/body&gt;</code>])
 */
import { Fragment, type ReactNode } from 'react';

const MARK = '⁣';

/** Values for `slot0…slotN-1` that richT() later swaps for nodes. */
export function slots(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`slot${i}`, `${MARK}${i}${MARK}`]));
}

export function richT(text: string, nodes: ReactNode[]): ReactNode {
  return text.split(MARK).map((part, i) => <Fragment key={i}>{i % 2 === 1 ? nodes[Number(part)] : part}</Fragment>);
}

import { describe, expect, it } from 'vitest';
import { containsCreditCard, luhn, maskCreditCards } from './text';

describe('maskCreditCards', () => {
  it('masks Luhn-valid card numbers, keeping the first 6 and last 4 digits', () => {
    expect(maskCreditCards('my card 4242424242424242 thanks')).toBe('my card 424242******4242 thanks');
    expect(maskCreditCards('4111 1111 1111 1111')).toBe('411111******1111');
    expect(maskCreditCards('5555-5555-5555-4444, expiry 12/30')).toBe('555555******4444, expiry 12/30');
  });

  it('keeps the text around the number intact (the separator after it is not part of the match)', () => {
    expect(maskCreditCards('Hello, 4242424242424242 here')).toBe('Hello, 424242******4242 here');
    expect(maskCreditCards('a 4242424242424242 - b')).toBe('a 424242******4242 - b');
    expect(maskCreditCards('4242424242424242\nnext line')).toBe('424242******4242\nnext line');
  });

  it('leaves other numbers and URLs alone', () => {
    expect(maskCreditCards('order 4242424242424241 (fails Luhn)')).toBe('order 4242424242424241 (fails Luhn)');
    expect(maskCreditCards('phone +1 415 555 0100, ref 123456')).toBe('phone +1 415 555 0100, ref 123456');
    expect(maskCreditCards('see https://shop.example/4242424242424242 now')).toBe('see https://shop.example/4242424242424242 now');
    expect(containsCreditCard('no digits here')).toBe(false);
  });

  it('luhn', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242424242424241')).toBe(false);
  });
});

/**
 * Feature module registration for "billing". Add this feature's injectable
 * providers and REST controllers to the arrays below; src/features/registry.ts
 * wires them into the API, gateway and worker processes.
 */
import type { Provider, Type } from '@nestjs/common';

export const BILLING_PROVIDERS: Provider[] = [];
export const BILLING_CONTROLLERS: Type<unknown>[] = [];
